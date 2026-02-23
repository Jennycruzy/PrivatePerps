// src/utils/arciumClient.ts
// Real Arcium SDK integration for PrivatePerps
// Uses @arcium-hq/client for X25519 ECDH encryption + MPC computation

import * as anchor from "@coral-xyz/anchor";
import {
  x25519,
  getMXEPublicKey,
  RescueCipher,
  getArciumEnv,
  getClusterAccAddress,
  getComputationAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
  deserializeLE,
} from "@arcium-hq/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv"
);

export const CLUSTER_OFFSET = parseInt(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET || "456"
);

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Retry getMXEPublicKey until nodes are online
export async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 20,
  delayMs = 500
): Promise<Uint8Array> {
  for (let i = 0; i < retries; i++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Could not fetch MXE public key after retries");
}

export interface PositionInputs {
  entryPrice: bigint;   // price × 100 fixed point
  sizeUsd: bigint;      // size in USD cents
  leverage: bigint;     // leverage multiplier
  side: bigint;         // 1 = long, 0 = short
}

export interface ArciumEncryptedPosition {
  ciphertext: number[][];
  nonce: Uint8Array;
  nonceBN: anchor.BN;
  computationOffset: anchor.BN;
  clientPublicKey: Uint8Array;
  cipher: RescueCipher;
  clientPrivateKey: Uint8Array;
}

// Step 1: Encrypt position data using X25519 ECDH + RescueCipher
// This is the core Arcium SDK encryption call
export async function encryptPosition(
  provider: anchor.AnchorProvider,
  position: PositionInputs
): Promise<ArciumEncryptedPosition> {
  // Generate client keypair for ECDH
  const clientPrivateKey = x25519.utils.randomSecretKey();
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

  // Fetch MXE public key from devnet
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, PROGRAM_ID);

  // Derive shared secret
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  // Encrypt all 4 position fields
  const inputs = [
    position.entryPrice,
    position.sizeUsd,
    position.leverage,
    position.side,
  ];

  const nonce = randomBytes(16);
  const ciphertext = cipher.encrypt(inputs, nonce);

  // Unique offset to track this computation on-chain
  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

  return {
    ciphertext,
    nonce,
    nonceBN,
    computationOffset,
    clientPublicKey,
    cipher,
    clientPrivateKey,
  };
}

// Step 2: Submit open_position computation to Arcium MPC
export async function submitOpenPosition(
  program: anchor.Program<any>,
  provider: anchor.AnchorProvider,
  encrypted: ArciumEncryptedPosition,
  traderPubkey: PublicKey
): Promise<string> {
  const arciumEnv = { arciumClusterOffset: CLUSTER_OFFSET };
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  const compDefIndex = Buffer.from(
    getCompDefAccOffset("open_position")
  ).readUInt32LE();

  const [positionPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), traderPubkey.toBuffer()],
    PROGRAM_ID
  );

  const signature = await program.methods
    .openPosition(
      encrypted.computationOffset,
      Array.from(encrypted.ciphertext[0]), // entry_price encrypted
      Array.from(encrypted.ciphertext[1]), // size_usd encrypted
      Array.from(encrypted.ciphertext[2]), // leverage encrypted
      Array.from(encrypted.ciphertext[3]), // side encrypted
      Array.from(encrypted.clientPublicKey),
      encrypted.nonceBN
    )
    .accountsPartial({
      trader: traderPubkey,
      positionAccount: positionPDA,
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        encrypted.computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefIndex),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  return signature;
}

// Step 3: Wait for MPC computation to finalize
export async function waitForComputation(
  provider: anchor.AnchorProvider,
  computationOffset: anchor.BN
): Promise<string> {
  return await awaitComputationFinalization(
    provider,
    computationOffset,
    PROGRAM_ID,
    "confirmed"
  );
}

// Step 4: Submit check_liquidation computation
export async function submitCheckLiquidation(
  program: anchor.Program<any>,
  provider: anchor.AnchorProvider,
  encryptedPosition: ArciumEncryptedPosition,
  currentPrice: number,
  traderPubkey: PublicKey
): Promise<string> {
  const arciumEnv = { arciumClusterOffset: CLUSTER_OFFSET };
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const computationOffset = new anchor.BN(randomBytes(8), "hex");

  const compDefIndex = Buffer.from(
    getCompDefAccOffset("check_liquidation")
  ).readUInt32LE();

  const [positionPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), traderPubkey.toBuffer()],
    PROGRAM_ID
  );

  // current_price is public (from oracle), not encrypted
  const currentPriceBN = new anchor.BN(Math.floor(currentPrice * 100));

  const signature = await program.methods
    .checkLiquidation(
      computationOffset,
      currentPriceBN,
      Array.from(encryptedPosition.clientPublicKey),
      encryptedPosition.nonceBN
    )
    .accountsPartial({
      trader: traderPubkey,
      positionAccount: positionPDA,
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefIndex),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  return signature;
}

// Step 5: Submit compute_pnl and decrypt result
export async function submitComputePnL(
  program: anchor.Program<any>,
  provider: anchor.AnchorProvider,
  encryptedPosition: ArciumEncryptedPosition,
  currentPrice: number,
  traderPubkey: PublicKey
): Promise<{ signature: string; pnl: bigint | null }> {
  const arciumEnv = { arciumClusterOffset: CLUSTER_OFFSET };
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const computationOffset = new anchor.BN(randomBytes(8), "hex");

  const compDefIndex = Buffer.from(
    getCompDefAccOffset("compute_pnl")
  ).readUInt32LE();

  const [positionPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), traderPubkey.toBuffer()],
    PROGRAM_ID
  );

  const currentPriceBN = new anchor.BN(Math.floor(currentPrice * 100));

  // Listen for PnL result event BEFORE submitting
  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event: any) => {
        res(event);
      });
    });
    await program.removeEventListener(listenerId!);
    return event;
  };

  const resultEventPromise = awaitEvent("PnLComputedEvent" as any);

  const signature = await program.methods
    .computePnl(
      computationOffset,
      currentPriceBN,
      Array.from(encryptedPosition.clientPublicKey),
      encryptedPosition.nonceBN
    )
    .accountsPartial({
      trader: traderPubkey,
      positionAccount: positionPDA,
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefIndex),
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });

  // Wait for MPC to finalize
  await awaitComputationFinalization(
    provider,
    computationOffset,
    PROGRAM_ID,
    "confirmed"
  );

  // Decrypt the result
  try {
    const resultEvent = await Promise.race([
      resultEventPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30000)),
    ]);

    if (resultEvent && (resultEvent as any).encryptedResult) {
      const resultNonce = Uint8Array.from((resultEvent as any).nonce);
      const decryptedPnl = encryptedPosition.cipher.decrypt(
        [(resultEvent as any).encryptedResult],
        resultNonce
      )[0];
      return { signature, pnl: decryptedPnl };
    }
  } catch (e) {
    console.error("Decryption error:", e);
  }

  return { signature, pnl: null };
}
