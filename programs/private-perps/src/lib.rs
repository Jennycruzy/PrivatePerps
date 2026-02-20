use anchor_lang::prelude::*;
use arcium_macros::arcium_program;

declare_id!("By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv");

#[arcium_program]
pub mod private_perps {
    use super::*;

    // ── OPEN POSITION ─────────────────────────────────────────────────────

    pub fn open_position(
        ctx: Context<OpenPosition>,
        encrypted_entry_price: [u8; 32],
        encrypted_size: [u8; 32],
        encrypted_leverage: [u8; 32],
        encrypted_side: [u8; 32],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.trader.key();
        pos.is_open = true;
        pos.opened_at = Clock::get()?.unix_timestamp;
        pos.encrypted_entry_price = encrypted_entry_price;
        pos.encrypted_size = encrypted_size;
        pos.encrypted_leverage = encrypted_leverage;
        pos.encrypted_side = encrypted_side;

        emit!(PositionOpened {
            owner: pos.owner,
            position_id: pos.key(),
            timestamp: pos.opened_at,
        });

        Ok(())
    }

    // ── CLOSE POSITION ────────────────────────────────────────────────────

    pub fn close_position(
        ctx: Context<ClosePosition>,
        current_price: u64,
        encrypted_pnl: [u8; 32],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.owner == ctx.accounts.trader.key(), PrivatePerpsError::NotOwner);
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        pos.is_open = false;
        pos.exit_price = current_price;
        pos.encrypted_pnl = encrypted_pnl;
        pos.closed_at = Clock::get()?.unix_timestamp;

        emit!(PositionClosed {
            owner: pos.owner,
            position_id: pos.key(),
            exit_price: current_price,
            timestamp: pos.closed_at,
        });

        Ok(())
    }

    // ── LIQUIDATION ───────────────────────────────────────────────────────

    pub fn liquidate_position(
        ctx: Context<LiquidatePosition>,
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
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub is_open: bool,
    pub opened_at: i64,
    pub closed_at: i64,
    pub exit_price: u64,
    pub encrypted_entry_price: [u8; 32],
    pub encrypted_size: [u8; 32],
    pub encrypted_leverage: [u8; 32],
    pub encrypted_side: [u8; 32],
    pub encrypted_pnl: [u8; 32],
}

impl Position {
    pub const LEN: usize = 8 + 32 + 1 + 8 + 8 + 8 + 32 + 32 + 32 + 32 + 32;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT STRUCTS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        init,
        payer = trader,
        space = Position::LEN,
        seeds = [b"position", trader.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LiquidatePosition<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
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
pub struct PositionClosed {
    pub owner: Pubkey,
    pub position_id: Pubkey,
    pub exit_price: u64,
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
