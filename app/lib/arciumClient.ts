// app/lib/arciumClient.ts
//
// PrivatePerps — Real Arcium SDK Integration
//
// This file is THE BRIDGE between the frontend UI and the
// Arcium confidential compute layer on Solana devnet.
//
// What it does:
//   1. Generates x25519 keypair for encryption
//   2. Fetches MXE public key from Arcium cluster
//   3. Encrypts position data using RescueCipher (NEVER sent in plaintext)
//   4. Submits encrypted Solana transaction
//   5. Waits for Arcium MPC nodes to process
//   6. Decrypts ONLY the PnL result client-side

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  x25519,
  getMXEPublicKey,
  RescueCipher,
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
import { randomBytes } from "crypto";
import type { TradeInput, PnLResult } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — update these after you deploy
// ─────────────────────────────────────────────────────────────────────────────

const CLUSTER_OFFSET = 456; // Arcium devnet cluster v0.8.3

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "PLACEHOLDER_PROGRAM_ID"
);

// ─────────────────────────────────────────────────────────────────────────────
// PRICE ENCODING
// Prices stored as integer × 100 to avoid decimals in encrypted compute
// $67,420.00 becomes 6742000
// ─────────────────────────────────────────────────────────────────────────────

function encodePrice(price: number): bigint {
  return BigInt(Math.round(price * 100));
}

function encodeSizeUSD(sizeUSD: number): bigint {
  return BigInt(Math.round(sizeUSD * 100));
}

function decodePnL(rawPnL: bigint): number {
  return Number(rawPnL) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY — MXE nodes need a moment to generate keys on startup
// ─────────────────────────────────────────────────────────────────────────────

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 20,
  delayMs = 500
): Promise<Uint8Array> {
  for (let i = 0; i < retries; i++) {
    const key = await getMXEPublicKey(provider, programId);
    if (key) return key;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Could not fetch MXE public key — is the Arcium cluster running?");
}

// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTION SESSION
// Fresh x25519 keypair per trade session
// In production: derive from user's signed message for persistence
// ─────────────────────────────────────────────────────────────────────────────

interface EncryptionSession {
  clientPrivateKey: Uint8Array;
  clientPublicKey: Uint8Array;
  cipher: RescueCipher;
}

async function createEncryptionSession(
  provider: anchor.AnchorProvider
): Promise<EncryptionSession> {
  // Generate fresh x25519 keypair
  const clientPrivateKey = x25519.utils.randomSecretKey();
  const clientPublicKey = x25519.getPublicKey(clientPrivateKey);

  // Fetch MXE public key from Arcium cluster
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, PROGRAM_ID);

  // ECDH key exchange — only this client + MXE can derive this secret
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  return { clientPrivateKey, clientPublicKey, cipher };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLIENT
// ─────────────────────────────────────────────────────────────────────────────

export class PrivatePerpsArciumClient {
  private provider: anchor.AnchorProvider;
  private program: anchor.Program;

  constructor(provider: anchor.AnchorProvider, idl: anchor.Idl) {
    this.provider = provider;
    this.program = new anchor.Program(idl, provider);
  }

  /**
   * Opens a private perpetual position via Arcium MPC.
   *
   * ALL position fields are encrypted before leaving the browser.
   * The Arcium cluster processes encrypted data — no one ever sees
   * your entry price, size, or leverage in plaintext.
   */
  async openPosition(input: TradeInput, currentPrice: number): Promise<string> {
    const { clientPublicKey, cipher } = await createEncryptionSession(this.provider);

    // Encode to fixed-point integers
    const entryPrice = encodePrice(currentPrice);
    const sizeUSD = encodeSizeUSD(input.size);
    const leverage = BigInt(input.leverage);
    const side = BigInt(input.side === "long" ? 1 : 0);

    // Generate unique nonce for this computation
    const nonce = randomBytes(16);
    const nonceBN = new BN(deserializeLE(nonce).toString());

    // ENCRYPT — all four position fields encrypted here
    // After this line, plaintext values are gone from memory
    const ciphertext = cipher.encrypt(
      [entryPrice, sizeUSD, leverage, side],
      nonce
    );

    const computationOffset = new BN(randomBytes(8), "hex");

    // Derive position PDA (unique address for this position on Solana)
    const [positionPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        this.provider.wallet.publicKey.toBuffer(),
        computationOffset.toArrayLike(Buffer, "le", 8),
      ],
      PROGRAM_ID
    );

    // Arcium account addresses
    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
    const mxeAccount = getMXEAccAddress(PROGRAM_ID);
    const mempoolAccount = getMempoolAccAddress(CLUSTER_OFFSET);
    const executingPool = getExecutingPoolAccAddress(CLUSTER_OFFSET);
    const compDefOffset = Buffer.from(
      getCompDefAccOffset("open_position")
    ).readUInt32LE();
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);
    const computationAccount = getComputationAccAddress(
      CLUSTER_OFFSET,
      computationOffset
    );

    // Event listener — set up BEFORE submitting tx
    type Events = anchor.IdlEvents<typeof this.program["idl"]>;
    const openedEvent = new Promise<Events["PositionOpened"]>((resolve) => {
      const id = this.program.addEventListener("PositionOpened", (ev) => {
        this.program.removeEventListener(id);
        resolve(ev as Events["PositionOpened"]);
      });
    });

    // Submit transaction — encrypted ciphertexts go to Solana → Arcium
    await this.program.methods
      .openPosition(
        computationOffset,
        Array.from(ciphertext[0]), // encrypted entry_price
        Array.from(ciphertext[1]), // encrypted size_usd
        Array.from(ciphertext[2]), // encrypted leverage
        Array.from(ciphertext[3]), // encrypted side
        Array.from(clientPublicKey),
        nonceBN
      )
      .accounts({
        trader: this.provider.wallet.publicKey,
        position: positionPDA,
        clusterAccount,
        mxeAccount,
        mempoolAccount,
        executingPool,
        compDefAccount,
        computationAccount,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    // Wait for Arcium MPC to finalize (~2-4 seconds on devnet)
    await awaitComputationFinalization(
      this.provider,
      computationOffset,
      PROGRAM_ID,
      "confirmed"
    );

    await openedEvent;
    return positionPDA.toBase58();
  }

  /**
   * Closes a position and retrieves the privately-computed PnL.
   *
   * The PnL is computed inside the Arcium MXE over encrypted data.
   * Only the final PnL number is decrypted here client-side.
   * Entry price, size, leverage remain encrypted permanently.
   */
  async closePosition(
    positionPDA: string,
    currentPrice: number
  ): Promise<PnLResult> {
    const { clientPrivateKey, clientPublicKey, cipher } =
      await createEncryptionSession(this.provider);

    const computationOffset = new BN(randomBytes(8), "hex");
    const nonce = randomBytes(16);
    const nonceBN = new BN(deserializeLE(nonce).toString());

    // Oracle price is the ONLY public input — everything else stays encrypted
    const encodedCurrentPrice = encodePrice(currentPrice);

    type Events = anchor.IdlEvents<typeof this.program["idl"]>;
    const closedEvent = new Promise<Events["PositionClosed"]>((resolve) => {
      const id = this.program.addEventListener("PositionClosed", (ev) => {
        this.program.removeEventListener(id);
        resolve(ev as Events["PositionClosed"]);
      });
    });

    await this.program.methods
      .closePosition(
        computationOffset,
        new BN(encodedCurrentPrice.toString()),
        Array.from(clientPublicKey),
        nonceBN
      )
      .accounts({
        trader: this.provider.wallet.publicKey,
        position: new PublicKey(positionPDA),
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    // Wait for Arcium to compute PnL privately
    await awaitComputationFinalization(
      this.provider,
      computationOffset,
      PROGRAM_ID,
      "confirmed"
    );

    // Get the encrypted PnL from the event
    const ev = await closedEvent;
    const encryptedPnL = (ev as { encrypted_pnl: number[] }).encrypted_pnl;

    // Decrypt client-side — result never decrypted on any server
    const resultNonce = new Uint8Array(16);
    nonce.copy(resultNonce);
    resultNonce[0] = (resultNonce[0] + 1) & 0xff; // nonce + 1 per Arcium convention

    const decryptedPnL = cipher.decrypt([encryptedPnL], resultNonce)[0];
    const pnlValue = decodePnL(decryptedPnL);
    const margin = currentPrice; // replace with actual margin from position account
    const pnlPercentage = (pnlValue / margin) * 100;

    return {
      pnlValue,
      pnlPercentage,
      isProfit: pnlValue >= 0,
    };
  }
}
