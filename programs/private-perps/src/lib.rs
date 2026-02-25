use anchor_lang::prelude::*;
use arcium_anchor::{
    init_comp_def, queue_computation, ComputationOutputs,
    derive_comp_def_pda, derive_mxe_pda, derive_mempool_pda,
    derive_execpool_pda, derive_cluster_pda, derive_comp_pda,
    ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS, ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    MXE_PDA_SEED, MEMPOOL_PDA_SEED, EXECPOOL_PDA_SEED,
    COMP_PDA_SEED, COMP_DEF_PDA_SEED, CLUSTER_PDA_SEED,
};
use arcium_client::idl::arcium::ID_CONST as ARCIUM_PROG_ID;
use arcium_client::idl::arcium::{
    program::Arcium,
    accounts::{
        PersistentMXEAccount,
        ComputationDefinitionAccount, Cluster, StakingPoolAccount,
        ClockAccount,
    },
    types::{Argument, OffChainCircuitSource},
};
use arcium_macros::{
    arcium_program, arcium_callback,
    init_computation_definition_accounts,
    queue_computation_accounts,
    callback_accounts,
};

declare_id!("By8ZwAFK26UhgwkVQXP3KE6miD4mgEz6eQ7QTS3X8FHv");

// ── Comp def offsets: u32::from_le_bytes(SHA256(name)[0..4]) ─────────────────
const OPEN_POSITION_COMP_DEF_OFFSET:     u32 = 3935201159;
const CHECK_LIQUIDATION_COMP_DEF_OFFSET: u32 = 2996691951;
const COMPUTE_PNL_COMP_DEF_OFFSET:       u32 = 4043984865;

// ── Supabase circuit URLs ─────────────────────────────────────────────────────
const OPEN_POSITION_URL: &str =
    "https://qzkycebbcgieazeveteb.supabase.co/storage/v1/object/public/Circuits/open_position.arcis";
const CHECK_LIQUIDATION_URL: &str =
    "https://qzkycebbcgieazeveteb.supabase.co/storage/v1/object/public/Circuits/check_liquidation.arcis";
const COMPUTE_PNL_URL: &str =
    "https://qzkycebbcgieazeveteb.supabase.co/storage/v1/object/public/Circuits/compute_pnl.arcis";

#[arcium_program]
pub mod private_perps {
    use super::*;

    // ══════════════════════════════════════════════════════════════════════════
    // ONE-TIME SETUP
    // init_comp_def(accs, finalize_during_callback, offchain_source, finalize_authority)
    // ══════════════════════════════════════════════════════════════════════════

    pub fn init_open_position_comp_def(
        ctx: Context<InitOpenPositionCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            false,
            Some(OffChainCircuitSource {
                source: OPEN_POSITION_URL.to_string(),
                hash: [238,229,76,89,122,94,117,95,108,229,113,221,228,34,34,34,
                       61,137,57,249,244,244,160,106,158,87,211,116,115,83,57,235],
            }),
            None,
        )?;
        Ok(())
    }

    pub fn init_check_liquidation_comp_def(
        ctx: Context<InitCheckLiquidationCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            false,
            Some(OffChainCircuitSource {
                source: CHECK_LIQUIDATION_URL.to_string(),
                hash: [211,123,192,1,177,252,222,216,193,229,204,156,178,208,213,142,
                       245,222,16,14,0,190,234,146,119,13,149,159,141,237,43,87],
            }),
            None,
        )?;
        Ok(())
    }

    pub fn init_compute_pnl_comp_def(
        ctx: Context<InitComputePnlCompDef>,
    ) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            false,
            Some(OffChainCircuitSource {
                source: COMPUTE_PNL_URL.to_string(),
                hash: [25,138,54,105,174,3,30,141,54,107,161,165,110,12,95,44,
                       140,182,173,193,94,96,155,195,54,155,26,15,175,29,56,132],
            }),
            None,
        )?;
        Ok(())
    }

    // ══════════════════════════════════════════════════════════════════════════
    // OPEN POSITION
    // ══════════════════════════════════════════════════════════════════════════

    pub fn open_position(
        ctx: Context<OpenPosition>,
        position_id:        u64,
        computation_offset: u64,
        pub_key:            [u8; 32],
        nonce:              u128,
        enc_entry_price:    [u8; 32],
        enc_size:           [u8; 32],
        enc_leverage:       [u8; 32],
        enc_side:           [u8; 32],
    ) -> Result<()> {
        let opened_at = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.payer.key();
        let pos_key = ctx.accounts.position.key();
        {
            let pos = &mut ctx.accounts.position;
            pos.owner              = owner;
            pos.position_id        = position_id;
            pos.is_open            = false;
            pos.is_ghost           = false;
            pos.opened_at          = opened_at;
            pos.closed_at          = 0;
            pos.exit_price         = 0;
            pos.computation_offset = computation_offset;
            pos.enc_entry_price    = enc_entry_price;
            pos.enc_size           = enc_size;
            pos.enc_leverage       = enc_leverage;
            pos.enc_side           = enc_side;
            pos.enc_pnl            = [0u8; 32];
        }

        let args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
            Argument::EncryptedU128(enc_entry_price),
            Argument::EncryptedU128(enc_size),
            Argument::EncryptedU128(enc_leverage),
            Argument::EncryptedU128(enc_side),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![], None)?;

        emit!(PositionQueued {
            owner,
            position_id: pos_key,
            timestamp:  opened_at,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "open_position")]
    pub fn open_position_callback(
        ctx: Context<OpenPositionCallback>,
        _output: ComputationOutputs,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.is_open = true;
        emit!(PositionOpened {
            owner:      pos.owner,
            position_id: pos.key(),
            timestamp:  pos.opened_at,
        });
        Ok(())
    }

    // ══════════════════════════════════════════════════════════════════════════
    // OPEN GHOST POSITION
    // ══════════════════════════════════════════════════════════════════════════

    pub fn open_ghost_position(
        ctx: Context<OpenGhostPosition>,
        position_id:        u64,
        computation_offset: u64,
        pub_key:            [u8; 32],
        nonce:              u128,
        enc_entry_price:    [u8; 32],
        enc_size:           [u8; 32],
        enc_leverage:       [u8; 32],
        enc_side:           [u8; 32],
    ) -> Result<()> {
        let opened_at = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.payer.key();
        let pos_key = ctx.accounts.position.key();
        {
            let pos = &mut ctx.accounts.position;
            pos.owner              = owner;
            pos.position_id        = position_id;
            pos.is_open            = false;
            pos.is_ghost           = true;
            pos.opened_at          = opened_at;
            pos.closed_at          = 0;
            pos.exit_price         = 0;
            pos.computation_offset = computation_offset;
            pos.enc_entry_price    = enc_entry_price;
            pos.enc_size           = enc_size;
            pos.enc_leverage       = enc_leverage;
            pos.enc_side           = enc_side;
            pos.enc_pnl            = [0u8; 32];
        }

        let args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
            Argument::EncryptedU128(enc_entry_price),
            Argument::EncryptedU128(enc_size),
            Argument::EncryptedU128(enc_leverage),
            Argument::EncryptedU128(enc_side),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![], None)?;

        emit!(GhostPositionOpened {
            owner,
            position_id: pos_key,
            timestamp:  opened_at,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "open_ghost_position")]
    pub fn open_ghost_position_callback(
        ctx: Context<OpenGhostPositionCallback>,
        _output: ComputationOutputs,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.is_open = true;
        Ok(())
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CHECK LIQUIDATION
    // ══════════════════════════════════════════════════════════════════════════

    pub fn check_liquidation(
        ctx: Context<CheckLiquidation>,
        position_id:        u64,
        computation_offset: u64,
        pub_key:            [u8; 32],
        nonce:              u128,
        current_price:      u64,
    ) -> Result<()> {
        let pos = &ctx.accounts.position;
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        let args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
            Argument::EncryptedU128(pos.enc_entry_price),
            Argument::EncryptedU128(pos.enc_size),
            Argument::EncryptedU128(pos.enc_leverage),
            Argument::EncryptedU128(pos.enc_side),
            Argument::PlaintextU64(current_price),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![], None)?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "check_liquidation")]
    pub fn check_liquidation_callback(
        ctx: Context<CheckLiquidationCallback>,
        _output: ComputationOutputs,
    ) -> Result<()> {
        let pos = &ctx.accounts.position;
        emit!(LiquidationChecked {
            owner:      pos.owner,
            position_id: pos.key(),
            timestamp:  Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CLOSE POSITION
    // ══════════════════════════════════════════════════════════════════════════

    pub fn close_position(
        ctx: Context<ClosePosition>,
        position_id:        u64,
        computation_offset: u64,
        pub_key:            [u8; 32],
        nonce:              u128,
        current_price:      u64,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.owner == ctx.accounts.payer.key(), PrivatePerpsError::NotOwner);
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        pos.exit_price = current_price;

        if pos.is_ghost {
            pos.is_open   = false;
            pos.closed_at = Clock::get()?.unix_timestamp;
            emit!(PositionClosed {
                owner:      pos.owner,
                position_id: pos.key(),
                exit_price: current_price,
                is_ghost:   true,
                timestamp:  pos.closed_at,
            });
            return Ok(());
        }

        let args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
            Argument::EncryptedU128(pos.enc_entry_price),
            Argument::EncryptedU128(pos.enc_size),
            Argument::EncryptedU128(pos.enc_leverage),
            Argument::EncryptedU128(pos.enc_side),
            Argument::PlaintextU64(current_price),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![], None)?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "close_position")]
    pub fn close_position_callback(
        ctx: Context<ClosePositionCallback>,
        output: ComputationOutputs,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;

        if let ComputationOutputs::Bytes(ref bytes) = output {
            if !pos.is_ghost && bytes.len() >= 32 {
                pos.enc_pnl.copy_from_slice(&bytes[..32]);
            }
        }

        pos.is_open   = false;
        pos.closed_at = Clock::get()?.unix_timestamp;

        emit!(PositionClosed {
            owner:      pos.owner,
            position_id: pos.key(),
            exit_price: pos.exit_price,
            is_ghost:   pos.is_ghost,
            timestamp:  pos.closed_at,
        });
        Ok(())
    }

    // ══════════════════════════════════════════════════════════════════════════
    // LIQUIDATE POSITION
    // ══════════════════════════════════════════════════════════════════════════

    pub fn liquidate_position(
        ctx: Context<LiquidatePosition>,
        _position_id: u64,
        exit_price:   u64,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.is_open, PrivatePerpsError::PositionNotOpen);

        pos.is_open    = false;
        pos.exit_price = exit_price;
        pos.closed_at  = Clock::get()?.unix_timestamp;

        emit!(PositionLiquidated {
            owner:      pos.owner,
            position_id: pos.key(),
            exit_price,
            timestamp:  pos.closed_at,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct Position {
    pub owner:              Pubkey,
    pub position_id:        u64,
    pub is_open:            bool,
    pub is_ghost:           bool,
    pub opened_at:          i64,
    pub closed_at:          i64,
    pub exit_price:         u64,
    pub computation_offset: u64,
    pub enc_entry_price:    [u8; 32],
    pub enc_size:           [u8; 32],
    pub enc_leverage:       [u8; 32],
    pub enc_side:           [u8; 32],
    pub enc_pnl:            [u8; 32],
}

impl Position {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 32 + 32 + 32 + 32 + 32;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMP DEF INIT CONTEXTS
// ─────────────────────────────────────────────────────────────────────────────

#[init_computation_definition_accounts("open_position", payer)]
#[derive(Accounts)]
pub struct InitOpenPositionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("check_liquidation", payer)]
#[derive(Accounts)]
pub struct InitCheckLiquidationCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("compute_pnl", payer)]
#[derive(Accounts)]
pub struct InitComputePnlCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE COMPUTATION CONTEXTS
// mempool_account, executing_pool, computation_account = UncheckedAccount
// (validation.rs: is_valid_mempool_acc_type = is_valid_unchecked_account)
// ─────────────────────────────────────────────────────────────────────────────

#[queue_computation_accounts("open_position", payer)]
#[derive(Accounts)]
#[instruction(position_id: u64, computation_offset: u64)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut, address = derive_mempool_pda!())]
    /// CHECK: mempool account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!())]
    /// CHECK: executing pool account
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset))]
    /// CHECK: computation account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(OPEN_POSITION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, StakingPoolAccount>>,
    #[account(address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = Position::LEN,
        seeds = [b"position", payer.key().as_ref(), &position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
}

#[callback_accounts("open_position", payer)]
#[derive(Accounts)]
pub struct OpenPositionCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(OPEN_POSITION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub position: Account<'info, Position>,
}

#[queue_computation_accounts("open_position", payer)]
#[derive(Accounts)]
#[instruction(position_id: u64, computation_offset: u64)]
pub struct OpenGhostPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut, address = derive_mempool_pda!())]
    /// CHECK: mempool account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!())]
    /// CHECK: executing pool account
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset))]
    /// CHECK: computation account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(OPEN_POSITION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, StakingPoolAccount>>,
    #[account(address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = Position::LEN,
        seeds = [b"position", payer.key().as_ref(), &position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
}

#[callback_accounts("open_ghost_position", payer)]
#[derive(Accounts)]
pub struct OpenGhostPositionCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(OPEN_POSITION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub position: Account<'info, Position>,
}

#[queue_computation_accounts("check_liquidation", payer)]
#[derive(Accounts)]
#[instruction(position_id: u64, computation_offset: u64)]
pub struct CheckLiquidation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut, address = derive_mempool_pda!())]
    /// CHECK: mempool account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!())]
    /// CHECK: executing pool account
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset))]
    /// CHECK: computation account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(CHECK_LIQUIDATION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, StakingPoolAccount>>,
    #[account(address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"position", payer.key().as_ref(), &position_id.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
}

#[callback_accounts("check_liquidation", payer)]
#[derive(Accounts)]
pub struct CheckLiquidationCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(CHECK_LIQUIDATION_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub position: Account<'info, Position>,
}

#[queue_computation_accounts("compute_pnl", payer)]
#[derive(Accounts)]
#[instruction(position_id: u64, computation_offset: u64)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut, address = derive_mempool_pda!())]
    /// CHECK: mempool account
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!())]
    /// CHECK: executing pool account
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset))]
    /// CHECK: computation account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMPUTE_PNL_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, StakingPoolAccount>>,
    #[account(address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"position", payer.key().as_ref(), &position_id.to_le_bytes()],
        bump,
        close = payer,
    )]
    pub position: Account<'info, Position>,
}

#[callback_accounts("close_position", payer)]
#[derive(Accounts)]
pub struct ClosePositionCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMPUTE_PNL_COMP_DEF_OFFSET))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub position: Account<'info, Position>,
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
pub struct PositionQueued {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub timestamp:   i64,
}

#[event]
pub struct PositionOpened {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub timestamp:   i64,
}

#[event]
pub struct GhostPositionOpened {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub timestamp:   i64,
}

#[event]
pub struct LiquidationChecked {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub timestamp:   i64,
}

#[event]
pub struct PositionClosed {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub exit_price:  u64,
    pub is_ghost:    bool,
    pub timestamp:   i64,
}

#[event]
pub struct PositionLiquidated {
    pub owner:       Pubkey,
    pub position_id: Pubkey,
    pub exit_price:  u64,
    pub timestamp:   i64,
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
