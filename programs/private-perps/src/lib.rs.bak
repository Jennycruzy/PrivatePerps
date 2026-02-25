use anchor_lang::prelude::*;
use arcium_macros::arcium_program;

declare_id!("By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv");

#[arcium_program]
pub mod private_perps {
    use super::*;

    // ── OPEN POSITION ─────────────────────────────────────────────────────
    // position_id is a random u64 — unique per position, allows multiple per wallet

    pub fn open_position(
        ctx: Context<OpenPosition>,
        position_id: u64,
        encrypted_entry_price: [u8; 32],
        encrypted_size: [u8; 32],
        encrypted_leverage: [u8; 32],
        encrypted_side: [u8; 32],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.trader.key();
        pos.position_id = position_id;
        pos.is_open = true;
        pos.is_ghost = false;
        pos.opened_at = Clock::get()?.unix_timestamp;
        pos.closed_at = 0;
        pos.exit_price = 0;
        pos.encrypted_entry_price = encrypted_entry_price;
        pos.encrypted_size = encrypted_size;
        pos.encrypted_leverage = encrypted_leverage;
        pos.encrypted_side = encrypted_side;
        pos.encrypted_pnl = [0u8; 32];

        emit!(PositionOpened {
            owner: pos.owner,
            position_id: pos.key(),
            timestamp: pos.opened_at,
        });

        Ok(())
    }

    // ── OPEN GHOST POSITION ───────────────────────────────────────────────
    // Ghost positions: PnL is NEVER stored or revealed — fully dark on-chain
    // The is_ghost flag is set so close_position skips writing encrypted_pnl

    pub fn open_ghost_position(
        ctx: Context<OpenPosition>,
        position_id: u64,
        encrypted_entry_price: [u8; 32],
        encrypted_size: [u8; 32],
        encrypted_leverage: [u8; 32],
        encrypted_side: [u8; 32],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.trader.key();
        pos.position_id = position_id;
        pos.is_open = true;
        pos.is_ghost = true;
        pos.opened_at = Clock::get()?.unix_timestamp;
        pos.closed_at = 0;
        pos.exit_price = 0;
        pos.encrypted_entry_price = encrypted_entry_price;
        pos.encrypted_size = encrypted_size;
        pos.encrypted_leverage = encrypted_leverage;
        pos.encrypted_side = encrypted_side;
        pos.encrypted_pnl = [0u8; 32];

        emit!(GhostPositionOpened {
            owner: pos.owner,
            position_id: pos.key(),
            timestamp: pos.opened_at,
            // Intentionally no size, entry, side — ghost reveals nothing
        });

        Ok(())
    }

    // ── CLOSE POSITION ────────────────────────────────────────────────────

    pub fn close_position(
        ctx: Context<ClosePosition>,
        _position_id: u64,
        current_price: u64,
        encrypted_pnl: [u8; 32],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.owner == ctx.accounts.trader.key(), PrivatePerpsError::NotOwner);
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        pos.is_open = false;
        pos.exit_price = current_price;
        pos.closed_at = Clock::get()?.unix_timestamp;

        // Ghost positions never store PnL — stays zero forever
        if !pos.is_ghost {
            pos.encrypted_pnl = encrypted_pnl;
        }

        emit!(PositionClosed {
            owner: pos.owner,
            position_id: pos.key(),
            exit_price: current_price,
            is_ghost: pos.is_ghost,
            timestamp: pos.closed_at,
        });

        Ok(())
    }

    // ── LIQUIDATE POSITION ────────────────────────────────────────────────

    pub fn liquidate_position(
        ctx: Context<LiquidatePosition>,
        _position_id: u64,
        exit_price: u64,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        pos.is_open = false;
        pos.exit_price = exit_price;
        pos.closed_at = Clock::get()?.unix_timestamp;

        emit!(PositionLiquidated {
            owner: pos.owner,
            position_id: pos.key(),
            exit_price,
            timestamp: pos.closed_at,
        });

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT STRUCTS
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct Position {
    pub owner: Pubkey,                    // 32
    pub position_id: u64,                 // 8  — unique per position per wallet
    pub is_open: bool,                    // 1
    pub is_ghost: bool,                   // 1  — ghost: PnL never stored
    pub opened_at: i64,                   // 8
    pub closed_at: i64,                   // 8
    pub exit_price: u64,                  // 8
    pub encrypted_entry_price: [u8; 32], // 32
    pub encrypted_size: [u8; 32],        // 32
    pub encrypted_leverage: [u8; 32],    // 32
    pub encrypted_side: [u8; 32],        // 32
    pub encrypted_pnl: [u8; 32],         // 32 — zeroed for ghost
}

impl Position {
    pub const LEN: usize = 8   // discriminator
        + 32  // owner
        + 8   // position_id
        + 1   // is_open
        + 1   // is_ghost
        + 8   // opened_at
        + 8   // closed_at
        + 8   // exit_price
        + 32  // encrypted_entry_price
        + 32  // encrypted_size
        + 32  // encrypted_leverage
        + 32  // encrypted_side
        + 32; // encrypted_pnl
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT STRUCTS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        init,
        payer = trader,
        space = Position::LEN,
        seeds = [b"position", trader.key().as_ref(), &position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        mut,
        seeds = [b"position", trader.key().as_ref(), &position_id.to_le_bytes()],
        bump,
        close = trader,  // rent returned to trader on close
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct LiquidatePosition<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"position", caller.key().as_ref(), &position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────────────────────

#[event]
pub struct PositionOpened {
    pub owner: Pubkey,
    pub position_id: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct GhostPositionOpened {
    pub owner: Pubkey,
    pub position_id: Pubkey,
    pub timestamp: i64,
    // No size, entry, leverage — ghost reveals nothing
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub position_id: Pubkey,
    pub exit_price: u64,
    pub is_ghost: bool,
    pub timestamp: i64,
}

#[event]
pub struct PositionLiquidated {
    pub owner: Pubkey,
    pub position_id: Pubkey,
    pub exit_price: u64,
    pub timestamp: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum PrivatePerpsError {
    #[msg("Only the position owner can perform this action")]
    NotOwner,
    #[msg("Position is not open")]
    PositionNotOpen,
}
