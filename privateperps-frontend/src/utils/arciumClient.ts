import * as anchor from "@coral-xyz/anchor";
import { x25519, RescueCipher } from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv"
);

// MXE X25519 public key — finalized on devnet cluster 456
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
  positionId: anchor.BN; // unique u64 per position — multiple positions per wallet
}

// Random unique position ID using browser-native crypto (no Node crypto needed)
export function generatePositionId(): anchor.BN {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  let val = BigInt(0);
  for (let i = 7; i >= 0; i--) {
    val = (val << BigInt(8)) | BigInt(bytes[i]);
  }
  val = val & BigInt("0xFFFFFFFFFFFFFFFF");
  return new anchor.BN(val.toString());
}

// Derive position PDA: ["position", trader_pubkey, position_id_le_bytes]
// Unique position_id => unique PDA => unlimited positions per wallet
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

// Encrypt all position fields via Arcium X25519 ECDH + RescueCipher
export async function encryptPosition(
  provider: anchor.AnchorProvider,
  entryPrice: number,
  sizeUsd: number,
  leverage: number,
  side: "long" | "short"
): Promise<ArciumEncryptedPosition> {
  const clientPrivateKey = x25519.utils.randomSecretKey();
  const sharedSecret = x25519.getSharedSecret(clientPrivateKey, MXE_X25519_PUBKEY);
  const cipher = new RescueCipher(sharedSecret);

  const inputs = [
    BigInt(Math.floor(entryPrice * 100)),
    BigInt(Math.floor(sizeUsd * 100)),
    BigInt(leverage),
    BigInt(side === "long" ? 1 : 0),
  ];

  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = cipher.encrypt(inputs, nonce);
  const positionId = generatePositionId();

  return {
    encryptedEntryPrice: Array.from(ciphertext[0]),
    encryptedSize:       Array.from(ciphertext[1]),
    encryptedLeverage:   Array.from(ciphertext[2]),
    encryptedSide:       Array.from(ciphertext[3]),
    cipher,
    nonce,
    positionId,
  };
}

// open_position — standard, PnL revealed on close
export async function submitOpenPosition(
  program: anchor.Program<any>,
  encrypted: ArciumEncryptedPosition,
  traderPubkey: PublicKey
): Promise<string> {
  const positionPDA = getPositionPDA(traderPubkey, encrypted.positionId);
  return await program.methods
    .openPosition(
      encrypted.positionId,
      encrypted.encryptedEntryPrice,
      encrypted.encryptedSize,
      encrypted.encryptedLeverage,
      encrypted.encryptedSide
    )
    .accounts({
      trader:        traderPubkey,
      position:      positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });
}

// open_ghost_position — fully dark, PnL NEVER stored or revealed on-chain
export async function submitOpenGhostPosition(
  program: anchor.Program<any>,
  encrypted: ArciumEncryptedPosition,
  traderPubkey: PublicKey
): Promise<string> {
  const positionPDA = getPositionPDA(traderPubkey, encrypted.positionId);
  return await program.methods
    .openGhostPosition(
      encrypted.positionId,
      encrypted.encryptedEntryPrice,
      encrypted.encryptedSize,
      encrypted.encryptedLeverage,
      encrypted.encryptedSide
    )
    .accounts({
      trader:        traderPubkey,
      position:      positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });
}

// close_position
// IDL arg is named `_position_id` but Anchor passes by position order, not name.
// PDA seed in IDL uses `position_id` (without underscore) — Anchor resolves it
// from the arg at index 0 regardless of the underscore prefix.
export async function submitClosePosition(
  program: anchor.Program<any>,
  traderPubkey: PublicKey,
  positionId: anchor.BN,
  currentPrice: number,
  isGhost: boolean
): Promise<{ signature: string }> {
  const positionPDA    = getPositionPDA(traderPubkey, positionId);
  const currentPriceBN = new anchor.BN(Math.floor(currentPrice * 100));
  // Ghost: send zeroed PnL — on-chain program ignores it due to is_ghost flag
  const encryptedPnl   = new Array(32).fill(0);

  const signature = await program.methods
    .closePosition(positionId, currentPriceBN, encryptedPnl)
    .accounts({
      trader:        traderPubkey,
      position:      positionPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ skipPreflight: false, commitment: "confirmed" });

  return { signature };
}
