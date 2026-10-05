//! Round lifecycle (spec §2.3 "Rounds").
//!
//! `create_round` is operator-only via `has_one = operator` on the Pool
//! account. `buy_position`, `request_round_randomness`, `settle_position` and
//! `close_round` are permissionless.
//!
//! `settle_round` and `void_round` are permissionless too
//! (production-hardening ticket 01): the first account, `caller`, is any
//! signer, so an operator that stops cranking cannot withhold a fulfilled
//! result or leave a timed-out request stuck. `settle_round`'s House account
//! stays pinned to the Player PDA of `pool.operator`, never the caller.

use anchor_lang::prelude::*;

use crate::constants::{
    round_status, BPS_DENOMINATOR, LAYOUT_VERSION, SEED_EPOCH, SEED_PLAYER, SEED_POOL,
    SEED_POSITION, SEED_ROUND, TILE_COUNT,
};
use crate::errors::HexVaultError;
use crate::events::{
    PositionBought, PositionSettled, RoundClosed, RoundOpened, RoundSettled, RoundVoided,
};
use crate::state::{Epoch, Player, Pool, Position, Round, WeightTree};
use crate::touch::touch;
use crate::utils;
use crate::vrf;
use crate::weight::{self, Change};

pub fn create_round(ctx: Context<CreateRound>, starts_at: i64, ends_at: i64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(!pool.game_paused, HexVaultError::GamePaused);
    require!(pool.open_round_id == 0, HexVaultError::RoundAlreadyOpen);
    require!(
        ends_at.checked_sub(starts_at) == Some(pool.round_seconds),
        HexVaultError::InvalidRoundLength
    );

    // Bound the round to the current epoch. Before the first epoch begins
    // (`current_epoch_id == 0`) there is nothing to bound against yet, and
    // no Epoch account exists at that id, so the check (and the
    // `current_epoch` account) is skipped entirely in that case.
    if pool.current_epoch_id != 0 {
        let expected_epoch = Pubkey::find_program_address(
            &[
                SEED_EPOCH,
                pool.key().as_ref(),
                &pool.current_epoch_id.to_le_bytes(),
            ],
            &crate::ID,
        )
        .0;
        require_keys_eq!(
            ctx.accounts.current_epoch.key(),
            expected_epoch,
            HexVaultError::InvalidParameter
        );
        let data = ctx.accounts.current_epoch.try_borrow_data()?;
        let epoch = Epoch::try_deserialize(&mut &data[..])?;
        require!(ends_at <= epoch.ends_at, HexVaultError::RoundOutsideEpoch);
    }

    let round_id = pool.next_round_id;
    pool.next_round_id = pool
        .next_round_id
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.open_round_id = round_id;
    let epoch_id = pool.current_epoch_id;

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.epoch_id = epoch_id;
    round.starts_at = starts_at;
    round.ends_at = ends_at;
    round.status = round_status::OPEN;
    round.tile_totals = [0; TILE_COUNT as usize];
    round.pot = 0;
    round.house_cut = 0;
    // Unknowable until `request_round_randomness` mixes in the Operator's
    // nonce (beta-launch-fixes ticket 02): a seed precomputed here, from
    // public inputs alone, could be griefed by pre-creating ORAO's request
    // account for it before the Operator ever asks.
    round.vrf_seed = [0u8; 32];
    round.requested_at = 0;
    round.winning_tile = 0;
    round.bump = ctx.bumps.round;
    round.open_positions = 0;
    round.vrf_request_slot = 0;
    round.version = LAYOUT_VERSION;

    emit!(RoundOpened {
        round_id,
        epoch_id,
        starts_at,
        ends_at,
    });
    Ok(())
}

pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    touch(player, pool);

    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    // Pause stops all Ticket movement (production-hardening ticket 02); an
    // already-open round can still finish (settle_round, settle_position,
    // close_round all stay open while paused).
    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(!pool.game_paused, HexVaultError::GamePaused);
    // The House is the counterparty, not a participant: it takes forfeited
    // pots and the cut, so letting the operator stake those Entries back on
    // tiles would be playing against the depositors with their own money.
    require!(!player.is_house, HexVaultError::HouseCannotPlay);

    let round = &mut ctx.accounts.round;
    require!(round.status == round_status::OPEN, HexVaultError::RoundNotOpen);
    let close_at = round
        .ends_at
        .checked_sub(pool.close_buffer)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now < close_at, HexVaultError::RoundClosed);

    let tile_count = utils::tile_count(tiles)?;
    require!(stake_per_tile >= 1, HexVaultError::InvalidStake);
    let total = stake_per_tile
        .checked_mul(tile_count)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(player.entries >= total, HexVaultError::InsufficientEntries);

    // Pre-credit the Weight this stake would have earned for the rest of the
    // round before it leaves Tickets, so buying a position is Weight-neutral
    // for the lottery draw (spec §2.3). The tree already credited the Tickets
    // up to the epoch's end, so the two go in as one net change: minus
    // `total × (epoch_end − now)` for the Tickets leaving, plus `total ×
    // (round_end − now)` for the pre-credit. A round never outlasts its
    // epoch (`create_round`), but the pre-credit is clamped to it anyway, for
    // a round created before the first epoch began.
    let credit_end = round.ends_at.min(pool.current_epoch_ends_at);
    let remaining = u64::try_from(credit_end.saturating_sub(now)).unwrap_or(0);
    let mut change = Change::new(pool, now);
    change.weight(
        i128::from(total)
            .checked_mul(i128::from(remaining))
            .ok_or(HexVaultError::ArithmeticOverflow)?,
    )?;
    change.tickets(-i128::from(total))?;
    weight::apply(&ctx.accounts.weight_tree, pool, player, change)?;

    player.entries = player
        .entries
        .checked_sub(total)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    for tile in 0..TILE_COUNT {
        if utils::tile_is_covered(tiles, tile) {
            round.add_to_tile(tile, stake_per_tile)?;
        }
    }
    round.pot = round
        .pot
        .checked_add(total)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    round.open_positions = round
        .open_positions
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    let round_id = round.round_id;
    let round_key = round.key();

    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.owner.key();
    position.round = round_key;
    position.tiles = tiles;
    position.stake_per_tile = stake_per_tile;
    position.bump = ctx.bumps.position;
    position.version = LAYOUT_VERSION;

    emit!(PositionBought {
        round_id,
        owner: ctx.accounts.owner.key(),
        tiles,
        stake_per_tile,
        total,
    });
    Ok(())
}

/// `nonce` is a 32-byte value the Operator generates fresh for this request
/// and mixes into the seed (beta-launch-fixes ticket 02), so the resulting
/// randomness address is unknowable before this instruction runs and cannot
/// be griefed by pre-creating ORAO's request account for it.
pub fn request_round_randomness(ctx: Context<RequestRoundRandomness>, nonce: [u8; 32]) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(round.status == round_status::OPEN, HexVaultError::RoundNotOpen);
    // Same instant `buy_position` starts refusing with `RoundClosed`: the
    // draw window opens the moment Positions close, not at `ends_at`.
    let close_at = round
        .ends_at
        .checked_sub(pool.close_buffer)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now >= close_at, HexVaultError::RoundNotEnded);

    let seed = utils::vrf_seed(b"round", &pool.key(), round.round_id, &nonce);
    require_keys_eq!(
        ctx.accounts.randomness.key(),
        vrf::randomness_address(&seed),
        HexVaultError::InvalidRandomnessAccount
    );

    vrf::request_randomness(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.vrf_network_state.to_account_info(),
        &ctx.accounts.vrf_treasury.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.vrf_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        seed,
    )?;

    round.vrf_seed = seed;
    round.status = round_status::REQUESTED;
    round.requested_at = now;
    round.vrf_request_slot = Clock::get()?.slot;
    Ok(())
}

pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(
        round.status == round_status::REQUESTED,
        HexVaultError::RoundNotRequested
    );

    let randomness = vrf::read_fulfilled(&ctx.accounts.randomness.to_account_info(), &round.vrf_seed)?;

    // u64 sample mapped into 0..36 via the rejection-sampled unbiased
    // mapping (bias bound documented on `vrf::unbiased_u64`); the result is
    // always < 36 so the cast to u8 is lossless.
    let winning_tile = vrf::unbiased_u64(&randomness, u64::from(TILE_COUNT))? as u8;

    let pot = round.pot;
    let tile_total = round.tile_total(winning_tile)?;
    let forfeited = tile_total == 0;

    // A Round whose Epoch already rolled over already had its Entries
    // returned to Principal by `touch`; crediting the House here would mint
    // Entries the invariant doesn't allow (audit-fixes/01), so the House's
    // share just evaporates instead. Same rule for the whole forfeited pot
    // and for the cut on a settled one.
    let epoch_is_current = round.epoch_id == pool.current_epoch_id;

    // On a forfeited round the House already takes the whole pot, so there is
    // nothing left to cut. On a settled one it takes `house_cut_bps` of the
    // gross pot and the winners split the rest in `settle_position`.
    let house_cut = if forfeited {
        0
    } else {
        let cut = u128::from(pot)
            .checked_mul(u128::from(pool.house_cut_bps))
            .ok_or(HexVaultError::ArithmeticOverflow)?
            / u128::from(BPS_DENOMINATOR);
        // cut <= pot because house_cut_bps <= BPS_DENOMINATOR, so the cast
        // back to u64 cannot truncate.
        u64::try_from(cut).map_err(|_| HexVaultError::ArithmeticOverflow)?
    };
    // A forfeited round always touches the House, even on an empty pot, so
    // its Entries reset on schedule across an epoch boundary. A settled one
    // only touches it when there is a cut to credit, so a pool at rate zero
    // behaves exactly as it did before the cut existed.
    let house_credit = if forfeited { pot } else { house_cut };

    if epoch_is_current && (forfeited || house_credit > 0) {
        let house = &mut ctx.accounts.house;
        touch(house, pool);
        house.entries = house
            .entries
            .checked_add(house_credit)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        let mut change = Change::new(pool, utils::now()?);
        change.tickets(i128::from(house_credit))?;
        weight::apply(&ctx.accounts.weight_tree, pool, house, change)?;
    }

    round.status = if forfeited {
        round_status::FORFEITED
    } else {
        round_status::SETTLED
    };
    // Recorded even when it evaporated, so the Round is a complete record.
    round.house_cut = house_cut;
    round.winning_tile = winning_tile;
    pool.open_round_id = 0;

    let round_id = round.round_id;
    emit!(RoundSettled {
        round_id,
        winning_tile,
        pot,
        forfeited,
        house_cut,
    });
    Ok(())
}

pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let round = &mut ctx.accounts.round;
    let player = &mut ctx.accounts.player;
    touch(player, pool);

    require!(
        matches!(
            round.status,
            round_status::SETTLED | round_status::FORFEITED | round_status::VOIDED
        ),
        HexVaultError::RoundNotSettled
    );

    let position = &ctx.accounts.position;
    let mut reward: u64 = 0;
    // Same evaporation rule as `settle_round`: once the Round's Epoch has
    // rolled over, `touch` already returned this reward's Entries to
    // Principal, so crediting it now would mint Entries (audit-fixes/01).
    if round.epoch_id == pool.current_epoch_id
        && round.status == round_status::SETTLED
        && utils::tile_is_covered(position.tiles, round.winning_tile)
    {
        // tile_total is > 0 here: settle_round only reaches Settled (rather
        // than Forfeited) when some position covers winning_tile, and this
        // one does, so it contributed at least stake_per_tile to it.
        let tile_total = round.tile_total(round.winning_tile)?;
        // The House already took `house_cut` in `settle_round`; the winners
        // split what is left of the gross pot.
        let payable = round
            .pot
            .checked_sub(round.house_cut)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        let reward_u128 = u128::from(payable)
            .checked_mul(u128::from(position.stake_per_tile))
            .ok_or(HexVaultError::ArithmeticOverflow)?
            / u128::from(tile_total);
        // Integer division truncates towards zero; the remainder stays
        // unminted. Negligible dust, documented and accepted (spec §2.3).
        reward = u64::try_from(reward_u128).map_err(|_| HexVaultError::ArithmeticOverflow)?;
    }

    if reward > 0 {
        player.entries = player
            .entries
            .checked_add(reward)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        let mut change = Change::new(pool, utils::now()?);
        change.tickets(i128::from(reward))?;
        weight::apply(&ctx.accounts.weight_tree, pool, player, change)?;
    }

    round.open_positions = round
        .open_positions
        .checked_sub(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(PositionSettled {
        round_id: round.round_id,
        owner: position.owner,
        reward,
    });
    Ok(())
}

pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(
        matches!(round.status, round_status::REQUESTED | round_status::OPEN),
        HexVaultError::RoundNotRequested
    );

    if round.status == round_status::REQUESTED {
        // A fulfilled request has to go through `settle_round`. Without this
        // a caller could read the drawn tile, dislike it, and sit out the
        // timeout to void the round instead.
        require_keys_eq!(
            ctx.accounts.randomness.key(),
            vrf::randomness_address(&round.vrf_seed),
            HexVaultError::InvalidRandomnessAccount
        );
        require!(
            !vrf::is_fulfilled(&ctx.accounts.randomness.to_account_info(), &round.vrf_seed),
            HexVaultError::RandomnessAlreadyFulfilled
        );
        let timeout_at = round
            .requested_at
            .checked_add(pool.vrf_timeout)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        require!(now > timeout_at, HexVaultError::VrfTimeoutNotElapsed);
    } else {
        // Still OPEN past its own end plus the VRF timeout: nobody ever
        // requested randomness for it at all (beta-launch-fixes ticket 02),
        // so there is no request to check a fulfilled/unfulfilled state
        // against.
        let timeout_at = round
            .ends_at
            .checked_add(pool.vrf_timeout)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        require!(now > timeout_at, HexVaultError::VrfTimeoutNotElapsed);
    }

    // `carry_pot` is gone (ADR 0019). Until ticket 11 refunds each stake at
    // `settle_position`, a voided pot is returned to nobody this epoch; the
    // epoch boundary still resets everyone's Tickets to Principal.
    round.status = round_status::VOIDED;
    pool.open_round_id = 0;

    emit!(RoundVoided {
        round_id: round.round_id,
    });
    Ok(())
}

/// Permissionless: reclaims a finished Round's rent for the operator once
/// every Position on it has settled (spec "close_round", ops-and-envs
/// ticket 05; supersedes `docs/plan/mainnet/issues/09`, where devnet
/// measured about 2.5 SOL a day of unreclaimed Round rent at 90s rounds).
///
/// The Round PDA's seeds (`SEED_ROUND`, pool, `round_id`) can never be
/// replayed: `create_round` always mints the next id off `pool.next_round_id`,
/// which only increases, so a closed Round's address can never be
/// re-initialised with an old id.
pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(
        matches!(
            round.status,
            round_status::SETTLED | round_status::FORFEITED | round_status::VOIDED
        ),
        HexVaultError::RoundNotSettled
    );
    require!(
        round.open_positions == 0,
        HexVaultError::RoundHasOpenPositions
    );

    emit!(RoundClosed {
        round: round.key(),
        round_id: round.round_id,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CreateRound<'info> {
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

    /// CHECK: the pool's current epoch. Only read (and its address checked)
    /// when one is open (`pool.current_epoch_id != 0`); any account may be
    /// passed before the first epoch begins, since there is nothing yet to
    /// bound `ends_at` against.
    pub current_epoch: UncheckedAccount<'info>,

    #[account(
        init,
        payer = operator,
        seeds = [SEED_ROUND, pool.key().as_ref(), &pool.next_round_id.to_le_bytes()],
        bump,
        space = 8 + Round::INIT_SPACE,
    )]
    pub round: Box<Account<'info, Round>>,

    pub system_program: Program<'info, System>,
}

// Boxed: unboxed, this struct's `try_accounts` overflows the BPF stack frame
// (Pool and Player's ticket ops-and-envs/01 padding pushed it over, on top of
// Round's 36-tile array), the same issue `SettleRound` and `SettlePosition`
// already work around.
#[derive(Accounts)]
pub struct BuyPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(
        init,
        payer = owner,
        seeds = [SEED_POSITION, round.key().as_ref(), owner.key().as_ref()],
        bump,
        space = 8 + Position::INIT_SPACE,
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRoundRandomness<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: ORAO randomness account for this round's seed, verified
    /// against `vrf::randomness_address` in the handler.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF network state, pinned on the pool at `create_pool`.
    /// `mut` because `request_v2` increments its `num_received`: the CPI marks
    /// it writable, and an outer context that is not cannot grant that.
    #[account(mut, address = pool.vrf_network_state)]
    pub vrf_network_state: UncheckedAccount<'info>,

    /// CHECK: ORAO's fee treasury (`network_state.config.treasury`). ORAO
    /// rejects any other account, so it is only forwarded here.
    #[account(mut)]
    pub vrf_treasury: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF program.
    #[account(address = vrf::ORAO_VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// Boxed: unboxed, this struct's `try_accounts` overflows the BPF stack frame
// (Pool, Round's 36-tile array and Player combined), the same issue
// `Payout` in `epochs.rs` already works around.
/// Permissionless (production-hardening ticket 01): `caller` may be any
/// signer, only paying the transaction's fee. Every precondition below
/// (status, fulfilled randomness) is unchanged, and `house` still pins to
/// `pool.operator`'s Player, never to `caller`.
#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,

    /// CHECK: ORAO randomness account for this round's seed, verified
    /// against `vrf::randomness_address` (via `vrf::read_fulfilled`).
    pub randomness: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), house.owner.as_ref()],
        bump = house.bump,
        constraint = house.key() == pool.house @ HexVaultError::InvalidParameter,
    )]
    pub house: Box<Account<'info, Player>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,
}

// Boxed: Pool and Player's growth in hexo-referrals ticket 04 (bonus_*
// fields) tipped this struct's `try_accounts` over the BPF stack frame, the
// same issue `SettleRound` above already works around.
#[derive(Accounts)]
pub struct SettlePosition<'info> {
    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    // Mut: `settle_position` decrements `open_positions` (ops-and-envs
    // ticket 05), so `close_round` can tell when every Position on this
    // Round has settled.
    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Box<Account<'info, Round>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    /// CHECK: rent destination for the closed Position; must be its owner.
    #[account(mut, address = position.owner)]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [SEED_POSITION, round.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.owner == player.owner @ HexVaultError::InvalidParameter,
    )]
    pub position: Account<'info, Position>,
}

/// Permissionless (production-hardening ticket 01): `caller` may be any
/// signer, only paying the transaction's fee.
#[derive(Accounts)]
pub struct VoidRound<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: ORAO randomness account for this round's seed, matched against
    /// `vrf::randomness_address` in the handler the same way `settle_round`
    /// does. It need not exist: an unfulfilled request is the normal case
    /// here.
    pub randomness: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = operator)]
    pub pool: Account<'info, Pool>,

    /// CHECK: rent destination; the `has_one` above pins it to `pool.operator`.
    #[account(mut)]
    pub operator: UncheckedAccount<'info>,

    #[account(
        mut,
        close = operator,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}
