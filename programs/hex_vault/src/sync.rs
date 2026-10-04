//! Sync arithmetic: the split of a venue gain and its effect on the Pool
//! (yield-claimer ticket 05, ADR 0017). Pure: no accounts, no clock, no CPI.
//! The instruction-level sync values the venue, then calls [`apply_sync`].

use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, MAX_YIELD_FEE_BPS, SECONDS_PER_YEAR};
use crate::errors::HexVaultError;
use crate::state::{Player, Pool};
use crate::weight;

/// Scale of `Pool::yield_index`: depositor share per unit of Principal.
pub const INDEX_SCALE: u128 = 1_000_000_000_000_000_000;

/// One gain, split three ways. `fee + depositor + prize == gain`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GainSplit {
    pub fee: u64,
    pub depositor: u64,
    pub prize: u64,
    /// Rise in `Pool::yield_index` that pays `depositor`.
    pub index_delta: u128,
}

/// What one sync did. `ran` is false for a second sync in the same second.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub ran: bool,
    pub gain: u64,
    pub loss: u64,
    pub split: GainSplit,
}

/// Splits `gain` into fee, depositor share and prize.
///
/// The fee rate is clamped to `MAX_YIELD_FEE_BPS`. The depositor share is the
/// rest, capped at the base rate over `elapsed_secs`; the surplus is the prize.
/// `index_delta` rounds down, so the index never credits more than `depositor`
/// across all Principal. The rounding dust stays in `yield_owed`, unclaimed.
pub fn split_gain(
    gain: u64,
    fee_bps: u16,
    total_principal: u64,
    base_rate_bps: u16,
    elapsed_secs: u64,
) -> GainSplit {
    let fee_bps = fee_bps.min(MAX_YIELD_FEE_BPS) as u128;
    let fee = (gain as u128 * fee_bps / BPS_DENOMINATOR as u128) as u64;
    let rest = gain - fee;
    // The ceiling product can pass u128 for a huge `elapsed_secs`; a saturated
    // ceiling is far above any `rest`, so it never binds wrongly.
    let ceiling = (total_principal as u128)
        .checked_mul(base_rate_bps as u128)
        .and_then(|v| v.checked_mul(elapsed_secs as u128))
        .map_or(u128::MAX, |v| v / (BPS_DENOMINATOR as u128 * SECONDS_PER_YEAR));
    let depositor = if total_principal == 0 {
        0
    } else {
        (rest as u128).min(ceiling) as u64
    };
    let index_delta = if total_principal == 0 {
        0
    } else {
        // depositor < 2^64 and INDEX_SCALE < 2^60, so this fits u128.
        depositor as u128 * INDEX_SCALE / total_principal as u128
    };
    GainSplit {
        fee,
        depositor,
        prize: rest - depositor,
        index_delta,
    }
}

/// Moves the Pool to `value_now` at `now` and books any gain.
pub fn apply_sync(pool: &mut Pool, value_now: u64, now: i64) -> Result<SyncOutcome> {
    if now <= pool.last_sync_at {
        return Ok(SyncOutcome::default());
    }
    let elapsed = (now - pool.last_sync_at) as u64;
    let before = pool.venue_value;
    let mut out = SyncOutcome {
        ran: true,
        ..SyncOutcome::default()
    };
    if value_now > before {
        let gain = value_now - before;
        let split = split_gain(
            gain,
            pool.yield_fee_bps,
            pool.total_principal,
            pool.base_rate_bps,
            elapsed,
        );
        let overflow = HexVaultError::ArithmeticOverflow;
        let yield_index = pool
            .yield_index
            .checked_add(split.index_delta)
            .ok_or(overflow)?;
        let fee_owed = pool.fee_owed.checked_add(split.fee).ok_or(overflow)?;
        let yield_owed = pool.yield_owed.checked_add(split.depositor).ok_or(overflow)?;
        let prize_owed = pool.prize_owed.checked_add(split.prize).ok_or(overflow)?;
        pool.yield_index = yield_index;
        pool.fee_owed = fee_owed;
        pool.yield_owed = yield_owed;
        pool.prize_owed = prize_owed;
        out.gain = gain;
        out.split = split;
    } else if value_now < before {
        // Dust only for now. Ticket 10 adds the loss tolerance, `impaired`
        // and `deficit`.
        let loss = before - value_now;
        pool.fee_owed = pool.fee_owed.saturating_sub(loss);
        out.loss = loss;
    }
    pool.venue_value = value_now;
    pool.last_sync_at = now;
    Ok(out)
}

/// Pays `player` its share of the Yield index rise since its last settle and
/// returns the amount. Call after sync, and after `touch` (ADR 0017).
///
/// `touch` runs first because the Weight credit below lands in the current
/// epoch: a stale Player must be reset into it before its new Tickets count.
/// The result does not depend on the order, since `touch` sets Tickets to the
/// Principal it sees and settle then adds `owed` to both.
///
/// owed = floor(principal x (pool index - player index) / 1e18).
/// - The House never earns. It holds no Principal, and the early return keeps
///   it that way even if a later change ever gave it some.
/// - Zero Principal jumps to the current index, so an arrival or an empty
///   Player earns nothing from the past.
/// - Owed of zero leaves the stored index alone, so a small balance adds up
///   across settles instead of losing each fraction.
/// - Otherwise `owed` moves from `yield_owed` into Principal,
///   `total_principal` and Tickets, and the stored index catches up.
pub fn settle(pool: &mut Pool, player: &mut Player, now: i64) -> Result<u64> {
    if player.is_house {
        return Ok(0);
    }
    if player.principal == 0 {
        player.yield_index = pool.yield_index;
        return Ok(0);
    }
    let overflow = HexVaultError::ArithmeticOverflow;
    let rise = pool
        .yield_index
        .checked_sub(player.yield_index)
        .ok_or(overflow)?;
    let owed = (player.principal as u128)
        .checked_mul(rise)
        .ok_or(overflow)?
        / INDEX_SCALE;
    let owed = u64::try_from(owed).map_err(|_| overflow)?;
    if owed == 0 {
        return Ok(0);
    }
    let yield_owed = pool.yield_owed.checked_sub(owed).ok_or(overflow)?;
    let principal = player.principal.checked_add(owed).ok_or(overflow)?;
    let entries = player.entries.checked_add(owed).ok_or(overflow)?;
    let total_principal = pool.total_principal.checked_add(owed).ok_or(overflow)?;
    pool.yield_owed = yield_owed;
    pool.total_principal = total_principal;
    player.principal = principal;
    player.entries = entries;
    player.yield_index = pool.yield_index;
    weight::credit_tickets(pool, player, owed, now)?;
    Ok(owed)
}

/// [`settle`] for an instruction that is about to add Principal (deposit,
/// payout). A settle that rounds to zero leaves the stored index behind, and
/// Principal added on top of a stale index would earn the rise from before it
/// arrived. So the index is brought current here, which drops the fraction
/// of a unit that settle was holding back. Withdrawals do not need this: less
/// Principal against a stale index can only under-pay.
pub fn settle_before_growth(pool: &mut Pool, player: &mut Player, now: i64) -> Result<u64> {
    let owed = settle(pool, player, now)?;
    if !player.is_house {
        player.yield_index = pool.yield_index;
    }
    Ok(owed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::touch::tests::zeroed;

    /// SplitMix64, same shape as `weight_tree_proto`.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    const YEAR: u64 = 31_536_000;

    fn pool(principal: u64, fee_bps: u16, rate_bps: u16) -> Pool {
        let mut p: Pool = zeroed(Pool::INIT_SPACE);
        p.total_principal = principal;
        p.yield_fee_bps = fee_bps;
        p.base_rate_bps = rate_bps;
        p
    }

    #[test]
    fn ceiling_not_binding_sends_rest_to_depositors() {
        // gain 1000, fee 10% = 100, rest 900. Ceiling: 1e9 x 1000 bps x 1y = 1e8.
        let s = split_gain(1_000, 1_000, 1_000_000_000, 1_000, YEAR);
        assert_eq!((s.fee, s.depositor, s.prize), (100, 900, 0));
        // 900 x 1e18 / 1e9 = 9e11
        assert_eq!(s.index_delta, 900_000_000_000);
    }

    #[test]
    fn ceiling_binding_sends_surplus_to_prize() {
        // Ceiling: 1_000_000 x 1000 bps x 1y = 100_000. Gain 1_000_000, fee 100_000.
        let s = split_gain(1_000_000, 1_000, 1_000_000, 1_000, YEAR);
        assert_eq!((s.fee, s.depositor, s.prize), (100_000, 100_000, 800_000));
        assert_eq!(s.index_delta, INDEX_SCALE / 10);
    }

    #[test]
    fn zero_principal_sends_rest_to_prize() {
        let s = split_gain(1_000, 1_000, 0, 1_000, YEAR);
        assert_eq!((s.fee, s.depositor, s.prize, s.index_delta), (100, 0, 900, 0));
    }

    #[test]
    fn fee_above_cap_is_the_cap() {
        let capped = split_gain(10_000, MAX_YIELD_FEE_BPS, 0, 0, 1);
        assert_eq!(capped.fee, 2_000);
        assert_eq!(split_gain(10_000, u16::MAX, 0, 0, 1), capped);
    }

    #[test]
    fn huge_elapsed_does_not_overflow() {
        let s = split_gain(u64::MAX, 0, u64::MAX, u16::MAX, u64::MAX);
        assert_eq!((s.fee, s.depositor, s.prize), (0, u64::MAX, 0));
    }

    #[test]
    fn rounding_never_credits_more_than_the_gain() {
        let mut rng = Rng(7);
        for _ in 0..20_000 {
            let gain = rng.next() >> rng.below(64);
            let principal = rng.next() >> rng.below(64);
            let fee_bps = rng.below(10_001) as u16;
            let rate = rng.below(20_001) as u16;
            let elapsed = rng.next() >> rng.below(64);
            let s = split_gain(gain, fee_bps, principal, rate, elapsed);
            assert_eq!(
                s.fee as u128 + s.depositor as u128 + s.prize as u128,
                gain as u128
            );
            let credited = s.index_delta * principal as u128 / INDEX_SCALE;
            assert!(credited <= s.depositor as u128, "{gain} {principal} {s:?}");
        }
    }

    #[test]
    fn conservation_over_random_sync_sequences() {
        for seed in 0..200 {
            let mut rng = Rng(seed);
            let mut p = pool(rng.next() >> 20, rng.below(3_000) as u16, 500);
            let mut now = 0i64;
            let mut gained = 0u128;
            for _ in 0..50 {
                now += rng.below(2 * YEAR / 50) as i64;
                let before = p.venue_value;
                let value = if rng.below(4) == 0 {
                    before.saturating_sub(rng.below(1_000_000))
                } else {
                    before.saturating_add(rng.below(1 << 40))
                };
                let out = apply_sync(&mut p, value, now).unwrap();
                gained += out.gain as u128;
                let owed = p.fee_owed as u128 + p.yield_owed as u128 + p.prize_owed as u128;
                assert!(owed <= gained, "seed {seed}");
                assert!(!p.impaired && p.deficit == 0);
            }
        }
    }

    #[test]
    fn second_sync_in_same_second_changes_nothing() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        apply_sync(&mut p, 5_000, 100).unwrap();
        let (value, owed, index) = (p.venue_value, p.fee_owed, p.yield_index);
        let out = apply_sync(&mut p, 9_999, 100).unwrap();
        assert_eq!(out, SyncOutcome::default());
        assert_eq!((p.venue_value, p.fee_owed, p.yield_index), (value, owed, index));
        assert_eq!(p.last_sync_at, 100);
        // An earlier clock is also a no-op.
        assert!(!apply_sync(&mut p, 9_999, 50).unwrap().ran);
        assert_eq!(p.venue_value, 5_000);
    }

    #[test]
    fn long_gap_splits_against_the_longer_ceiling() {
        let mut p = pool(1_000_000, 0, 1_000);
        p.venue_value = 1_000;
        p.last_sync_at = 1;
        // One year later the ceiling is 100_000, so a 50_000 gain all goes to depositors.
        let out = apply_sync(&mut p, 51_000, 1 + YEAR as i64).unwrap();
        assert_eq!((out.split.depositor, out.split.prize), (50_000, 0));
        // Ten seconds later the ceiling is 100_000 x 10 / YEAR = 0, all to the prize.
        let out = apply_sync(&mut p, 61_000, 11 + YEAR as i64).unwrap();
        assert_eq!((out.split.depositor, out.split.prize), (0, 10_000));
        assert_eq!((p.yield_owed, p.prize_owed), (50_000, 10_000));
    }

    #[test]
    fn a_fall_only_reduces_fee_owed() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        p.venue_value = 10_000;
        p.fee_owed = 30;
        p.last_sync_at = 5;
        let out = apply_sync(&mut p, 9_980, 6).unwrap();
        assert_eq!((out.ran, out.gain, out.loss), (true, 0, 20));
        assert_eq!((p.fee_owed, p.venue_value), (10, 9_980));
        apply_sync(&mut p, 5_000, 7).unwrap();
        assert_eq!(p.fee_owed, 0);
        assert!(!p.impaired && p.deficit == 0);
        assert_eq!((p.yield_owed, p.prize_owed, p.yield_index), (0, 0, 0));
    }

    #[test]
    fn first_sync_with_nothing_just_stamps_the_time() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        let out = apply_sync(&mut p, 0, 1_700_000_000).unwrap();
        assert_eq!(out, SyncOutcome { ran: true, ..SyncOutcome::default() });
        assert_eq!(p.last_sync_at, 1_700_000_000);
        assert_eq!((p.venue_value, p.fee_owed, p.yield_owed, p.prize_owed), (0, 0, 0, 0));
    }

    fn player(principal: u64, index: u128) -> Player {
        let mut p: Player = zeroed(Player::INIT_SPACE);
        p.principal = principal;
        p.entries = principal;
        p.yield_index = index;
        p
    }

    #[test]
    fn a_stale_index_pays_the_rise_into_principal_total_and_tickets() {
        let mut pool = pool(1_000, 0, 0);
        pool.yield_index = INDEX_SCALE / 2;
        pool.yield_owed = 500;
        let mut p = player(1_000, 0);
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 500);
        assert_eq!((p.principal, p.entries), (1_500, 1_500));
        assert_eq!((pool.total_principal, pool.yield_owed), (1_500, 0));
        assert_eq!(p.yield_index, pool.yield_index);
        // Settling again at the same index owes nothing.
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 0);
        assert_eq!(p.principal, 1_500);
    }

    #[test]
    fn zero_principal_jumps_to_the_current_index_and_earns_nothing() {
        let mut pool = pool(1_000, 0, 0);
        pool.yield_index = 7 * INDEX_SCALE;
        pool.yield_owed = 100;
        let mut p = player(0, 0);
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 0);
        assert_eq!(p.yield_index, 7 * INDEX_SCALE);
        assert_eq!((p.principal, pool.total_principal, pool.yield_owed), (0, 1_000, 100));
    }

    #[test]
    fn a_settle_that_rounds_to_zero_keeps_the_index_so_the_balance_accumulates() {
        let mut pool = pool(10, 0, 0);
        pool.yield_owed = 10;
        let mut p = player(10, 0);
        // 10 x 0.05 = 0.5, floors to 0: nothing moves and the index stays.
        pool.yield_index = INDEX_SCALE / 20;
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 0);
        assert_eq!((p.yield_index, p.principal, pool.yield_owed), (0, 10, 10));
        // 10 x 0.15 = 1.5 against the unchanged index floors to 1, not 0 + 1.
        pool.yield_index = 3 * INDEX_SCALE / 20;
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 1);
        assert_eq!((p.principal, p.yield_index), (11, pool.yield_index));
        assert_eq!((pool.total_principal, pool.yield_owed), (11, 9));
    }

    #[test]
    fn the_house_never_earns() {
        let mut pool = pool(1_000, 0, 0);
        pool.yield_index = INDEX_SCALE;
        pool.yield_owed = 1_000;
        // Even if it somehow held Principal.
        let mut house = player(500, 0);
        house.is_house = true;
        assert_eq!(settle(&mut pool, &mut house, 0).unwrap(), 0);
        assert_eq!((house.principal, house.entries, house.yield_index), (500, 500, 0));
        assert_eq!((pool.total_principal, pool.yield_owed), (1_000, 1_000));
    }

    #[test]
    fn principal_added_after_a_zero_settle_does_not_earn_the_past() {
        let mut pool = pool(1_000_000, 0, 0);
        pool.yield_owed = 1_000_000;
        pool.yield_index = INDEX_SCALE / 2; // 1 unit x 0.5 floors to 0
        let mut p = player(1, 0);
        assert_eq!(settle_before_growth(&mut pool, &mut p, 0).unwrap(), 0);
        assert_eq!(p.yield_index, pool.yield_index);
        p.principal += 1_000_000;
        // With no new gain, the larger balance owes nothing.
        assert_eq!(settle(&mut pool, &mut p, 0).unwrap(), 0);
        assert_eq!((p.principal, pool.yield_owed), (1_000_001, 1_000_000));
        // Plain settle on the same stale index would have paid 500,000.
        let mut q = player(1, 0);
        assert_eq!(settle(&mut pool, &mut q, 0).unwrap(), 0);
        q.principal += 1_000_000;
        assert_eq!(settle(&mut pool, &mut q, 0).unwrap(), 500_000);
    }

    #[test]
    fn conservation_over_random_deposits_gains_and_settles() {
        for seed in 0..200 {
            let mut rng = Rng(seed);
            let mut pool = pool(0, rng.below(3_000) as u16, 500);
            let mut players: Vec<Player> = Vec::new();
            let (mut now, mut gained, mut settled) = (0i64, 0u128, 0u128);
            for _ in 0..80 {
                now += 1 + rng.below(YEAR / 20) as i64;
                // Same shape as the instructions: sync, then settle, then the change.
                let before = pool.venue_value;
                let value = before.saturating_add(rng.below(1 << 30));
                gained += apply_sync(&mut pool, value, now).unwrap().gain as u128;
                let i = rng.below(players.len() as u64 + 1) as usize;
                if i == players.len() {
                    players.push(player(0, pool.yield_index));
                }
                settled += settle(&mut pool, &mut players[i], now).unwrap() as u128;
                if rng.below(3) == 0 {
                    let d = rng.below(1 << 30);
                    players[i].principal += d;
                    players[i].entries += d;
                    pool.total_principal += d;
                } else if rng.below(3) == 0 {
                    let d = rng.below(players[i].principal + 1);
                    players[i].principal -= d;
                    players[i].entries = players[i].entries.saturating_sub(d);
                    pool.total_principal -= d;
                }
                let owed = pool.fee_owed as u128 + pool.yield_owed as u128 + pool.prize_owed as u128;
                assert!(settled + owed <= gained, "seed {seed}");
                // Settled yield plus what is still owed to depositors is the depositor share.
                let sum: u64 = players.iter().map(|p| p.principal).sum();
                assert_eq!(sum, pool.total_principal, "seed {seed}");
            }
        }
    }
}
