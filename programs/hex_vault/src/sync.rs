//! Sync arithmetic: the split of a venue gain and its effect on the Pool
//! (yield-claimer ticket 05, ADR 0017). Pure: no accounts, no clock, no CPI.
//! The instruction-level sync values the venue, then calls [`apply_sync`].

use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, MAX_YIELD_FEE_BPS, SECONDS_PER_YEAR};
use crate::errors::HexVaultError;
use crate::state::{Player, Pool};

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
///
/// `gain` is the whole rise. `deficit_repaid` took the first of it, and `split`
/// divides the rest. `loss` is the whole fall; `prize_absorbed` and
/// `fee_absorbed` are what the first-loss layers took of a loss past the
/// tolerance, and `deficit_added` is what was left for the deficit.
/// `cleared` is true when this sync took the deficit to zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub ran: bool,
    pub gain: u64,
    pub loss: u64,
    pub split: GainSplit,
    pub deficit_repaid: u64,
    pub prize_absorbed: u64,
    pub fee_absorbed: u64,
    pub deficit_added: u64,
    pub cleared: bool,
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
        // A recorded deficit is repaid before any split, so the fee, the
        // depositors and the prize see only what is left. The prize and fee
        // owed that a loss consumed are not restored.
        let deficit_repaid = gain.min(pool.deficit);
        let gain_left = gain - deficit_repaid;
        let split = split_gain(
            gain_left,
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
        if deficit_repaid > 0 {
            pool.deficit -= deficit_repaid;
            // A deficit under the tolerance never impaired the pool, so
            // repaying it clears nothing.
            if pool.deficit == 0 && pool.impaired {
                pool.impaired = false;
                out.cleared = true;
            }
        }
        // Running totals for the next harvest event (ticket 07). They only
        // describe history, so a saturated total is harmless: saturate rather
        // than fail a sync over a counter. They count what was split, so
        // `fee + depositor + prize` stays equal to `gain` there.
        pool.harvest_gain = pool.harvest_gain.saturating_add(gain_left);
        pool.harvest_fee = pool.harvest_fee.saturating_add(split.fee);
        pool.harvest_depositor = pool.harvest_depositor.saturating_add(split.depositor);
        pool.harvest_prize = pool.harvest_prize.saturating_add(split.prize);
        out.gain = gain;
        out.split = split;
        out.deficit_repaid = deficit_repaid;
    } else if value_now < before {
        let loss = before - value_now;
        out.loss = loss;
        // `loss_tolerance_bps` of the value is rounding dust: the fee owed
        // bears it and the rest is booked as deficit, but the pool stays
        // unimpaired. Without the booking, dust that `fee_owed` cannot cover
        // would add up unrecorded, sync after sync.
        let tolerance = u128::from(before) * u128::from(pool.loss_tolerance_bps)
            / u128::from(BPS_DENOMINATOR);
        if u128::from(loss) <= tolerance {
            out.fee_absorbed = loss.min(pool.fee_owed);
            out.deficit_added = absorb_dust(pool, loss)?;
        } else {
            // First loss: the prize share owed, then the fee owed. Only what
            // they cannot cover is recorded against depositors. The index
            // never falls.
            let prize_absorbed = loss.min(pool.prize_owed);
            let fee_absorbed = (loss - prize_absorbed).min(pool.fee_owed);
            let rest = loss - prize_absorbed - fee_absorbed;
            let deficit = pool.deficit.checked_add(rest).ok_or(HexVaultError::ArithmeticOverflow)?;
            pool.prize_owed -= prize_absorbed;
            pool.fee_owed -= fee_absorbed;
            pool.deficit = deficit;
            if rest > 0 {
                pool.impaired = true;
            }
            out.prize_absorbed = prize_absorbed;
            out.fee_absorbed = fee_absorbed;
            out.deficit_added = rest;
        }
    }
    pool.venue_value = value_now;
    pool.last_sync_at = now;
    Ok(out)
}

/// Charges `dust`, value a venue move lost to rounding, to the fee owed first
/// and books whatever the fee cannot cover as deficit, so a leak never goes
/// unrecorded. Does not touch `impaired`; the callers decide that. Returns the
/// part booked as deficit.
pub fn absorb_dust(pool: &mut Pool, dust: u64) -> Result<u64> {
    let from_fee = dust.min(pool.fee_owed);
    let rest = dust - from_fee;
    pool.deficit = pool.deficit.checked_add(rest).ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.fee_owed -= from_fee;
    Ok(rest)
}

/// Pays `player` its share of the Yield index rise since its last settle and
/// returns the amount. Call after sync, and after `touch` (ADR 0017).
///
/// Settled yield is fresh Principal, like a deposit: it raises Principal and
/// leaves Tickets alone, and counts as Tickets from the next epoch (ADR 0020).
/// So it makes no difference whether a Player's yield settled this epoch or
/// still sits in `yield_owed`, and yield earned on a pending deposit does not
/// become live Tickets in the deposit's own epoch.
///
/// `touch` runs first so a stale Player is reset into the current epoch. The
/// reset sets Tickets to the Principal it sees, which leaves out the `owed`
/// settle adds after it.
///
/// The caller owns the Weight tree side: `owed` is new Principal only, so it
/// goes into the instruction's [`crate::weight::Change`] with
/// [`crate::weight::Change::settled`].
///
/// owed = floor(principal x (pool index - player index) / 1e18).
/// - The House never earns. It holds no Principal, and the early return keeps
///   it that way even if a later change ever gave it some.
/// - Zero Principal jumps to the current index, so an arrival or an empty
///   Player earns nothing from the past.
/// - Owed of zero leaves the stored index alone, so a small balance adds up
///   across settles instead of losing each fraction.
/// - Otherwise `owed` moves from `yield_owed` into Principal and
///   `total_principal`, and the stored index catches up.
pub fn settle(pool: &mut Pool, player: &mut Player) -> Result<u64> {
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
    let total_principal = pool.total_principal.checked_add(owed).ok_or(overflow)?;
    pool.yield_owed = yield_owed;
    pool.total_principal = total_principal;
    player.principal = principal;
    player.yield_index = pool.yield_index;
    Ok(owed)
}

/// [`settle`] for an instruction that is about to add Principal (deposit,
/// payout). A settle that rounds to zero leaves the stored index behind, and
/// Principal added on top of a stale index would earn the rise from before it
/// arrived. So the index is brought current here, which drops the fraction
/// of a unit that settle was holding back. Withdrawals do not need this: less
/// Principal against a stale index can only under-pay.
pub fn settle_before_growth(pool: &mut Pool, player: &mut Player) -> Result<u64> {
    let owed = settle(pool, player)?;
    if !player.is_house {
        player.yield_index = pool.yield_index;
    }
    Ok(owed)
}

/// What a withdrawal of `amount` pays while the pool is impaired (ticket 10):
/// `floor(amount x net assets / total_principal)`, never more than `amount`. Net
/// assets are the vault balance plus the venue value, less every owed amount, so
/// the prize share and the fee have already taken their loss. Not impaired, it
/// is `amount`.
///
/// A queued withdrawal stays in `total_principal` until it pays (ADR 0020), so
/// Pending withdrawals are a reservation of idle USDC and not a claim beside it.
/// The denominator counts every claim once, queued or not, and the loss is
/// shared over all of it. The ticket 10 form added the queue to the denominator
/// because the queue had already left `total_principal`.
///
/// The refund, process and emergency withdraw all call this with the vault
/// balance as it stands before the call moves anything. A redeem from the
/// venue swaps venue value for vault balance, so it does not change the sum.
pub fn haircut(pool: &Pool, vault_balance: u64, amount: u64) -> u64 {
    // After shutdown the haircut applies even unimpaired. Dust booked as
    // deficit under the tolerance never set the flag, and a pool that pays at
    // par would leave the last depositor short. With no deficit the net
    // assets equal the claims, so this still pays `amount`. It needs no owner
    // signature, which `impaired` would.
    if !pool.impaired && !pool.shutdown {
        return amount;
    }
    let assets = u128::from(vault_balance) + u128::from(pool.venue_value);
    let owed = u128::from(pool.yield_owed) + u128::from(pool.fee_owed) + u128::from(pool.prize_owed);
    let net = assets.saturating_sub(owed);
    let claims = u128::from(pool.total_principal);
    if claims == 0 {
        return 0;
    }
    // Both factors are under 2^65, so the product fits.
    let pay = u128::from(amount) * net / claims;
    u64::try_from(pay).map_or(amount, |p| p.min(amount))
}

/// Takes `loss` (what a haircut withdrawal gave up, `amount - paid`) off the
/// recorded deficit. That share of the loss is realised and no later recovery
/// pays it back. Returns the deficit as it stood if this cleared `impaired`.
pub fn realise_loss(pool: &mut Pool, loss: u64) -> Option<u64> {
    if !pool.impaired || loss == 0 {
        return None;
    }
    let before = pool.deficit;
    pool.deficit = before.saturating_sub(loss);
    if pool.deficit == 0 {
        pool.impaired = false;
        return Some(before);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::DEFAULT_LOSS_TOLERANCE_BPS;
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
            p.loss_tolerance_bps = DEFAULT_LOSS_TOLERANCE_BPS;
            // Assets start equal to Principal, so the solvency identity is
            // exact at every step, dust included.
            p.venue_value = p.total_principal;
            let mut now = 0i64;
            for _ in 0..50 {
                now += 1 + rng.below(2 * YEAR / 50) as i64;
                let before = p.venue_value;
                let value = if rng.below(4) == 0 {
                    before.saturating_sub(rng.below(1_000_000))
                } else {
                    before.saturating_add(rng.below(1 << 40))
                };
                apply_sync(&mut p, value, now).unwrap();
                let owed = p.fee_owed as u128 + p.yield_owed as u128 + p.prize_owed as u128;
                // venue value + deficit = Principal + owed, and impaired
                // follows the deficit.
                assert_eq!(
                    p.venue_value as u128 + p.deficit as u128,
                    p.total_principal as u128 + owed,
                    "seed {seed}"
                );
                // Dust under the tolerance books a deficit without impairing.
                assert!(!p.impaired || p.deficit > 0, "seed {seed}");
            }
        }
    }

    #[test]
    fn a_fall_within_the_tolerance_is_dust_and_never_impairs() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        p.loss_tolerance_bps = 1;
        p.venue_value = 1_000_000;
        p.prize_owed = 500;
        p.last_sync_at = 5;
        // 1 bps of 1,000,000 is 100. A fall of 100 is still inside.
        let out = apply_sync(&mut p, 999_900, 6).unwrap();
        assert_eq!((out.loss, out.deficit_added, out.prize_absorbed), (100, 100, 0));
        assert_eq!((p.venue_value, p.prize_owed, p.deficit, p.impaired), (999_900, 500, 100, false));
        // 101 is past 1 bps of 999,900 (99), so it is a loss and the prize takes it.
        let out = apply_sync(&mut p, 999_799, 7).unwrap();
        assert_eq!((out.prize_absorbed, out.fee_absorbed, out.deficit_added), (101, 0, 0));
        assert_eq!((p.prize_owed, p.deficit, p.impaired), (399, 100, false));
    }

    #[test]
    fn a_loss_takes_prize_then_fee_and_only_the_rest_is_a_deficit() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        p.venue_value = 1_000_000;
        p.prize_owed = 300;
        p.fee_owed = 200;
        p.yield_owed = 50;
        p.yield_index = 7;
        p.last_sync_at = 5;
        let out = apply_sync(&mut p, 999_000, 6).unwrap();
        assert_eq!(out.loss, 1_000);
        assert_eq!((out.prize_absorbed, out.fee_absorbed, out.deficit_added), (300, 200, 500));
        assert_eq!((p.prize_owed, p.fee_owed, p.yield_owed), (0, 0, 50));
        assert_eq!((p.deficit, p.impaired, p.yield_index), (500, true, 7));
        // A second loss grows the deficit.
        let out = apply_sync(&mut p, 998_000, 7).unwrap();
        assert_eq!((out.deficit_added, p.deficit), (1_000, 1_500));
    }

    #[test]
    fn a_gain_repays_the_deficit_before_any_split() {
        let mut p = pool(1_000_000, 1_000, 10_000);
        p.venue_value = 998_000;
        p.deficit = 1_500;
        p.impaired = true;
        p.last_sync_at = 0;
        // 1,000 of gain, all of it to the deficit: no fee, no index move.
        let out = apply_sync(&mut p, 999_000, YEAR as i64).unwrap();
        assert_eq!((out.deficit_repaid, out.cleared, out.split), (1_000, false, GainSplit::default()));
        assert_eq!((p.deficit, p.impaired, p.fee_owed, p.yield_index), (500, true, 0, 0));
        // 2,000 more: 500 clears it and 1,500 splits, fee 150.
        let out = apply_sync(&mut p, 1_001_000, 2 * YEAR as i64).unwrap();
        assert_eq!((out.deficit_repaid, out.cleared), (500, true));
        assert_eq!((out.split.fee, out.split.depositor, out.split.prize), (150, 1_350, 0));
        assert_eq!((p.deficit, p.impaired, p.fee_owed, p.yield_owed), (0, false, 150, 1_350));
        assert_eq!(p.harvest_gain, 1_500);
    }

    #[test]
    fn after_shutdown_the_haircut_shares_booked_dust_without_impairing() {
        let mut p = pool(1_000, 0, 0);
        p.venue_value = 0;
        p.deficit = 10;
        // 990 in the vault against 1,000 of claims, not impaired.
        assert_eq!(haircut(&p, 990, 500), 500);
        p.shutdown = true;
        assert_eq!(haircut(&p, 990, 500), 495);
        // No deficit: par.
        p.deficit = 0;
        assert_eq!(haircut(&p, 1_000, 500), 500);
    }

    #[test]
    fn the_haircut_is_principal_times_net_assets_over_total_principal() {
        let mut p = pool(1_000, 0, 0);
        p.impaired = true;
        p.venue_value = 600;
        p.deficit = 250;
        p.yield_owed = 0;
        // vault 150 + venue 600 = 750 net, over 1,000 Principal.
        assert_eq!(haircut(&p, 150, 400), 300);
        assert_eq!(haircut(&p, 150, 1), 0, "rounds down");
        assert_eq!(haircut(&p, 150, 3), 2);
        // Every owed amount comes off the assets: 750 - 50 = 700 over 1,000. A
        // queued withdrawal sits inside `total_principal`, so it changes nothing.
        p.pending_withdrawals = 50;
        p.fee_owed = 10;
        p.prize_owed = 10;
        p.yield_owed = 30;
        assert_eq!(haircut(&p, 150, 1_000), 700);
        assert_eq!(haircut(&p, 150, 50), 35);
        p.pending_withdrawals = 0;
        assert_eq!(haircut(&p, 150, 50), 35);
        p.pending_withdrawals = 50;
        // Not impaired pays 1:1, and never more than asked.
        p.impaired = false;
        assert_eq!(haircut(&p, 150, 400), 400);
        p.impaired = true;
        p.venue_value = 10_000;
        assert_eq!(haircut(&p, 150, 400), 400);
    }

    #[test]
    fn queued_requests_share_the_assets_pro_rata_inside_total_principal() {
        // 1,000 of Principal, all of it queued. The queue is inside
        // `total_principal`, so the ratio is 680 over 1,000.
        let mut p = pool(1_000, 0, 0);
        p.impaired = true;
        p.pending_withdrawals = 1_000;
        p.venue_value = 200;
        p.fee_owed = 20;
        // 500 + 200 - 20 = 680.
        assert_eq!(haircut(&p, 500, 500), 340);
        // No Principal at all means no claim to pay.
        p.total_principal = 0;
        assert_eq!(haircut(&p, 500, 500), 0);
    }

    #[test]
    fn a_haircut_withdrawal_realises_its_share_and_exits_the_recovery() {
        // Principal 1,000, assets 750, deficit 250. Withdraw 400: paid 300,
        // loss 100, deficit 150. What is left holds 600 Principal on 450.
        let mut p = pool(1_000, 0, 0);
        p.impaired = true;
        p.deficit = 250;
        p.venue_value = 750;
        let paid = haircut(&p, 0, 400);
        assert_eq!(paid, 300);
        p.total_principal -= 400;
        p.venue_value -= paid;
        assert_eq!(realise_loss(&mut p, 400 - paid), None);
        assert_eq!(p.deficit, 150);
        assert_eq!(p.total_principal - p.venue_value, 150, "deficit stays Principal minus assets");
        // The rest leaves at the same ratio, and the last one clears it.
        let paid = haircut(&p, 0, 600);
        assert_eq!(paid, 450);
        p.total_principal = 0;
        p.venue_value = 0;
        assert_eq!(realise_loss(&mut p, 600 - paid), Some(150));
        assert_eq!((p.deficit, p.impaired), (0, false));
        // Not impaired, nothing to realise.
        assert_eq!(realise_loss(&mut p, 5), None);
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
    fn dust_under_the_tolerance_takes_the_fee_then_books_the_rest() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        p.loss_tolerance_bps = 10;
        p.venue_value = 10_000;
        p.fee_owed = 30;
        p.last_sync_at = 5;
        let out = apply_sync(&mut p, 9_980, 6).unwrap();
        assert_eq!((out.ran, out.gain, out.loss), (true, 0, 20));
        assert_eq!((p.fee_owed, p.venue_value), (10, 9_980));
        // 10 bps of 9,980 is 9: a fall of 8 is dust, the fee bears 8 of it.
        apply_sync(&mut p, 9_972, 7).unwrap();
        assert_eq!(p.fee_owed, 2);
        // The next 7 are dust too. The fee has 2, so 5 is booked.
        apply_sync(&mut p, 9_965, 8).unwrap();
        assert_eq!((p.fee_owed, p.deficit, p.impaired), (0, 5, false));
        assert_eq!((p.yield_owed, p.prize_owed, p.yield_index), (0, 0, 0));
    }

    #[test]
    fn a_hundred_sub_tolerance_drops_sum_to_the_booked_deficit() {
        let mut p = pool(1_000_000_000_000, 1_000, 1_000);
        p.loss_tolerance_bps = 1;
        p.venue_value = 1_000_000_000_000;
        p.last_sync_at = 5;
        // 0.9 bps of the value each sync, under the 1 bps tolerance.
        let mut booked = 0u64;
        for i in 0..100 {
            let drop = p.venue_value / 10_000 * 9 / 10;
            let value = p.venue_value - drop;
            let out = apply_sync(&mut p, value, 6 + i).unwrap();
            booked += drop;
            assert!(!p.impaired);
            assert_eq!(out.deficit_added, drop);
        }
        assert_eq!((p.deficit, p.impaired), (booked, false));
        assert_eq!(p.venue_value + p.deficit, 1_000_000_000_000);
    }

    #[test]
    fn a_drop_over_the_tolerance_impairs_and_books_the_same_way() {
        let mut p = pool(1_000_000, 1_000, 1_000);
        p.loss_tolerance_bps = 1;
        p.venue_value = 1_000_000;
        p.last_sync_at = 5;
        // 101 is over 1 bps of 1,000,000, and nothing absorbs it first.
        apply_sync(&mut p, 999_899, 6).unwrap();
        assert_eq!((p.deficit, p.impaired), (101, true));
    }

    #[test]
    fn repaying_a_sub_tolerance_deficit_clears_nothing() {
        let mut p = pool(1_000_000, 0, 0);
        p.loss_tolerance_bps = 1;
        p.venue_value = 1_000_000;
        p.last_sync_at = 5;
        apply_sync(&mut p, 999_950, 6).unwrap();
        assert_eq!(p.deficit, 50);
        let out = apply_sync(&mut p, 1_000_000, 7).unwrap();
        assert_eq!((out.deficit_repaid, out.cleared, p.deficit, p.impaired), (50, false, 0, false));
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
    fn a_stale_index_pays_the_rise_into_principal_and_total_but_not_tickets() {
        let mut pool = pool(1_000, 0, 0);
        pool.yield_index = INDEX_SCALE / 2;
        pool.yield_owed = 500;
        let mut p = player(1_000, 0);
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 500);
        // Tickets wait for the next epoch's reset (ADR 0020).
        assert_eq!((p.principal, p.entries), (1_500, 1_000));
        assert_eq!((pool.total_principal, pool.yield_owed), (1_500, 0));
        assert_eq!(p.yield_index, pool.yield_index);
        // Settling again at the same index owes nothing.
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 0);
        assert_eq!(p.principal, 1_500);
    }

    #[test]
    fn zero_principal_jumps_to_the_current_index_and_earns_nothing() {
        let mut pool = pool(1_000, 0, 0);
        pool.yield_index = 7 * INDEX_SCALE;
        pool.yield_owed = 100;
        let mut p = player(0, 0);
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 0);
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
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 0);
        assert_eq!((p.yield_index, p.principal, pool.yield_owed), (0, 10, 10));
        // 10 x 0.15 = 1.5 against the unchanged index floors to 1, not 0 + 1.
        pool.yield_index = 3 * INDEX_SCALE / 20;
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 1);
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
        assert_eq!(settle(&mut pool, &mut house).unwrap(), 0);
        assert_eq!((house.principal, house.entries, house.yield_index), (500, 500, 0));
        assert_eq!((pool.total_principal, pool.yield_owed), (1_000, 1_000));
    }

    #[test]
    fn principal_added_after_a_zero_settle_does_not_earn_the_past() {
        let mut pool = pool(1_000_000, 0, 0);
        pool.yield_owed = 1_000_000;
        pool.yield_index = INDEX_SCALE / 2; // 1 unit x 0.5 floors to 0
        let mut p = player(1, 0);
        assert_eq!(settle_before_growth(&mut pool, &mut p).unwrap(), 0);
        assert_eq!(p.yield_index, pool.yield_index);
        p.principal += 1_000_000;
        // With no new gain, the larger balance owes nothing.
        assert_eq!(settle(&mut pool, &mut p).unwrap(), 0);
        assert_eq!((p.principal, pool.yield_owed), (1_000_001, 1_000_000));
        // Plain settle on the same stale index would have paid 500,000.
        let mut q = player(1, 0);
        assert_eq!(settle(&mut pool, &mut q).unwrap(), 0);
        q.principal += 1_000_000;
        assert_eq!(settle(&mut pool, &mut q).unwrap(), 500_000);
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
                let entries_before = players[i].entries;
                settled += settle(&mut pool, &mut players[i]).unwrap() as u128;
                assert_eq!(players[i].entries, entries_before, "seed {seed}");
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
