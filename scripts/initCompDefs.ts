/**
 * initCompDefs.ts
 * Run ONCE after anchor deploy to register the 3 computation definitions onchain.
 * Usage: ts-node scripts/initCompDefs.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import IDL from "../privateperps-frontend/src/idl/private_perps.json";

// ── Config ────────────────────────────────────────────────────────────────────
const PROGRAM_ID     = new PublicKey("By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv");
const CLUSTER_OFFSET = 456;
const RPC_URL        = process.env.RPC_URL || "https://api.devnet.solana.com";

// Comp def offsets must match lib.rs comp_def_offset!() values
// These are deterministic based on circuit name — same as what the macro computes
const OPEN_POSITION_OFFSET     = compDefOffset("open_position");
const CHECK_LIQUIDATION_OFFSET = compDefOffset("check_liquidation");
const COMPUTE_PNL_OFFSET       = compDefOffset("compute_pnl");

// Mirrors the comp_def_offset! macro logic: hash circuit name to u32
function compDefOffset(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 0xFFFFFFFF;
}

async function main() {
  // Load wallet keypair
  const keypairPath = process.env.KEYPAIR_PATH ||
    `${os.homedir()}/.config/solana/id.json`;
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

  console.log("📍 Wallet:", keypair.publicKey.toBase58());
  console.log("📍 Program:", PROGRAM_ID.toBase58());
  console.log("📍 Cluster offset:", CLUSTER_OFFSET);
  console.log("📍 RPC:", RPC_URL);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new anchor.Program(IDL as anchor.Idl, provider);

  // Shared accounts needed by all init_comp_def calls
  const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
  const mxeAccount     = getMXEAccAddress(PROGRAM_ID);
  const mempoolAccount = getMempoolAccAddress(CLUSTER_OFFSET);

  // ── 1. init_open_position_comp_def ─────────────────────────────────────────
  console.log("\n🔐 Initializing open_position comp def...");
  try {
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, OPEN_POSITION_OFFSET);
    const tx1 = await (program.methods as any)
      .initOpenPositionCompDef()
      .accountsPartial({
        payer:       keypair.publicKey,
        compDef:     compDefAccount,
        mxeAccount,
        clusterAccount,
        mempoolAccount,
      })
      .rpc();
    console.log("✅ open_position comp def initialized:", tx1);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("⚠️  open_position comp def already initialized — skipping");
    } else {
      throw e;
    }
  }

  // ── 2. init_check_liquidation_comp_def ─────────────────────────────────────
  console.log("\n🔐 Initializing check_liquidation comp def...");
  try {
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, CHECK_LIQUIDATION_OFFSET);
    const tx2 = await (program.methods as any)
      .initCheckLiquidationCompDef()
      .accountsPartial({
        payer:       keypair.publicKey,
        compDef:     compDefAccount,
        mxeAccount,
        clusterAccount,
        mempoolAccount,
      })
      .rpc();
    console.log("✅ check_liquidation comp def initialized:", tx2);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("⚠️  check_liquidation comp def already initialized — skipping");
    } else {
      throw e;
    }
  }

  // ── 3. init_compute_pnl_comp_def ───────────────────────────────────────────
  console.log("\n🔐 Initializing compute_pnl comp def...");
  try {
    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, COMPUTE_PNL_OFFSET);
    const tx3 = await (program.methods as any)
      .initComputePnlCompDef()
      .accountsPartial({
        payer:       keypair.publicKey,
        compDef:     compDefAccount,
        mxeAccount,
        clusterAccount,
        mempoolAccount,
      })
      .rpc();
    console.log("✅ compute_pnl comp def initialized:", tx3);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("⚠️  compute_pnl comp def already initialized — skipping");
    } else {
      throw e;
    }
  }

  console.log("\n🎉 All computation definitions initialized!");
  console.log("   Arx nodes on cluster 456 can now execute your circuits.");
  console.log("   Circuits are stored at Supabase — Arx nodes will fetch on first use.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
