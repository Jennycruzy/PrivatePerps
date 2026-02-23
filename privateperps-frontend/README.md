# PrivatePerps Frontend

Next.js frontend for PrivatePerps — privacy-preserving perpetuals powered by Arcium MPC on Solana.

## Stack

- **Next.js 14** (App Router)
- **@arcium-hq/client** — X25519 ECDH encryption + RescueCipher + MPC helpers
- **@coral-xyz/anchor** — Solana program client
- **@solana/wallet-adapter** — Phantom wallet connection
- **Tailwind CSS** — styling

## Setup

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

## Environment Variables

```
NEXT_PUBLIC_PROGRAM_ID=By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv
NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET=456
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_CLUSTER=devnet
```

## How It Works

### Position Opening
1. User enters size, leverage, side
2. `encryptPosition()` fetches MXE public key from devnet, runs X25519 ECDH key exchange, encrypts all 4 fields (entry price, size, leverage, side) using RescueCipher
3. `submitOpenPosition()` sends encrypted ciphertexts to Solana via `queue_computation()`
4. `waitForComputation()` waits for Arcium MPC nodes on cluster 456 to finalize

### Position Closing / PnL
1. `submitComputePnL()` submits current price (public) + encrypted position to Arcium
2. MPC nodes compute PnL entirely on encrypted data
3. Encrypted result returned via `PnLComputedEvent`
4. Client decrypts using the same cipher from open — only the PnL value is revealed

### What Never Leaves Encrypted
- Entry price
- Position size  
- Leverage
- Side (long/short)
- Liquidation threshold

## Deploying to Vercel

```bash
npm install -g vercel
vercel --prod
```

Set the env vars in Vercel dashboard or they'll be picked up from vercel.json.

## Important: Add Your IDL

Copy your compiled IDL from the Solana program to the frontend:

```bash
cp ../target/idl/private_perps.json src/idl/private_perps.json
```

Then update `src/app/page.tsx` to import it:
```ts
import IDL from "@/idl/private_perps.json";
// Replace getIDL() call with: new anchor.Program(IDL, PROGRAM_ID, provider)
```
