//! Proposing and cancelling a venue change (venue-switch ticket 03, spec
//! "Venue switch"). The proposal is its own PDA from the pool. While it
//! exists `deploy_to_venue` refuses with `VenueProposalOpen`. Ticket 05 reads
//! `VENUE_LOCK_SECONDS` and closes the account when it migrates.

use anchor_lang::prelude::*;

use crate::constants::{venue_kind, SEED_POOL, SEED_VENUE_PROPOSAL, VENUE_LOCK_SECONDS};
use crate::errors::HexVaultError;
use crate::events::{VenueProposalCancelled, VenueProposed};
use crate::state::{Pool, VenueProposal};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeVenueArgs {
    pub venue_kind: u8,
    pub klend_program: Pubkey,
    pub klend_market: Pubkey,
    pub klend_reserve: Pubkey,
    pub klend_ctoken: Pubkey,
}

/// Admin only. Creates the proposal, or replaces the open one the way
/// `propose_admin` replaces a pending admin, and restarts the lock either way.
pub fn propose_venue(ctx: Context<ProposeVenue>, args: ProposeVenueArgs) -> Result<()> {
    // The same gate `create_pool` holds, so a proposal can never name a kind
    // this build cannot back.
    require!(
        venue_kind::supported(args.venue_kind),
        HexVaultError::UnsupportedVenueKind
    );
    // A default key would pin a venue nobody can ever pass.
    require!(
        args.klend_program != Pubkey::default()
            && args.klend_market != Pubkey::default()
            && args.klend_reserve != Pubkey::default()
            && args.klend_ctoken != Pubkey::default(),
        HexVaultError::InvalidParameter
    );

    let now = Clock::get()?.unix_timestamp;
    let proposal = &mut ctx.accounts.proposal;
    proposal.pool = ctx.accounts.pool.key();
    proposal.venue_kind = args.venue_kind;
    proposal.klend_program = args.klend_program;
    proposal.klend_market = args.klend_market;
    proposal.klend_reserve = args.klend_reserve;
    proposal.klend_ctoken = args.klend_ctoken;
    proposal.proposed_at = now;
    proposal.bump = ctx.bumps.proposal;

    emit!(VenueProposed {
        pool: proposal.pool,
        venue_kind: args.venue_kind,
        klend_program: args.klend_program,
        klend_market: args.klend_market,
        klend_reserve: args.klend_reserve,
        klend_ctoken: args.klend_ctoken,
        proposed_at: now,
        unlocks_at: now
            .checked_add(VENUE_LOCK_SECONDS)
            .ok_or(HexVaultError::ArithmeticOverflow)?,
    });
    Ok(())
}

/// Admin only. The `close = admin` constraint returns the rent.
pub fn cancel_venue(ctx: Context<CancelVenue>) -> Result<()> {
    let p = &ctx.accounts.proposal;
    emit!(VenueProposalCancelled {
        pool: p.pool,
        venue_kind: p.venue_kind,
        klend_program: p.klend_program,
        klend_market: p.klend_market,
        klend_reserve: p.klend_reserve,
        klend_ctoken: p.klend_ctoken,
        proposed_at: p.proposed_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeVenue<'info> {
    /// Pays the proposal's rent on the first proposal.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init_if_needed,
        payer = admin,
        seeds = [SEED_VENUE_PROPOSAL, pool.key().as_ref()],
        bump,
        space = 8 + VenueProposal::INIT_SPACE,
    )]
    pub proposal: Account<'info, VenueProposal>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelVenue<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        close = admin,
        seeds = [SEED_VENUE_PROPOSAL, pool.key().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, VenueProposal>,
}
