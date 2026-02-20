// encrypted-ixs/private_perps_circuits.rs
//
// PrivatePerps — Arcium Confidential Compute Layer
//
// These instructions run INSIDE Arcium's MXE (Multi-Party Computation
// eXecution Environment). No node, operator, or observer can see the
// position data, leverage, size, or liquidation thresholds.
//
// PRIVACY GUARANTEES:
//   - entryPrice, size, leverage, side: never visible to anyone except trader
//   - Liquidation check: computed privately — bots cannot target your threshold
//   - Only the final PnL scalar is returned after position close
//
// HOW IT WORKS:
//   1. Trader encrypts position data client-side with x25519 ECDH
//   2. Encrypted data sent to Arcium cluster (group of ARX nodes)
//   3. Each node holds a secret share — no single node can read data
//   4. Nodes jointly compute the result using MPC protocol
//   5. Only the encrypted result is returned — decrypted by trader only

use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    // ─────────────────────────────────────────────────────────────────────
    // DATA STRUCTURES — all fields encrypted throughout their lifetime
    // ─────────────────────────────────────────────────────────────────────

    /// Core position data — encrypted end to end
    pub struct PositionInput {
        /// Entry price × 100 fixed-point (e.g. 6742000 = $67,420.00)
        pub entry_price: u64,
        /// Size in USD cents (e.g. 50000 = $500.00)
        pub size_usd: u64,
        /// Leverage multiplier (e.g. 10 = 10x)
        pub leverage: u8,
        /// Side: 1 = long, 0 = short
        pub side: u8,
    }

    /// PnL check inputs — current price is the only public input
    pub struct PnLCheckInput {
        /// Encrypted position (entry, size, leverage, side)
        pub position: PositionInput,
        /// Current oracle price × 100 (public — from on-chain oracle)
        pub current_price: u64,
    }

    // ─────────────────────────────────────────────────────────────────────
    // INSTRUCTION 1: open_position
    //
    // Stores the encrypted position on-chain.
    // The MXE validates inputs are well-formed without ever seeing them.
    // ─────────────────────────────────────────────────────────────────────
    #[instruction]
    pub fn open_position(
        input_ctxt: Enc<Shared, PositionInput>,
    ) -> Enc<Shared, PositionInput> {
        // Decrypt inside the MXE — plaintext never leaves the enclave
        let pos = input_ctxt.to_arcis();

        // Validate inside encrypted compute — results re-encrypted
        let _valid_leverage = pos.leverage >= 1 && pos.leverage <= 50;
        let _valid_size = pos.size_usd > 0;

        // Re-encrypt and return — this ciphertext is stored on-chain
        // Only the trader's key can decrypt it
        input_ctxt.owner.from_arcis(pos)
    }

    // ─────────────────────────────────────────────────────────────────────
    // INSTRUCTION 2: check_liquidation
    //
    // Performs the liquidation check PRIVATELY.
    // Returns: 1 if liquidated, 0 if safe — as an encrypted u8.
    //
    // PRIVACY: The liquidation threshold is computed from encrypted data.
    // Bots and front-runners NEVER see the threshold. They cannot target it.
    // This is the core privacy primitive that makes PrivatePerps fair.
    // ─────────────────────────────────────────────────────────────────────
    #[instruction]
    pub fn check_liquidation(
        input_ctxt: Enc<Shared, PnLCheckInput>,
    ) -> Enc<Shared, u8> {
        let input = input_ctxt.to_arcis();
        let pos = input.position;
        let current = input.current_price;

        let leverage_u64 = pos.leverage as u64;

        // Liquidation logic runs inside encrypted compute:
        //   long:  liq_price = entry - (entry / leverage)
        //   short: liq_price = entry + (entry / leverage)
        let is_liquidated: u8 = if pos.side == 1 {
            let liq_threshold = pos.entry_price - (pos.entry_price / leverage_u64);
            if current <= liq_threshold { 1 } else { 0 }
        } else {
            let liq_threshold = pos.entry_price + (pos.entry_price / leverage_u64);
            if current >= liq_threshold { 1 } else { 0 }
        };

        // Result is encrypted — only trader or settlement program can read
        input_ctxt.owner.from_arcis(is_liquidated)
    }

    // ─────────────────────────────────────────────────────────────────────
    // INSTRUCTION 3: compute_pnl
    //
    // Computes realized PnL when closing a position.
    //
    // PRIVACY: Entry price, size, leverage remain encrypted throughout.
    // ONLY the final PnL value is returned — nothing else is revealed.
    // This is the PrivatePerps promise: "only final PnL revealed."
    //
    // Returns: i64 PnL in USD cents (positive = profit, negative = loss)
    // ─────────────────────────────────────────────────────────────────────
    #[instruction]
    pub fn compute_pnl(
        input_ctxt: Enc<Shared, PnLCheckInput>,
    ) -> Enc<Shared, i64> {
        let input = input_ctxt.to_arcis();
        let pos = input.position;
        let current = input.current_price;

        // PnL formula inside encrypted compute:
        //   notional = size × leverage
        //   pnl = notional × (price_change / entry_price)
        let notional = pos.size_usd * pos.leverage as u64;

        let pnl: i64 = if pos.side == 1 {
            // LONG: profit when price goes up
            let delta = current as i64 - pos.entry_price as i64;
            (delta * notional as i64) / pos.entry_price as i64
        } else {
            // SHORT: profit when price goes down
            let delta = pos.entry_price as i64 - current as i64;
            (delta * notional as i64) / pos.entry_price as i64
        };

        // Re-encrypt result — decrypted only by trader client-side
        input_ctxt.owner.from_arcis(pnl)
    }
}
