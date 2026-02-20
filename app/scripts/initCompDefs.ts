// app/scripts/initCompDefs.ts
//
// PrivatePerps — Initialize Arcium Computation Definitions
//
// Run this ONCE after deploying to devnet:
//   ts-node app/scripts/initCompDefs.ts
//
// This tells the Arcium cluster what encrypted computations
// your PrivatePerps MXE is authorized to run.
// Only needs to be done once — persists on-chain.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMXEAccAddress } from "@arcium-hq/client";
import * as fs from "fs";
import * as path from "path";

// ── Load config from environment ──────────────────────────────────────────────
const HELIUS_RPC = process.env.HELIUS_RPC_URL!;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
const KEYPAIR_PATH = (process.env.KEYPAIR_PATH || "~/.config/solana/id.json")
  .replace("~", process.env.HOME!);

async function main() {
  console.log("\n🔐 PrivatePerps — Initializing Arcium Computation Definitions\n");
  console.log("Network:    Solana Devnet");
  console.log("Cluster:    Arcium v0.8.3 (offset 456)");
  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("");

  // Set up provider
  const connection = new Connection(HELIUS_RPC, "confirmed");
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(Uint8Array.from(keypairData))
  );
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load compiled IDL
  const idl = JSON.parse(
    fs.readFileSync(
      path.resolve("./target/idl/private_perps.json"),
      "utf-8"
    )
  );
  const program = new anchor.Program(idl, provider);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);

  // The three computation definitions to register
  const defs = [
    { method: "initOpenPositionCompDef",      name: "open_position" },
    { method: "initCheckLiquidationCompDef",  name: "check_liquidation" },
    { method: "initComputePnlCompDef",        name: "compute_pnl" },
  ];

  for (const { method, name } of defs) {
    try {
      console.log(`Registering: ${name}...`);
      const sig = await (
        program.methods as Record<string, () => anchor.MethodsBuilder>
      )
        [method]()
        .accounts({ payer: wallet.publicKey, mxeAccount })
        .rpc({ commitment: "confirmed" });
      console.log(`  ✓ Done — tx: ${sig}\n`);
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("already in use")) {
        console.log(`  ℹ Already registered — skipping\n`);
      } else {
        console.error(`  ✗ Failed: ${msg}\n`);
        throw e;
      }
    }
  }

  console.log("✅ All computation definitions registered!");
  console.log("   PrivatePerps is ready on Arcium devnet.\n");
}

main().catch(console.error);
