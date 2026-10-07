//! Proposing and cancelling a venue change (venue-switch ticket 03, spec
//! "Venue switch"). The proposal is its own PDA from the pool. While it
//! exists `deploy_to_venue` refuses with `VenueProposalOpen`. Ticket 05 reads
//! `VENUE_LOCK_SECONDS` and closes the account when it migrates.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    venue_kind, SEED_POOL, SEED_PRINCIPAL, SEED_VENUE_PROPOSAL, VENUE_LOCK_SECONDS,
};
use crate::errors::HexVaultError;
use crate::events::{VenueDrained, VenueProposalCancelled, VenueProposed};
use crate::state::{Pool, VenueProposal};
use crate::venue::{self, Funds, Venue};

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

/// Venue-switch ticket 04. Syncs, then redeems `amount` from the current venue
/// into the principal vault. The USDC never leaves the program, which is why
/// the Admin and the Operator may do it at any time (the emergency park) and
/// anyone may while a proposal is open (the Operator's crank, and a way out if
/// the keys are gone).
///
/// The venue value drops by what came back. A klend reserve that cannot pay
/// fails `VenueIlliquid` and nothing moves. A venue that returns less than
/// asked (a vault) books only what came back, so the rest shows at the next
/// sync as the loss it is.
pub fn drain_venue<'info>(ctx: Context<'info, DrainVenue<'info>>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };

    let (_, read) = venue::sync(&mut a.pool, &venue)?;

    let signer = a.signer.key();
    let proposal_open = a.venue_proposal.owner == &crate::ID;
    require!(
        signer == a.pool.admin || signer == a.pool.operator || proposal_open,
        HexVaultError::Unauthorized
    );
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(amount <= read, HexVaultError::VenueIlliquid);

    let before = a.principal_vault.amount;
    let funds = Funds {
        vault: &a.principal_vault,
        mint: &a.accepted_mint,
        token_program: &a.token_program,
    };
    venue::redeem(&a.pool, &venue, &funds, amount)?;
    let after = venue::value(&a.pool, &venue)?;
    let fall = read.saturating_sub(after);
    a.principal_vault.reload()?;
    let received = a.principal_vault.amount.saturating_sub(before);

    let pool = &mut a.pool;
    if received < amount {
        pool.venue_value = pool.venue_value.saturating_sub(received);
    } else {
        // As in `recall`: what the value fell by beyond what arrived is
        // rounding dust and comes off the fee owed, floored at zero.
        pool.venue_value = pool.venue_value.saturating_sub(fall);
        pool.fee_owed = pool.fee_owed.saturating_sub(fall.saturating_sub(received));
    }

    emit!(VenueDrained {
        pool: pool.key(),
        asked: amount,
        received,
        venue_value: pool.venue_value,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DrainVenue<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: `venue::check` pins it to `pool.klend_program`.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_market`.
    pub klend_market: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_reserve`.
    #[account(mut)]
    pub klend_reserve: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_ctoken`.
    #[account(mut)]
    pub klend_ctoken: UncheckedAccount<'info>,

    /// CHECK: the pool's venue proposal PDA, which usually does not exist.
    /// Only its address and owner are read: a program-owned account opens the
    /// drain to anyone.
    #[account(seeds = [SEED_VENUE_PROPOSAL, pool.key().as_ref()], bump)]
    pub venue_proposal: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
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
