//! The yield venue behind three operations: `value`, `deposit`, `redeem`
//! (yield-claimer ticket 05, spec "Venue module"). Nothing else in the
//! program knows which venue it is.
//!
//! Every operation first checks the four accounts it was handed against the
//! addresses pinned on the Pool, then goes to the backing. Under `test-venue`
//! that is the stub in `test_venue.rs`. Without it there is no backing yet and
//! each operation fails with `VenueUnavailable`. Ticket 12 adds klend as a
//! second backing behind the same three functions and reads its extra
//! accounts from [`Venue::remaining`].

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::HexVaultError;
use crate::events::Synced;
use crate::state::Pool;
use crate::sync::{apply_sync, SyncOutcome};
use crate::utils;

/// The four accounts every venue-touching instruction names, plus whatever
/// else the backing needs.
pub struct Venue<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub market: &'a AccountInfo<'info>,
    /// Writable: a deposit or redeem changes it.
    pub reserve: &'a AccountInfo<'info>,
    /// Writable: the venue's token position for this pool.
    pub ctoken: &'a AccountInfo<'info>,
    pub remaining: &'a [AccountInfo<'info>],
}

/// What a deposit or redeem moves USDC through: the pool's principal vault,
/// the mint for `transfer_checked`, and the token program.
pub struct Funds<'a, 'info> {
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
}

impl Venue<'_, '_> {
    /// Refuses any account that is not the one the Admin pinned at
    /// `create_pool`. No instruction accepts another reserve.
    pub fn check(&self, pool: &Pool) -> Result<()> {
        require!(
            self.program.key() == pool.klend_program
                && self.market.key() == pool.klend_market
                && self.reserve.key() == pool.klend_reserve
                && self.ctoken.key() == pool.klend_ctoken,
            HexVaultError::VenueMismatch
        );
        Ok(())
    }
}

#[cfg(feature = "test-venue")]
mod backing {
    pub use crate::test_venue::{stub_deposit as deposit, stub_redeem as redeem, stub_value as value};
}

#[cfg(not(feature = "test-venue"))]
mod backing {
    use super::*;

    pub fn value(_pool: &Pool, _venue: &Venue) -> Result<u64> {
        err!(HexVaultError::VenueUnavailable)
    }

    pub fn deposit<'info>(
        _pool: &Account<'info, Pool>,
        _venue: &Venue<'_, 'info>,
        _funds: &Funds<'_, 'info>,
        _amount: u64,
    ) -> Result<()> {
        err!(HexVaultError::VenueUnavailable)
    }

    pub fn redeem<'info>(
        _pool: &Account<'info, Pool>,
        _venue: &Venue<'_, 'info>,
        _funds: &Funds<'_, 'info>,
        _amount: u64,
    ) -> Result<()> {
        err!(HexVaultError::VenueUnavailable)
    }
}

/// The pool's position in USDC atomic units, read fresh: the backing makes
/// the venue current first, so a caller never asks for a refresh.
pub fn value(pool: &Pool, venue: &Venue<'_, '_>) -> Result<u64> {
    venue.check(pool)?;
    backing::value(pool, venue)
}

/// Moves `amount` USDC from the principal vault into the venue, the pool PDA
/// signing.
pub fn deposit<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    venue.check(pool)?;
    backing::deposit(pool, venue, funds, amount)
}

/// Moves `amount` USDC from the venue back into the principal vault.
pub fn redeem<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    venue.check(pool)?;
    backing::redeem(pool, venue, funds, amount)
}

/// Instruction-level sync: values the venue, then books any gain on the Pool
/// (`sync::apply_sync`). Every instruction that must see current yield calls
/// this first; ticket 05 wires it into `deploy_to_venue` and `test_sync`.
///
/// Returns the outcome and the value read, which `deploy_to_venue` needs to
/// tell the rise its own deposit caused from anything unbooked.
pub fn sync<'info>(
    pool: &mut Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
) -> Result<(SyncOutcome, u64)> {
    let read = value(pool, venue)?;
    let outcome = apply_sync(pool, read, utils::now()?)?;
    if outcome.ran && outcome.gain > 0 {
        emit!(Synced {
            pool: pool.key(),
            gain: outcome.gain,
            fee: outcome.split.fee,
            depositor_share: outcome.split.depositor,
            prize_share: outcome.split.prize,
            yield_index: pool.yield_index,
            venue_value: pool.venue_value,
        });
    }
    Ok((outcome, read))
}
