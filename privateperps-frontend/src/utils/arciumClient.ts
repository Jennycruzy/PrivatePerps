import * as anchor from "@coral-xyz/anchor";
import { x25519, RescueCipher } from "@arcium-hq/client";
import { PublicKey, SystemProgram } from "@solana/web3.js";

export const PROGRAM_ID  = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID || "By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv");
const ARCIUM_PROG        = new PublicKey("2iBUASRfDHgEkuZ91Lvos5NxwnmiQGTJCvpgBCHcFBd5");
const ARCIUM_STAKING     = new PublicKey("3C3n8JGYqBCMQbFTGNNJnnizoUJJFkGBruPpBFnSAjDW");
const ARCIUM_CLOCK       = new PublicKey("5GDcZeEHXoUgBq58YPMBHHgdxMhNBtV3L5GNjdaB5Bh3");
const MXE_X25519_PUBKEY  = new Uint8Array([0xbc,0x5b,0x7b,0xac,0xcb,0x2e,0x1d,0xb5,0x9b,0xec,0xb5,0x96,0x4e,0x6f,0xe3,0xc7,0xe9,0x80,0x7f,0x4e,0x60,0x0a,0x06,0x1f,0x45,0x6f,0xfb,0x02,0xd2,0xbe,0xb3,0x70]);
const COMP_DEF_OFFSETS   = { open_position: 3935201159, check_liquidation: 2996691951, compute_pnl: 4043984865 };

function mxePDA()                   { return PublicKey.findProgramAddressSync([Buffer.from("mxe"), PROGRAM_ID.toBytes()], ARCIUM_PROG)[0]; }
function mempoolPDA()               { return PublicKey.findProgramAddressSync([Buffer.from("mempool"), PROGRAM_ID.toBytes()], ARCIUM_PROG)[0]; }
function execPoolPDA()              { return PublicKey.findProgramAddressSync([Buffer.from("executing_pool"), PROGRAM_ID.toBytes()], ARCIUM_PROG)[0]; }
function compDefPDA(o: number)      { const b=Buffer.alloc(4);b.writeUInt32LE(o);return PublicKey.findProgramAddressSync([Buffer.from("comp_def"),PROGRAM_ID.toBytes(),b],ARCIUM_PROG)[0]; }
function compPDA(o: bigint)         { const b=Buffer.alloc(8);b.writeBigUInt64LE(o);return PublicKey.findProgramAddressSync([Buffer.from("comp"),PROGRAM_ID.toBytes(),b],ARCIUM_PROG)[0]; }
function clusterPDA(o=456)          { const b=Buffer.alloc(4);b.writeUInt32LE(o);return PublicKey.findProgramAddressSync([Buffer.from("cluster"),b],ARCIUM_PROG)[0]; }

export interface ArciumEncryptedPosition {
  encryptedEntryPrice: number[]; encryptedSize: number[];
  encryptedLeverage: number[];   encryptedSide: number[];
  pubKey: number[];  nonce: anchor.BN;
  positionId: anchor.BN; computationOffset: anchor.BN;
  cipher: RescueCipher;
}

export function getPositionPDA(trader: PublicKey, positionId: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), trader.toBuffer(), positionId.toArrayLike(Buffer,"le",8)], PROGRAM_ID
  )[0];
}

export async function encryptPosition(_p: any, entryPrice: number, sizeUsd: number, leverage: number, side: "long"|"short"): Promise<ArciumEncryptedPosition> {
  const priv   = x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(priv, MXE_X25519_PUBKEY);
  const pubKey = Array.from(x25519.getPublicKey(priv));
  const cipher = new RescueCipher(shared);
  const nonceBuf = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const nonce  = new anchor.BN(Buffer.from(nonceBuf).readBigUInt64LE(0).toString());
  const ct     = cipher.encrypt([BigInt(Math.floor(entryPrice*100)),BigInt(Math.floor(sizeUsd*100)),BigInt(leverage),BigInt(side==="long"?1:0)], nonceBuf);
  const idB    = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const posId  = BigInt("0x"+Array.from(idB).map(b=>b.toString(16).padStart(2,"0")).join(""));
  const compOff= BigInt(Date.now())*1000n+BigInt(Math.floor(Math.random()*1000));
  return {
    encryptedEntryPrice:Array.from(ct[0] as Uint8Array), encryptedSize:Array.from(ct[1] as Uint8Array),
    encryptedLeverage:Array.from(ct[2] as Uint8Array),   encryptedSide:Array.from(ct[3] as Uint8Array),
    pubKey, nonce, cipher,
    positionId:new anchor.BN(posId.toString()), computationOffset:new anchor.BN(compOff.toString()),
  };
}

function queueAccs(defOffset: number, compOff: bigint) {
  return { mxeAccount:mxePDA(), mempoolAccount:mempoolPDA(), executingPool:execPoolPDA(),
    computationAccount:compPDA(compOff), compDefAccount:compDefPDA(defOffset),
    clusterAccount:clusterPDA(), poolAccount:ARCIUM_STAKING, clockAccount:ARCIUM_CLOCK,
    systemProgram:SystemProgram.programId, arciumProgram:ARCIUM_PROG };
}

export async function submitOpenPosition(program: anchor.Program<any>, enc: ArciumEncryptedPosition, trader: PublicKey): Promise<string> {
  const off = BigInt(enc.computationOffset.toString());
  return program.methods.openPosition(enc.positionId,enc.computationOffset,enc.pubKey,enc.nonce,enc.encryptedEntryPrice,enc.encryptedSize,enc.encryptedLeverage,enc.encryptedSide)
    .accounts({ payer:trader, position:getPositionPDA(trader,enc.positionId), ...queueAccs(COMP_DEF_OFFSETS.open_position,off) }).rpc({commitment:"confirmed"});
}

export async function submitOpenGhostPosition(program: anchor.Program<any>, enc: ArciumEncryptedPosition, trader: PublicKey): Promise<string> {
  const off = BigInt(enc.computationOffset.toString());
  return program.methods.openGhostPosition(enc.positionId,enc.computationOffset,enc.pubKey,enc.nonce,enc.encryptedEntryPrice,enc.encryptedSize,enc.encryptedLeverage,enc.encryptedSide)
    .accounts({ payer:trader, position:getPositionPDA(trader,enc.positionId), ...queueAccs(COMP_DEF_OFFSETS.open_position,off) }).rpc({commitment:"confirmed"});
}

export async function submitClosePosition(program: anchor.Program<any>, trader: PublicKey, positionId: anchor.BN, currentPrice: number, _isGhost: boolean): Promise<{signature:string}> {
  const compOff = BigInt(Date.now())*1000n+BigInt(Math.floor(Math.random()*1000));
  const priv=x25519.utils.randomSecretKey();
  const shared=x25519.getSharedSecret(priv,MXE_X25519_PUBKEY);
  const pubKey=Array.from(x25519.getPublicKey(priv));
  const nonceBuf=globalThis.crypto.getRandomValues(new Uint8Array(16));
  const nonce=new anchor.BN(Buffer.from(nonceBuf).readBigUInt64LE(0).toString());
  const signature = await program.methods.closePosition(positionId,new anchor.BN(compOff.toString()),pubKey,nonce,new anchor.BN(Math.floor(currentPrice*100)))
    .accounts({ payer:trader, position:getPositionPDA(trader,positionId), ...queueAccs(COMP_DEF_OFFSETS.compute_pnl,compOff) }).rpc({commitment:"confirmed"});
  return { signature };
}
