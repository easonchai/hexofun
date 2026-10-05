//! The yield venue behind three operations: `value`, `deposit`, `redeem`
//! (yield-claimer ticket 05, spec "Venue module"). Nothing else in the
//! program knows which venue it is.
//!
//! Every operation first checks the four accounts it was handed against the
//! addresses pinned on the Pool, then goes to the backing. Under `test-venue`
//! that is the stub in `test_venue.rs`. Without it, it is klend through
//! `klend.rs` (ticket 12), which reads its extra accounts from
//! [`Venue::remaining`].

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{impaired_cause, BPS_DENOMINATOR};
use crate::errors::HexVaultError;
use crate::events::{ImpairedCleared, ImpairedSet, Synced};
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
    pub use crate::test_venue::{
        stub_deposit as deposit, stub_redeem as redeem, stub_reserve_stats as reserve_stats,
        stub_value as value,
    };
}

#[cfg(not(feature = "test-venue"))]
#[path = "klend.rs"]
mod klend;

#[cfg(not(feature = "test-venue"))]
mod backing {
    pub use super::klend::{deposit, redeem, reserve_stats, value};
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
            deficit_repaid: outcome.deficit_repaid,
        });
    }
    if outcome.deficit_added > 0 {
        emit!(ImpairedSet {
            pool: pool.key(),
            loss: outcome.loss,
            prize_absorbed: outcome.prize_absorbed,
            fee_absorbed: outcome.fee_absorbed,
            deficit: pool.deficit,
        });
    }
    if outcome.cleared {
        emit!(ImpairedCleared {
            pool: pool.key(),
            deficit: outcome.deficit_repaid,
            cause: impaired_cause::GAIN,
        });
    }
    Ok((outcome, read))
}

/// What `deploy_to_venue` needs to know about the reserve, in USDC atomic
/// units: its total supply (available plus borrowed, less fees) and the
/// liquidity it can pay out now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReserveStats {
    pub supply: u64,
    pub available: u64,
}

/// The reserve's supply and free liquidity, read fresh. Only a deploy asks.
pub fn reserve_stats(pool: &Pool, venue: &Venue<'_, '_>) -> Result<ReserveStats> {
    venue.check(pool)?;
    backing::reserve_stats(pool, venue)
}

/// The two deploy caps (ticket 10), judged on the reserve as it will stand
/// once `amount` has gone in, since a deposit adds to both its supply and its
/// free liquidity. `position` is the pool's value in the venue before the
/// deploy.
///
/// - The pool's position may not pass `share_cap_bps` of the supply.
/// - The reserve's free liquidity must stay at least `floor_bps` of the pool's
///   position, so the pool can always leave.
pub fn check_deploy_caps(
    stats: ReserveStats,
    position: u64,
    amount: u64,
    share_cap_bps: u16,
    floor_bps: u16,
) -> Result<()> {
    let bps = u128::from(BPS_DENOMINATOR);
    let after = u128::from(position) + u128::from(amount);
    let supply = u128::from(stats.supply) + u128::from(amount);
    let available = u128::from(stats.available) + u128::from(amount);
    require!(
        after * bps <= supply * u128::from(share_cap_bps),
        HexVaultError::ReserveShareCapExceeded
    );
    require!(
        available * bps >= after * u128::from(floor_bps),
        HexVaultError::ReserveLiquidityTooLow
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATS: ReserveStats = ReserveStats {
        supply: 1_000_000,
        available: 300_000,
    };

    #[test]
    fn the_share_cap_is_judged_after_the_deploy_adds_to_supply() {
        // 500 bps: position + amount must be at most 5% of supply + amount.
        // 50,000 into 1,000,000 is 52,631 of 1,050,000 at the limit.
        assert!(check_deploy_caps(STATS, 0, 52_631, 500, 0).is_ok());
        assert!(check_deploy_caps(STATS, 0, 52_632, 500, 0).is_err());
        // Position already held counts.
        assert!(check_deploy_caps(STATS, 40_000, 10_526, 500, 0).is_ok());
        assert!(check_deploy_caps(STATS, 40_000, 10_527, 500, 0).is_err());
        // A zero cap refuses every deploy.
        assert!(check_deploy_caps(STATS, 0, 1, 0, 0).is_err());
    }

    #[test]
    fn the_liquidity_floor_is_judged_after_the_deploy_adds_to_liquidity() {
        // 20,000 bps: free liquidity (300,000 + amount) at least twice position.
        // Position 100,000 + 50,000 = 150,000 needs 300,000. Held.
        assert!(check_deploy_caps(STATS, 100_000, 50_000, 10_000, 20_000).is_ok());
        // A big position with little liquidity behind it is refused.
        assert!(check_deploy_caps(STATS, 400_000, 1_000, 10_000, 20_000).is_err());
        // 300,000 of position needs 600,000 of liquidity and has 400,000,
        // refused; 100,000 needs 200,000 and has 400,000.
        assert!(check_deploy_caps(STATS, 200_000, 100_000, 10_000, 20_000).is_err());
        assert!(check_deploy_caps(STATS, 0, 100_000, 10_000, 20_000).is_ok());
    }

    #[test]
    fn the_errors_are_named() {
        let err = check_deploy_caps(STATS, 0, 60_000, 500, 0).unwrap_err();
        assert!(format!("{err:?}").contains("ReserveShareCapExceeded"));
        let err = check_deploy_caps(STATS, 400_000, 1_000, 10_000, 20_000).unwrap_err();
        assert!(format!("{err:?}").contains("ReserveLiquidityTooLow"));
    }

    #[test]
    fn huge_reserves_do_not_overflow() {
        let big = ReserveStats {
            supply: u64::MAX,
            available: u64::MAX,
        };
        assert!(check_deploy_caps(big, u64::MAX, u64::MAX, 10_000, 10_000).is_ok());
    }
}
