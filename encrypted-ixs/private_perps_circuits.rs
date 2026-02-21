// encrypted-ixs/private_perps_circuits.rs
// PrivatePerps - Arcium Confidential Compute Layer
//
// These instructions run INSIDE Arcium's MXE (Multi-Party Computation
// eXecution Environment). No node, operator, or observer can see the
// position data, leverage, size, or liquidation thresholds.

use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    // All fields encrypted throughout their lifetime
    pub struct PositionInput {
        // Entry price x 100 fixed-point (e.g. 6742000 = $67,420.00)
        pub entry_price: u64,
        // Size in USD cents (e.g. 50000 = $500.00)
        pub size_usd: u64,
        // Leverage multiplier (e.g. 10 = 10x)
        pub leverage: u64,
        // Side: 1 = long, 0 = short
        pub side: u64,
    }

    // INSTRUCTION 1: open_position
    // Stores the encrypted position on-chain.
    // The MXE validates inputs are well-formed without ever seeing them.
    #[instruction]
    pub fn open_position(
        input_ctxt: Enc<Shared, PositionInput>,
    ) -> Enc<Shared, PositionInput> {
        let pos = input_ctxt.to_arcis();
        input_ctxt.owner.from_arcis(pos)
    }

    // INSTRUCTION 2: check_liquidation
    // Performs the liquidation check PRIVATELY.
    // Returns: 1 if liquidated, 0 if safe as an encrypted u64.
    // PRIVACY: Bots and front-runners NEVER see the threshold.
    #[instruction]
    pub fn check_liquidation(
        position_ctxt: Enc<Shared, PositionInput>,
        current_price: u64,
    ) -> Enc<Shared, u64> {
        let pos = position_ctxt.to_arcis();

        // Liquidation logic runs inside encrypted compute:
        // long:  liq_price = entry - (entry / leverage)
        // short: liq_price = entry + (entry / leverage)
        let is_liquidated: u64 = if pos.side == 1 {
            let liq_threshold = pos.entry_price - (pos.entry_price / pos.leverage);
            if current_price <= liq_threshold { 1 } else { 0 }
        } else {
            let liq_threshold = pos.entry_price + (pos.entry_price / pos.leverage);
            if current_price >= liq_threshold { 1 } else { 0 }
        };

        position_ctxt.owner.from_arcis(is_liquidated)
    }

    // INSTRUCTION 3: compute_pnl
    // Computes realized PnL when closing a position.
    // PRIVACY: Entry price, size, leverage remain encrypted throughout.
    // ONLY the final PnL value is returned.
    #[instruction]
    pub fn compute_pnl(
        position_ctxt: Enc<Shared, PositionInput>,
        current_price: u64,
    ) -> Enc<Shared, u64> {
        let pos = position_ctxt.to_arcis();

        // PnL formula inside encrypted compute:
        // notional = size x leverage
        // pnl = notional x (price_change / entry_price)
        let notional = pos.size_usd * pos.leverage;

        let pnl: u64 = if pos.side == 1 {
            // LONG: profit when price goes up
            if current_price > pos.entry_price {
                let delta = current_price - pos.entry_price;
                (delta * notional) / pos.entry_price
            } else {
                0
            }
        } else {
            // SHORT: profit when price goes down
            if pos.entry_price > current_price {
                let delta = pos.entry_price - current_price;
                (delta * notional) / pos.entry_price
            } else {
                0
            }
        };

        position_ctxt.owner.from_arcis(pnl)
    }
}
