# PrivatePerps on Arcium

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana&logoColor=white)](https://explorer.solana.com/address/By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv?cluster=devnet)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-512DA8)](https://www.anchor-lang.com/docs)
[![Arcium](https://img.shields.io/badge/Arcium-RTG-00C2FF)](https://rtg.arcium.com/rtg)
[![Rust](https://img.shields.io/badge/Rust-1.85.0-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![X](https://img.shields.io/badge/@jennyoliver57-000000?logo=x&logoColor=white)](https://x.com/jennyoliver57)

**Privacy-preserving perpetuals trading powered by Arcium's Multi-Party Computation network on Solana.**

All positions are encrypted end-to-end. No one, not the protocol, not other traders, not even the validators, can see your entry price, size, leverage, or PnL. Only you know your position details.

**Program ID:** `By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv` — [View on Solana Explorer](https://explorer.solana.com/address/By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv?cluster=devnet)

**RTG Submission:** [rtg.arcium.com/rtg](https://rtg.arcium.com/rtg)

---

## The Problem

Traditional onchain perps are completely transparent. Every position is visible to everyone, enabling:

| Attack | How It Works | Impact |
|--------|-------------|--------|
| Front-running | Watch mempool, trade ahead of large orders | Honest traders always lose |
| Liquidation hunting | Target known positions below liquidation price | Forced liquidations for profit |
| Copytrading without consent | Mirror profitable positions in real time | Alpha leakage |
| Market manipulation | Reveal large position intent to the world | Price moves against retail |

**PrivatePerps eliminates all of these.** Positions are encrypted using Arcium's MPC — they never exist anywhere onchain.

---

## Features

### Private Perpetuals Trading
- **Encrypted positions** — entry price, size, leverage and side are never visible onchain, not even to validators
- **Private liquidation checks** — liquidation logic runs inside MPC, your risk is never exposed
- **Confidential PnL** — profit and loss computed in encrypted space, only revealed to you
- **Verifiable computation** — every MPC result is verifiable onchain
- **Minimal reveal** — only final settlement amounts revealed at close

---

## Architecture

### Data Flow

```
Trader encrypts position locally
    |
    v
Solana Program receives encrypted ciphertexts
    |
    v
queue_computation() sends to Arcium MPC nodes
    |
    v
MPC nodes jointly compute (no single node sees plaintext)
    |
    v
Signed result returned via callback instruction
    |
    v
Onchain state updated (position PDA)
```

### Privacy Guarantees

| Data | While Open | After Close |
|------|-----------|-------------|
| Entry price | Encrypted | Encrypted |
| Position size | Encrypted | Encrypted |
| Leverage | Encrypted | Encrypted |
| Side (Long/Short) | Encrypted | Encrypted |
| PnL | Encrypted | Revealed to owner only |
| Liquidation price | Encrypted | Encrypted |
| Whether you have a position | Public (tx visible) | Public |

---

## Technical Deep-Dive

### 1. Solana Program (`programs/private-perps/src/lib.rs`)

Three core instructions handle the full position lifecycle:

```rust
// Open a position with fully encrypted parameters
pub fn open_position(
    ctx: Context<OpenPosition>,
    encrypted_entry_price: [u8; 32],  // Encrypted with MXE key
    encrypted_size: [u8; 32],         // Encrypted with trader's key
    encrypted_leverage: [u8; 32],
    encrypted_side: [u8; 32],
) -> Result<()>

// Close a position — PnL computed inside Arcium MPC
pub fn close_position(
    ctx: Context<ClosePosition>,
    current_price: u64,
    encrypted_pnl: [u8; 32],
) -> Result<()>

// Liquidate — liquidation check runs in encrypted space
pub fn liquidate_position(
    ctx: Context<LiquidatePosition>,
    exit_price: u64,
) -> Result<()>
```

### 2. Position Account Layout

```
+------------+----------+----------+----------+----------+----------+
| Discrim.   | Owner    | is_open  | opened_at| exit_price| enc_data |
| 8 bytes    | 32 bytes | 1 byte   | 8 bytes  | 8 bytes  | 128 bytes|
+------------+----------+----------+----------+----------+----------+

PDA Seeds: ["position", trader_pubkey]
```

Three computation definitions registered on Arcium:
- `open_position` — Initialize encrypted position state
- `check_liquidation` — Compare encrypted position against liquidation price
- `compute_pnl` — Calculate final PnL in encrypted space

Each instruction uses `queue_computation()` to dispatch to Arcium's MPC nodes and receives results via `#[arcium_callback]` instructions.

### 3. Encryption Flow

Positions are encrypted client-side using **X25519 ECDH** shared secret before being sent to the Solana program. The MXE (Multi-party eXecution Environment) public key is fetched from the Arcium network and used to establish the shared secret. The encrypted bytes are stored onchain and only the Arcium MPC cluster can compute over them.

Key design:
- `Enc<Mxe, _>` — data encrypted with the MXE cluster key, no single party can decrypt
- `Enc<Shared, _>` — data shared between the trader and MPC nodes

### 4. Frontend (`privateperps.html`)
- Single-page trading interface with Arcium-inspired glassmorphism design
- Wallet connection via Solana wallet standard
- Real-time encrypted position management
- Privacy indicators showing encryption status on every field

---

## Project Structure

```
PrivatePerps/
|
+-- programs/
|   +-- private-perps/
|       +-- src/
|           +-- lib.rs              # Anchor program (deployed on devnet)
|       +-- Cargo.toml
|
+-- privateperps.html               # Frontend trading UI
+-- app/
|   +-- lib/
|   |   +-- arciumClient.ts         # Arcium MPC client (X25519 + RescueCipher)
|   +-- scripts/
|   |   +-- initCompDefs.ts         # Computation definition initializer
|   +-- types/
|       +-- index.ts                # TypeScript types
|
+-- scripts/
|   +-- run_arcium_localnet.sh      # Local Arx node startup
|   +-- run_arcium_test.sh          # Test runner wrapper
|   +-- run_frontend.sh             # Frontend dev server
|
+-- Anchor.toml
+-- Cargo.toml
+-- package.json
```

---

## Quick Start

### Prerequisites

- Rust (latest stable)
- Solana CLI v2.3.0+
- Anchor 0.32.1
- Arcium CLI 0.8.5
- Node.js 22+
- Yarn
- Docker

### Install Arcium CLI

```bash
curl -sSf https://install.arcium.com | sh
```

### Build & Deploy

```bash
# Clone the repo
git clone https://github.com/Jennycruzy/PrivatePerps.git
cd PrivatePerps

# Install dependencies
yarn install

# Build the Solana program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Initialize MXE
arcium mxe init --cluster-id 456 --recovery-set-size 4

# Upload circuits
arcium mxe upload-circuit build/open_position.arcis
arcium mxe upload-circuit build/check_liquidation.arcis
arcium mxe upload-circuit build/compute_pnl.arcis

# Initialize computation definitions
ts-node app/scripts/initCompDefs.ts
```

### Run Locally

```bash
# Terminal 1 — start localnet + Arx nodes
./scripts/run_arcium_localnet.sh

# Terminal 2 — fund wallet and run tests
solana airdrop 2 --url http://127.0.0.1:8899
anchor test --skip-local-validator
```

---

## Deployment Status

| Component | Status | Details |
|-----------|--------|---------|
| Solana Program | ✅ Deployed | [`By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv`](https://explorer.solana.com/address/By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv?cluster=devnet) on devnet |
| Arcium CLI | ✅ Installed | v0.8.5 |
| Frontend | ✅ Live | `privateperps.html` |
| MXE Cluster | 🔄 Initializing | Devnet cluster, key generation in progress |
| ARCIS Circuits | 🔄 Building | 3 circuits (open, liquidate, pnl) |

---

## Author

**jennycruzy** — [x.com/jennyoliver57](https://x.com/jennyoliver57) — Arcium RTG Submission

---

## Links

- [Live Program on Solana Explorer](https://explorer.solana.com/address/By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv?cluster=devnet)
- [Arcium RTG Submission](https://rtg.arcium.com/rtg)
- [Arcium Documentation](https://docs.arcium.com)
- [Anchor Documentation](https://www.anchor-lang.com/docs)
- [Rust](https://www.rust-lang.org)
- [Node.js](https://nodejs.org)

---

## License

[MIT](./LICENSE) © 2026 jennycruzy
