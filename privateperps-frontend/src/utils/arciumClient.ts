import * as anchor from "@coral-xyz/anchor";
import { x25519, RescueCipher } from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv"
);

// MXE X25519 public key from `arcium mxe-keys` output
// bc5b7baccb2e1db59becb5964e6fe3c7e9807f4e600a061f456ffb02d2beb370
const MXE_X25519_PUBKEY = new Uint8Array([
  0xbc, 0x5b, 0x7b, 0xac, 0xcb, 0x2e, 0x1d, 0xb5,
  0x9b, 0xec, 0xb5, 0x96, 0x4e, 0x6f, 0xe3, 0xc7,
  0xe9, 0x80, 0x7f, 0x4e, 0x60, 0x0a, 0x06, 0x1f,
  0x45, 0x6f, 0xfb, 0x02, 0xd2, 0xbe, 0xb3, 0x70,
]);

export interface ArciumEncryptedPosition {
  encryptedEntryPrice: number[];
  encryptedSize: number[];
  encryptedLeverage: number[];
  encryptedSide: number[];
  cipher: RescueCipher;
  nonce: Uint8Array;
  positionId: anchor.BN; // unique u64 per position — enables multiple per wallet
}

// Generate a random unique position ID
export function generatePositionId(): anchor.BN {
  const bytes = randomBytes(8);
  return new anchor.BN(bytes, "hex");
}

// Derive position PDA using [b"position", trader, position_id_le_bytes]
// Each unique position_id = unique PDA = multiple positions per wallet
export function getPositionPDA(
  traderPubkey: PublicKey,
  positionId: anchor.BN
): PublicKey {
  const idBytes = positionId.toArrayLike(Buffer, "le", 8);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), traderPubkey.toBuffer(), idBytes],
    PROGRAM_ID
  );
  return pda;
}

// Encrypt position fields using Arcium X25519 ECDH + RescueCipher
export async function encryptPosition(
  provider: anchor.AnchorProvider,
  entryPrice: number,
  sizeUsd: number,
  leverage: number,
  side: "long" | "short"
): Promise<ArciumEncryptedPosition> {
  // Ephemeral client keypair for ECDH
  const clientPrivateKey = x25519.utils.randomSecretKey();
  // Derive shared secret with MXE public key
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, MXE_X25519_PUBKEY);
  const cipher = new RescueCipher(sharedSecret);

  // Convert to fixed-point integers for ARCIS circuit
  const inputs = [
    BigInt(Math.floor(entryPrice * 100)), // entry price in cents
    BigInt(Math.floor(sizeUsd * 100)),    // size in cents
    BigInt(leverage),
    BigInt(side === "long" ? 1 : 0),
  ];

  const nonce = randomBytes(16);
  const ciphertext = cipher.encrypt(inputs, nonce);
  const positionId = generatePositionId();

  return {
    encryptedEntryPrice: Array.from(ciphertext[0]),
    encryptedSize: Array.from(ciphertext[1]),
    encryptedLeverage: Array.from(ciphertext[2]),
    encryptedSide: Array.from(ciphertext[3]),
    cipher,
    nonce,
    positionId,
  };
}

// Submit open_position — standard position, PnL revealed on close
export async function submitOpenPosition(
  program: anchor.Program<any>,
  encrypted: ArciumEncryptedPosition,
  traderPubkey: PublicKey
): Promise<string> {
  const positionPDA = getPositionPDA(traderPubkey, encrypted.positionId);
  const signature = await program.methods
    .openPosition(
      encrypted.positionId,
      encrypted.encryptedEntryPrice,
      encrypted.encryptedSize,
      encrypted.encryptedLeverage,
      encrypted.encryptedSide
    )
    .accounts({
      trader: traderPubkey,
      position: positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  return signature;
}

// Submit open_ghost_position — fully dark, PnL never stored or revealed
export async function submitOpenGhostPosition(
  program: anchor.Program<any>,
  encrypted: ArciumEncryptedPosition,
  traderPubkey: PublicKey
): Promise<string> {
  const positionPDA = getPositionPDA(traderPubkey, encrypted.positionId);
  const signature = await program.methods
    .openGhostPosition(
      encrypted.positionId,
      encrypted.encryptedEntryPrice,
      encrypted.encryptedSize,
      encrypted.encryptedLeverage,
      encrypted.encryptedSide
    )
    .accounts({
      trader: traderPubkey,
      position: positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  return signature;
}

// Submit close_position — position_id identifies which PDA to close
// Rent is returned to trader via `close = trader` constraint
export async function submitClosePosition(
  program: anchor.Program<any>,
  traderPubkey: PublicKey,
  positionId: anchor.BN,
  currentPrice: number,
  isGhost: boolean
): Promise<{ signature: string }> {
  const positionPDA = getPositionPDA(traderPubkey, positionId);
  const currentPriceBN = new anchor.BN(Math.floor(currentPrice * 100));
  // Ghost: pass zeroed PnL — program ignores it anyway due to is_ghost flag
  const encryptedPnl = new Array(32).fill(0);
  const signature = await program.methods
    .closePosition(positionId, currentPriceBN, encryptedPnl)
    .accounts({
      trader: traderPubkey,
      position: positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  return { signature };
}
