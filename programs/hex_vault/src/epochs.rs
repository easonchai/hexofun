//! Epoch lifecycle (spec §2.3 "Epochs").
//!
//! `begin_epoch` is operator-only via `has_one = operator` on the Pool
//! account. `fund_jackpot` and `payout` are permissionless.
//!
//! `draw` and `rollover_epoch` are permissionless too (production-hardening
//! ticket 01): the first account, `caller`, is any signer, so an operator
//! that stops cranking cannot withhold a fulfilled result or leave a
//! timed-out request stuck.
//!
//! `register` and `close_registration` were removed by the layout rewrite
//! (yield-claimer ticket 04, ADR 0018). Until ticket 08 adds the Weight
//! tree's `request_draw`, an ended epoch stays Registering until
//! `rollover_epoch` takes it, and `payout` refuses every winner.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{
    epoch_status, EPOCH_VERSION, SEED_EPOCH, SEED_JACKPOT, SEED_PLAYER, SEED_POOL,
    SEED_PRINCIPAL,
};
use crate::errors::HexVaultError;
use crate::events::{EpochBegan, EpochDrawn, EpochRolledOver, JackpotFunded, JackpotPaid};
use crate::state::{Epoch, Player, Pool};
use crate::sync::settle_before_growth;
use crate::touch::touch;
use crate::utils;
use crate::venue::{self, Venue};
use crate::vrf;

/// Checks that `winner` holds the drawn target in `epoch`. Registration's
/// `reg_start <= target < reg_end` went with the layout rewrite; ticket 08
/// replaces this with the Weight tree's leaf-range check. Until then no
/// winner can be confirmed, so every payout is refused by name.
fn check_winner(_winner: &Player, _epoch: &Epoch) -> Result<()> {
    err!(HexVaultError::DrawPendingWeightTree)
}

/// Most recent point of the `anchor + k * period` grid at or before `t`.
///
/// `div_euclid` floors towards negative infinity. Plain `/` truncates
/// towards zero, which lands a whole period late for any `t` before the
/// anchor, and an anchor set to a future Sunday makes that the normal case.
fn grid_floor(anchor: i64, period: i64, t: i64) -> Result<i64> {
    let k = t
        .checked_sub(anchor)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        .div_euclid(period);
    k.checked_mul(period)
        .and_then(|offset| anchor.checked_add(offset))
        .ok_or_else(|| HexVaultError::ArithmeticOverflow.into())
}

pub fn begin_epoch(ctx: Context<BeginEpoch>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.jackpot_paused, HexVaultError::JackpotPaused);

    // The epoch two behind the one this call is about to create is the one
    // whose winner's registered interval must survive until Payout
    // (beta-launch-fixes ticket 03): if it is still Drawing or Drawn, its
    // winner has not been paid yet, and the next `begin_epoch` (two calls
    // from now) would otherwise be free to overwrite that Player's interval
    // before Payout ever reads it. Only checked once such an epoch could
    // exist (`current_epoch_id >= 2`; epoch ids start at 1).
    if pool.current_epoch_id >= 2 {
        let data = ctx.accounts.epoch_two_behind.try_borrow_data()?;
        let two_behind = Epoch::try_deserialize(&mut &data[..])?;
        require!(
            !matches!(two_behind.status, epoch_status::DRAWING | epoch_status::DRAWN),
            HexVaultError::PreviousEpochStillDrawing
        );
    }

    let starts_at = if pool.current_epoch_id == 0 {
        now
    } else {
        // The epoch that just ended. Read and rewrite it through raw
        // account data (like `test_vrf::test_fulfill` does) instead of
        // `Account::try_from`: the account is `UncheckedAccount` so a
        // first-ever call, where it doesn't exist yet, never tries to
        // deserialize it, and `Account<'info, T>` from a re-borrowed
        // `UncheckedAccount` cannot satisfy the matching lifetimes
        // `try_from` requires without naming a lifetime on this handler
        // that the `#[program]`-generated wrapper in `lib.rs` cannot match.
        let mut data = ctx.accounts.current_epoch.try_borrow_mut_data()?;
        let mut previous = Epoch::try_deserialize(&mut &data[..])?;
        require!(now >= previous.ends_at, HexVaultError::EpochNotEnded);
        let previous_ends_at = previous.ends_at;
        previous.status = epoch_status::REGISTERING;
        // `rollover_epoch` measures its deadline from here, however late
        // this call is. Ticket 08 replaces this hand-off with `request_draw`.
        previous.registration_opened_at = now;

        let mut buf = Vec::with_capacity(data.len());
        previous.try_serialize(&mut buf)?;
        require!(buf.len() <= data.len(), HexVaultError::ArithmeticOverflow);
        data[..buf.len()].copy_from_slice(&buf);

        // Contiguous when the operator is merely late, so the schedule
        // holds. Once the operator has been down past a whole grid point,
        // `grid_floor(now)` overtakes the previous end and the dead gap is
        // skipped: nobody accrued Weight in it (`touch` clamps at the
        // previous `ends_at`), so nothing is lost, and the boundary stays on
        // the grid instead of rerolling to `now`.
        previous_ends_at.max(grid_floor(pool.epoch_anchor, pool.epoch_seconds, now)?)
    };

    // The first epoch starts off grid at `now` and ends at the next grid
    // point, so it is a short stub and the pool is live from bootstrap.
    // Every epoch after it starts on the grid and runs a full period.
    let ends_at = grid_floor(pool.epoch_anchor, pool.epoch_seconds, starts_at)?
        .checked_add(pool.epoch_seconds)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    pool.previous_epoch_start = pool.current_epoch_start;
    pool.current_epoch_start = starts_at;
    pool.previous_epoch_ends_at = pool.current_epoch_ends_at;
    pool.current_epoch_ends_at = ends_at;
    pool.current_epoch_id = pool
        .current_epoch_id
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    let new_epoch = &mut ctx.accounts.new_epoch;
    new_epoch.epoch_id = pool.current_epoch_id;
    new_epoch.starts_at = starts_at;
    new_epoch.ends_at = ends_at;
    new_epoch.status = epoch_status::OPEN;
    new_epoch.registered_weight = 0;
    new_epoch.registered_count = 0;
    new_epoch.jackpot_amount = 0;
    new_epoch.vrf_seed = [0u8; 32];
    new_epoch.requested_at = 0;
    new_epoch.target = 0;
    new_epoch.winner = Pubkey::default();
    new_epoch.bump = ctx.bumps.new_epoch;
    new_epoch.drawn_at = 0;
    new_epoch.registration_opened_at = 0;
    new_epoch.version = EPOCH_VERSION;

    emit!(EpochBegan {
        epoch_id: new_epoch.epoch_id,
        starts_at,
        ends_at,
    });
    Ok(())
}

pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.source_authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    emit!(JackpotFunded {
        source: ctx.accounts.source.key(),
        amount,
    });
    Ok(())
}

pub fn draw(ctx: Context<Draw>) -> Result<()> {
    let now = utils::now()?;
    let epoch = &mut ctx.accounts.epoch;

    // No shutdown check by design (beta-launch-fixes ticket 03): an Epoch
    // still Drawing when `shutdown` lands must still be drawn so its Prize
    // reaches its winner instead of being stranded in the vault. `payout`
    // already runs after shutdown for the same reason.
    require!(
        epoch.status == epoch_status::DRAWING,
        HexVaultError::EpochNotDrawing
    );

    let randomness = vrf::read_fulfilled(&ctx.accounts.randomness.to_account_info(), &epoch.vrf_seed)?;

    epoch.target = vrf::unbiased_u128(&randomness, epoch.registered_weight)?;
    epoch.status = epoch_status::DRAWN;
    epoch.drawn_at = now;

    emit!(EpochDrawn {
        epoch_id: epoch.epoch_id,
        target: epoch.target,
        registered_weight: epoch.registered_weight,
    });
    Ok(())
}

pub fn payout<'info>(ctx: Context<'info, Payout<'info>>) -> Result<()> {
    let now = utils::now()?;
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    venue::sync(&mut a.pool, &venue)?;
    let pool = &mut a.pool;
    let epoch = &mut a.epoch;
    let winner = &mut a.winner;

    require!(
        epoch.status == epoch_status::DRAWN,
        HexVaultError::EpochNotDrawn
    );
    check_winner(winner, epoch)?;

    let amount = epoch.jackpot_amount;
    let is_house = winner.is_house;
    let decimals = a.accepted_mint.decimals;
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    if is_house {
        // 50/20/30 split (spec §7); the 30% share and any dust from the
        // truncating divisions below simply stay in the jackpot vault.
        let buyback_amount = amount / 2;
        let treasury_amount = amount / 5;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.jackpot_vault.to_account_info(),
                    mint: a.accepted_mint.to_account_info(),
                    to: a.buyback_reserve.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            buyback_amount,
            decimals,
        )?;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.jackpot_vault.to_account_info(),
                    mint: a.accepted_mint.to_account_info(),
                    to: a.treasury.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            treasury_amount,
            decimals,
        )?;
    } else {
        // Compounds into the winner's Principal instead of paying their
        // token account. Touch first, so the prize lands on this epoch's
        // Tickets, then settle (the sync ran above): the winner's yield so far
        // joins Principal before the prize does, so the prize earns only from
        // here on, never retroactively.
        touch(winner, pool);
        settle_before_growth(pool, winner, now)?;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.jackpot_vault.to_account_info(),
                    mint: a.accepted_mint.to_account_info(),
                    to: a.principal_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            decimals,
        )?;

        winner.principal = winner
            .principal
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        winner.entries = winner
            .entries
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        pool.total_principal = pool
            .total_principal
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
    }

    epoch.winner = winner.owner;
    epoch.status = epoch_status::PAID;
    // Released whatever actually left the vault: a House win leaves 30% of
    // it behind, and that share belongs to the next epoch's snapshot.
    pool.jackpot_reserved = pool
        .jackpot_reserved
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(JackpotPaid {
        epoch_id: epoch.epoch_id,
        winner: winner.owner,
        amount,
        is_house,
        compounded: !is_house,
    });
    Ok(())
}

pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;

    match epoch.status {
        // Ended and never sent to the draw, past the VRF timeout: there is
        // no request to check a fulfilled/unfulfilled state against
        // (beta-launch-fixes ticket 02). Behaves as the existing no-draw
        // Rollover below: nothing was ever reserved for this epoch
        // (`jackpot_amount` is still 0), so the Prize stays in the hexpot.
        // Until ticket 08 every ended epoch leaves this way.
        epoch_status::REGISTERING => {
            // The jackpot pause holds the draw back on purpose; a stranger
            // must not be able to end it in its place (production-hardening
            // 14, finding 3).
            require!(!pool.jackpot_paused, HexVaultError::JackpotPaused);
            let opened = epoch.registration_opened_at.max(epoch.ends_at);
            let deadline = opened
                .checked_add(pool.vrf_timeout)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            require!(now > deadline, HexVaultError::VrfTimeoutNotElapsed);
        }
        epoch_status::DRAWING => {
            // A fulfilled request has to go through `draw`, or a caller
            // could read the target, see who won, and wait out the timeout.
            require_keys_eq!(
                ctx.accounts.randomness.key(),
                vrf::randomness_address(&epoch.vrf_seed),
                HexVaultError::InvalidRandomnessAccount
            );
            require!(
                !vrf::is_fulfilled(&ctx.accounts.randomness.to_account_info(), &epoch.vrf_seed),
                HexVaultError::RandomnessAlreadyFulfilled
            );
            let deadline = epoch
                .requested_at
                .checked_add(pool.vrf_timeout)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            require!(now > deadline, HexVaultError::VrfTimeoutNotElapsed);
        }
        // The winner is known but cannot be paid: a frozen or closed token
        // account would otherwise leave this epoch open forever and hand its
        // prize to whoever wins the next one by accident. The jackpot stays
        // in the vault, so the next epoch draws for it deliberately.
        epoch_status::DRAWN => {
            let deadline = epoch
                .drawn_at
                .checked_add(pool.payout_timeout)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            require!(now > deadline, HexVaultError::PayoutTimeoutNotElapsed);
        }
        _ => return Err(HexVaultError::EpochNotDrawing.into()),
    }

    epoch.status = epoch_status::ROLLED_OVER;
    // Both branches above leave Drawing or Drawn, so the prize this epoch
    // was holding goes back into what the next close may snapshot.
    pool.jackpot_reserved = pool
        .jackpot_reserved
        .checked_sub(epoch.jackpot_amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(EpochRolledOver {
        epoch_id: epoch.epoch_id,
        jackpot_amount: epoch.jackpot_amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BeginEpoch<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = operator,
    )]
    // Boxed: the layout rewrite's larger Pool pushed `try_accounts` over the
    // BPF stack frame.
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: the epoch that just ended, moved to Registering. Does not
    /// exist yet on the very first call (`pool.current_epoch_id == 0`); the
    /// handler skips it entirely in that case, so it is never deserialized
    /// before it exists.
    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &pool.current_epoch_id.to_le_bytes()],
        bump,
    )]
    pub current_epoch: UncheckedAccount<'info>,

    /// CHECK: the epoch two behind the one being created, read (not
    /// deserialized) only when `pool.current_epoch_id >= 2`, i.e. when such
    /// an epoch could exist at all. `saturating_sub` keeps the seed in range
    /// on the two calls before that, where it is never read.
    #[account(
        seeds = [SEED_EPOCH, pool.key().as_ref(), &pool.current_epoch_id.saturating_sub(1).to_le_bytes()],
        bump,
    )]
    pub epoch_two_behind: UncheckedAccount<'info>,

    #[account(
        init,
        payer = operator,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &(pool.current_epoch_id + 1).to_le_bytes()],
        bump,
        space = 8 + Epoch::INIT_SPACE,
    )]
    pub new_epoch: Account<'info, Epoch>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundJackpot<'info> {
    #[account(mut)]
    pub source_authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = pool.accepted_mint, token::authority = source_authority)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
    )]
    pub jackpot_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless (production-hardening ticket 01): `caller` may be any
/// signer, only paying the transaction's fee.
#[derive(Accounts)]
pub struct Draw<'info> {
    pub caller: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    /// CHECK: ORAO randomness account for this epoch's draw.
    pub randomness: UncheckedAccount<'info>,
}

/// No signer at all, like `process_withdraw`. The winner is fixed by the
/// Player PDA's seeds, so there is nothing here for a caller to steer.
/// Gating it on the operator only let the operator veto a winner by sitting
/// out `payout_timeout`. A non-House winner no longer needs a token account
/// of their own: the prize compounds into `principal_vault` instead.
#[derive(Accounts)]
pub struct Payout<'info> {
    // Boxed: unboxed, this struct's `try_accounts` overflows the BPF stack
    // frame (8 accounts including 5 token accounts).
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = treasury,
        has_one = buyback_reserve,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Box<Account<'info, Epoch>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), winner.owner.as_ref()],
        bump = winner.bump,
    )]
    pub winner: Box<Account<'info, Player>>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

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

    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless (production-hardening ticket 01): `caller` may be any
/// signer, only paying the transaction's fee.
#[derive(Accounts)]
pub struct RolloverEpoch<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    /// CHECK: ORAO randomness account for this epoch's draw, matched against
    /// `vrf::randomness_address` in the handler the same way `draw` does.
    /// Only read on the Drawing branch, where an unfulfilled (or absent)
    /// account is the normal case.
    pub randomness: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600;
    const DAY: i64 = 86_400;
    const WEEK: i64 = 604_800;
    /// Sunday 2026-09-13T16:00:00Z, which is 00:00 Monday in UTC+8.
    const SUNDAY_1600: i64 = 1_789_315_200;

    #[test]
    fn a_t_already_on_the_grid_returns_itself() {
        assert_eq!(grid_floor(1_000, 60, 1_000).expect("grid"), 1_000);
        assert_eq!(grid_floor(1_000, 60, 1_240).expect("grid"), 1_240);
        assert_eq!(
            grid_floor(SUNDAY_1600, DAY, SUNDAY_1600 + 5 * DAY).expect("grid"),
            SUNDAY_1600 + 5 * DAY
        );
    }

    #[test]
    fn a_t_before_the_anchor_floors_down_not_towards_zero() {
        // Truncating division gives 1_000 for all three, a whole period late
        // and after `t`, which is what `div_euclid` is here to avoid.
        assert_eq!(grid_floor(1_000, 60, 999).expect("grid"), 940);
        assert_eq!(grid_floor(1_000, 60, 941).expect("grid"), 940);
        assert_eq!(grid_floor(1_000, 60, 940).expect("grid"), 940);
        assert_eq!(
            grid_floor(SUNDAY_1600, DAY, SUNDAY_1600 - 1).expect("grid"),
            SUNDAY_1600 - DAY
        );
    }

    #[test]
    fn the_daily_grid_from_a_sunday_anchor_lands_on_1600_utc_all_week() {
        // 57_600 seconds into the UTC day is 16:00, which is midnight in
        // UTC+8. Probes run a week either side of the anchor.
        for hour in -168..168 {
            let t = SUNDAY_1600 + hour * HOUR;
            let point = grid_floor(SUNDAY_1600, DAY, t).expect("grid");
            assert_eq!(point.rem_euclid(DAY), 57_600, "hour {hour} left 16:00 UTC");
            assert!(point <= t && t - point < DAY, "hour {hour} is not the floor");
        }
    }

    #[test]
    fn the_weekly_grid_from_the_same_anchor_lands_on_sundays() {
        // 316_800 seconds into the unix week (which starts on a Thursday) is
        // Sunday 16:00 UTC, so one anchor serves the daily and weekly grids.
        for hour in -168..168 {
            let t = SUNDAY_1600 + hour * HOUR;
            let point = grid_floor(SUNDAY_1600, WEEK, t).expect("grid");
            assert_eq!(point.rem_euclid(WEEK), 316_800, "hour {hour} left Sunday");
            assert!(point <= t && t - point < WEEK, "hour {hour} is not the floor");
        }
    }
}
