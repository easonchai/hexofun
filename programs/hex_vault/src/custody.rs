//! Pool lifecycle and Principal custody (spec §2.3 "Custody").
//!
//! `deposit`, `request_withdraw` and `process_withdraw` are permissionless.
//! `set_params`, `set_operator`, `propose_admin` and unpausing are
//! admin-only via `has_one = admin` on the Pool account; pausing takes the
//! admin or the operator, so `SetPause` names its signer `signer` and the
//! handler decides.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{
    impaired_cause, venue_kind, MAX_IDLE_TARGET_BPS, MAX_LOSS_TOLERANCE_BPS, MAX_MIN_VENUE_MOVE,
    MAX_RESERVE_LIQUIDITY_FLOOR_BPS, MAX_RESERVE_SHARE_CAP_BPS, MAX_YIELD_FEE_BPS,
    MIN_RESERVE_LIQUIDITY_FLOOR_BPS,
    BPS_DENOMINATOR, DEFAULT_IDLE_FLOOR_BPS, DEFAULT_IDLE_TARGET_BPS, DEFAULT_LOSS_TOLERANCE_BPS,
    DEFAULT_MIN_VENUE_MOVE, DEFAULT_RESERVE_LIQUIDITY_FLOOR_BPS, DEFAULT_RESERVE_SHARE_CAP_BPS,
    DEFAULT_YIELD_FEE_BPS, LAYOUT_VERSION, MIN_PAYOUT_TIMEOUT, MIN_VRF_TIMEOUT,
    SEED_JACKPOT, SEED_PLAYER, SEED_POOL, SEED_PRINCIPAL, SEED_VENUE_PROPOSAL,
    WEIGHT_TREE_VERSION,
};
use crate::errors::HexVaultError;
use crate::events::{
    AdminChanged, AdminProposed, Deposited, EmergencyWithdrawn, FeaturePaused, HouseSwept,
    OperatorChanged, ParamsSet, Paused, PoolCreated, PoolShutdown, TicketsBought, TicketsGranted,
    VenueDeployed, WithdrawCancelled, WithdrawRequested, Withdrawn,
    // yield-claimer ticket 07
    Harvested, TreasuryAccountsSet, VenueRecalled,
    // yield-claimer ticket 10
    DeficitCovered, DeployPauseSet, ImpairedCleared, VenueParamsSet,
};
use crate::state::{Player, Pool, WeightTree, WEIGHT_TREE_NODE_SIZE};
use crate::sync::{absorb_dust, haircut, realise_loss, settle, settle_before_growth};
use crate::touch::touch;
use crate::utils;
use crate::venue::{self, Funds, Venue};
use crate::weight::{self, Change};

/// Which switch `set_feature_pause` changes (game-jackpot-pause ticket 01).
/// `set_pause`'s own `paused` field is untouched by either variant.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PauseFeature {
    Game,
    Jackpot,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolParams {
    pub pool_id: u64,
    /// Role keys, not accounts: neither has to sign `create_pool`, and on
    /// mainnet the admin is a multisig that cannot.
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub vrf_network_state: Pubkey,
    pub epoch_seconds: i64,
    pub epoch_anchor: i64,
    pub round_seconds: i64,
    pub close_buffer: i64,
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub house_cut_bps: u16,
    pub min_jackpot: u64,
    pub payout_timeout: i64,
    /// Ceiling on the depositor share, as an annual rate in basis points,
    /// capped at `BPS_DENOMINATOR`. No floor.
    pub base_rate_bps: u16,
    /// Tickets credited per USDC spent in `buy_tickets`. Must be > 0.
    pub tickets_per_usdc: u16,
    /// Share of `total_principal`, in basis points, an operator
    /// `grant_tickets` call may credit pool-wide per epoch. Capped at
    /// `BPS_DENOMINATOR`.
    pub bonus_cap_bps: u16,
    /// A `constants::venue_kind` value: 0 klend, 1 stub (a `test-venue` build
    /// only), 2 kVault. Which backing the four venue accounts belong to, and so
    /// what each is: see `Pool::klend_program` to `klend_ctoken`. Refused unless
    /// this build supports it. A kVault pool's four pins are checked against
    /// the vault state (`VaultPinMismatch`, `VaultMintMismatch`,
    /// `VaultStateUnreadable`).
    pub venue_kind: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SetParamsArgs {
    pub epoch_seconds: Option<i64>,
    pub epoch_anchor: Option<i64>,
    pub round_seconds: Option<i64>,
    pub close_buffer: Option<i64>,
    pub vrf_timeout: Option<i64>,
    pub min_deposit: Option<u64>,
    pub house_cut_bps: Option<u16>,
    pub min_jackpot: Option<u64>,
    pub payout_timeout: Option<i64>,
    pub base_rate_bps: Option<u16>,
    pub tickets_per_usdc: Option<u16>,
    pub bonus_cap_bps: Option<u16>,
}

pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
    // Nobody holds the default key, so either of these would brick every
    // admin path (or every crank) on a pool that cannot be fixed afterwards.
    require!(
        params.admin != Pubkey::default() && params.operator != Pubkey::default(),
        HexVaultError::InvalidParameter
    );
    require!(
        params.epoch_seconds > 0
            && params.epoch_anchor > 0
            && params.round_seconds > 0
            && params.vrf_timeout >= MIN_VRF_TIMEOUT,
        HexVaultError::InvalidParameter
    );
    require!(
        params.close_buffer >= 0 && params.close_buffer < params.round_seconds,
        HexVaultError::InvalidParameter
    );
    require!(
        params.house_cut_bps <= BPS_DENOMINATOR,
        HexVaultError::InvalidParameter
    );
    require!(
        params.base_rate_bps <= BPS_DENOMINATOR,
        HexVaultError::InvalidParameter
    );
    require!(
        params.tickets_per_usdc > 0,
        HexVaultError::InvalidParameter
    );
    require!(
        params.bonus_cap_bps <= BPS_DENOMINATOR,
        HexVaultError::InvalidParameter
    );
    // Zero would let the operator roll a Drawn epoch over in the same block
    // it was drawn in, which is the thing `payout_timeout` exists to stop.
    require!(
        params.payout_timeout >= MIN_PAYOUT_TIMEOUT,
        HexVaultError::InvalidParameter
    );
    // Transfer-fee and other Token-2022 extensions would break the
    // vault-balance arithmetic every payout depends on, so only the classic
    // program's mints are accepted.
    require!(
        ctx.accounts.accepted_mint.to_account_info().owner == &spl_token::ID,
        HexVaultError::UnsupportedMint
    );

    require!(
        venue_kind::supported(params.venue_kind),
        HexVaultError::UnsupportedVenueKind
    );
    // A default key would pin a venue nobody can ever pass, bricking deploy
    // and every instruction that syncs.
    let klend_program = ctx.accounts.klend_program.key();
    let klend_market = ctx.accounts.klend_market.key();
    let klend_reserve = ctx.accounts.klend_reserve.key();
    let klend_ctoken = ctx.accounts.klend_ctoken.key();
    require!(
        klend_program != Pubkey::default()
            && klend_market != Pubkey::default()
            && klend_reserve != Pubkey::default()
            && klend_ctoken != Pubkey::default(),
        HexVaultError::InvalidParameter
    );
    // Every deploy sends cTokens here and every redeem draws them back, so
    // an account the pool PDA does not own strands the lot. The mint is
    // still checked against the reserve at the first sync.
    // The stub venue's vault is a PDA that `test_venue_init` creates after
    // this instruction, so a pool of the stub kind skips the check. Only a
    // test-venue build accepts that kind.
    if params.venue_kind != venue_kind::STUB {
        let ctoken_info = ctx.accounts.klend_ctoken.to_account_info();
        require!(
            ctoken_info.owner == &spl_token::ID
                && spl_token::state::Account::unpack(&ctoken_info.try_borrow_data()?)
                    .map_or(false, |a| a.owner == ctx.accounts.pool.key()),
            HexVaultError::InvalidParameter
        );
    }
    // A kVault pool pins its vault state, shares mint and shares account too:
    // each is checked against the vault state, with named errors.
    if params.venue_kind == venue_kind::KVAULT {
        venue::check_kvault_pins(
            &ctx.accounts.klend_program.to_account_info(),
            &ctx.accounts.klend_market.to_account_info(),
            &ctx.accounts.klend_reserve.to_account_info(),
            &ctx.accounts.klend_ctoken.to_account_info(),
            &ctx.accounts.accepted_mint.key(),
            &ctx.accounts.pool.key(),
        )?;
    }
    // Same bound `set_params` holds.
    require!(
        params.payout_timeout < params.epoch_seconds,
        HexVaultError::InvalidParameter
    );

    let pool_key = ctx.accounts.pool.key();
    // The tree starts with zero nodes and gains one per first deposit. The
    // House takes leaf 1 below. `zero` on the account struct already checked
    // that it is ours and uninitialised.
    let tree_key = ctx.accounts.weight_tree.key();
    {
        let mut tree = ctx.accounts.weight_tree.load_init()?;
        tree.version = WEIGHT_TREE_VERSION;
        tree.node_size = WEIGHT_TREE_NODE_SIZE;
        tree.node_count = 0;
        tree.pool = pool_key;
    }

    let pool = &mut ctx.accounts.pool;
    pool.pool_id = params.pool_id;
    pool.admin = params.admin;
    pool.operator = params.operator;
    pool.pending_admin = Pubkey::default();
    pool.accepted_mint = ctx.accounts.accepted_mint.key();
    pool.principal_vault = ctx.accounts.principal_vault.key();
    pool.jackpot_vault = ctx.accounts.jackpot_vault.key();
    pool.treasury = ctx.accounts.treasury.key();
    pool.buyback_reserve = ctx.accounts.buyback_reserve.key();
    pool.house = ctx.accounts.house.key();
    pool.vrf_network_state = params.vrf_network_state;
    pool.epoch_seconds = params.epoch_seconds;
    pool.epoch_anchor = params.epoch_anchor;
    pool.round_seconds = params.round_seconds;
    pool.close_buffer = params.close_buffer;
    pool.vrf_timeout = params.vrf_timeout;
    pool.min_deposit = params.min_deposit;
    pool.house_cut_bps = params.house_cut_bps;
    pool.min_jackpot = params.min_jackpot;
    pool.payout_timeout = params.payout_timeout;
    pool.pending_withdrawals = 0;
    pool.jackpot_reserved = 0;
    pool.base_rate_bps = params.base_rate_bps;
    pool.tickets_per_usdc = params.tickets_per_usdc;
    pool.bonus_cap_bps = params.bonus_cap_bps;
    pool.bonus_epoch = 0;
    pool.bonus_granted = 0;
    pool.version = LAYOUT_VERSION;
    pool.paused = false;
    pool.weight_tree = tree_key;
    // The four venue addresses are pinned here: every venue
    // instruction checks its accounts against them (`venue::check`), and
    // `migrate_venue` is the only way to repin them (ADR 0023). The rest
    // of the yield state starts at zero.
    pool.klend_program = klend_program;
    pool.klend_market = klend_market;
    pool.klend_reserve = klend_reserve;
    pool.klend_ctoken = klend_ctoken;
    pool.venue_kind = params.venue_kind;
    pool.yield_fee_bps = DEFAULT_YIELD_FEE_BPS;
    pool.idle_floor_bps = DEFAULT_IDLE_FLOOR_BPS;
    pool.idle_target_bps = DEFAULT_IDLE_TARGET_BPS;
    pool.reserve_share_cap_bps = DEFAULT_RESERVE_SHARE_CAP_BPS;
    pool.reserve_liquidity_floor_bps = DEFAULT_RESERVE_LIQUIDITY_FLOOR_BPS;
    pool.min_venue_move = DEFAULT_MIN_VENUE_MOVE;
    pool.loss_tolerance_bps = DEFAULT_LOSS_TOLERANCE_BPS;
    // The game and the jackpot start only once the admin explicitly turns
    // each on (spec "Solution"): a deposit-only launch week needs no
    // operator-side date check. `shutdown` is the only other place that
    // touches these.
    pool.game_paused = true;
    pool.jackpot_paused = true;
    pool.current_epoch_id = 0;
    pool.current_epoch_start = 0;
    pool.current_epoch_ends_at = 0;
    pool.previous_epoch_start = 0;
    pool.previous_epoch_ends_at = 0;
    pool.next_round_id = 1;
    pool.open_round_id = 0;
    pool.total_principal = 0;
    pool.bump = ctx.bumps.pool;
    pool.principal_vault_bump = ctx.bumps.principal_vault;
    pool.jackpot_vault_bump = ctx.bumps.jackpot_vault;

    // The House holds no Principal and starts in epoch 0 like the pool
    // itself; `touch` brings it into epoch 1 the first time anything reads
    // or changes it, same as any other Player. It never earns yield, so its
    // `yield_index` stays 0.
    let house = &mut ctx.accounts.house;
    house.owner = params.operator;
    house.principal = 0;
    house.entries = 0;
    house.epoch_id = 0;
    house.is_house = true;
    house.bump = ctx.bumps.house;
    house.pending_withdraw = 0;
    house.pending_epoch = 0;
    house.requested_at = 0;
    house.version = LAYOUT_VERSION;
    // The House never deposits but it holds Tickets (forfeited pots, the cut),
    // so it can win the draw and needs a leaf. The creator pays its rent.
    house.leaf_index = weight::append_leaves(
        &ctx.accounts.weight_tree,
        pool,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        1,
    )?;

    emit!(PoolCreated {
        pool: pool.key(),
        pool_id: pool.pool_id,
        admin: pool.admin,
        operator: pool.operator,
        accepted_mint: pool.accepted_mint,
    });
    Ok(())
}

pub fn set_params(ctx: Context<SetParams>, params: SetParamsArgs) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    if let Some(v) = params.epoch_seconds {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.epoch_seconds = v;
    }
    if let Some(v) = params.epoch_anchor {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.epoch_anchor = v;
    }
    if let Some(v) = params.round_seconds {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.round_seconds = v;
    }
    if let Some(v) = params.close_buffer {
        require!(
            v >= 0 && v < pool.round_seconds,
            HexVaultError::InvalidParameter
        );
        pool.close_buffer = v;
    }
    if let Some(v) = params.vrf_timeout {
        require!(v >= MIN_VRF_TIMEOUT, HexVaultError::InvalidParameter);
        pool.vrf_timeout = v;
    }
    if let Some(v) = params.min_deposit {
        pool.min_deposit = v;
    }
    if let Some(v) = params.house_cut_bps {
        require!(v <= BPS_DENOMINATOR, HexVaultError::InvalidParameter);
        pool.house_cut_bps = v;
    }
    if let Some(v) = params.min_jackpot {
        pool.min_jackpot = v;
    }
    if let Some(v) = params.payout_timeout {
        require!(v >= MIN_PAYOUT_TIMEOUT, HexVaultError::InvalidParameter);
        pool.payout_timeout = v;
    }
    if let Some(v) = params.base_rate_bps {
        require!(v <= BPS_DENOMINATOR, HexVaultError::InvalidParameter);
        pool.base_rate_bps = v;
    }
    if let Some(v) = params.tickets_per_usdc {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.tickets_per_usdc = v;
    }
    if let Some(v) = params.bonus_cap_bps {
        require!(v <= BPS_DENOMINATOR, HexVaultError::InvalidParameter);
        pool.bonus_cap_bps = v;
    }
    // Checked on the result rather than in the branches above, so changing
    // two of these in one call is judged on where they end up
    // (beta-launch-fixes ticket 03): a `payout_timeout` at or above
    // `epoch_seconds` would let an honest late Payout roll over into the
    // very epoch that is supposed to follow it, and a `round_seconds` at or
    // below `close_buffer` would reject every Position on the next Round
    // created.
    require!(
        pool.payout_timeout < pool.epoch_seconds,
        HexVaultError::InvalidParameter
    );
    require!(
        pool.round_seconds > pool.close_buffer,
        HexVaultError::InvalidParameter
    );

    emit!(ParamsSet {
        pool: pool.key(),
        epoch_seconds: pool.epoch_seconds,
        epoch_anchor: pool.epoch_anchor,
        round_seconds: pool.round_seconds,
        close_buffer: pool.close_buffer,
        vrf_timeout: pool.vrf_timeout,
        min_deposit: pool.min_deposit,
        house_cut_bps: pool.house_cut_bps,
        min_jackpot: pool.min_jackpot,
        payout_timeout: pool.payout_timeout,
        base_rate_bps: pool.base_rate_bps,
        tickets_per_usdc: pool.tickets_per_usdc,
        bonus_cap_bps: pool.bonus_cap_bps,
    });
    Ok(())
}

pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let signer = ctx.accounts.signer.key();
    // Pausing is the emergency stop, so the hot operator key reaches it too.
    // Coming back out is an admin decision, which is why this cannot be a
    // plain `has_one` on the account struct.
    let allowed = signer == pool.admin || (paused && signer == pool.operator);
    require!(allowed, HexVaultError::Unauthorized);
    // Shutdown is irreversible: unpausing would resume deposits, tickets and
    // the game a `shutdown()` already stopped for good.
    require!(paused || !pool.shutdown, HexVaultError::PoolShutDown);

    pool.paused = paused;
    emit!(Paused {
        pool: pool.key(),
        paused,
    });
    Ok(())
}

/// Sets the game or the jackpot switch on its own (game-jackpot-pause ticket
/// 01), so an admin can start or stop either without touching the other or
/// `set_pause`'s deposit/withdraw gate. Same role rule as `set_pause`: the
/// admin either way, the operator pause-only, and unpausing refused once
/// `shutdown` has fired.
pub fn set_feature_pause(
    ctx: Context<SetFeaturePause>,
    feature: PauseFeature,
    paused: bool,
) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let signer = ctx.accounts.signer.key();
    let allowed = signer == pool.admin || (paused && signer == pool.operator);
    require!(allowed, HexVaultError::Unauthorized);
    // Shutdown already set both switches on for good; unpausing either one
    // would restart what it stopped.
    require!(paused || !pool.shutdown, HexVaultError::PoolShutDown);

    match feature {
        PauseFeature::Game => pool.game_paused = paused,
        PauseFeature::Jackpot => pool.jackpot_paused = paused,
    }

    emit!(FeaturePaused {
        pool: pool.key(),
        feature,
        paused,
        at: now,
    });
    Ok(())
}

/// Admin-only, irreversible (spec "Shutdown"). Stops every inflow, the game
/// and the draw, and lets `process_withdraw` skip the epoch lock. Modelled
/// on Marginfi/Kamino `ReduceOnly`: from here on, depositors pull their own
/// money instead of the pool paying them out.
pub fn shutdown(ctx: Context<Shutdown>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    require!(!pool.shutdown, HexVaultError::PoolShutDown);

    pool.shutdown = true;
    pool.paused = true;
    pool.game_paused = true;
    pool.jackpot_paused = true;
    emit!(PoolShutdown {
        pool: pool.key(),
        at: now,
    });
    Ok(())
}

pub fn set_operator(ctx: Context<SetOperator>, new_operator: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let previous = pool.operator;
    pool.operator = new_operator;
    emit!(OperatorChanged {
        pool: pool.key(),
        previous,
        operator: new_operator,
    });
    Ok(())
}

/// Half a handover. Calling it again replaces the pending proposal, and
/// proposing `Pubkey::default()` cancels one.
pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.pending_admin = new_admin;
    emit!(AdminProposed {
        pool: pool.key(),
        pending_admin: new_admin,
    });
    Ok(())
}

/// The other half, signed by the proposed key, so a typo in `propose_admin`
/// leaves the pool with the admin it already had.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(
        pool.pending_admin != Pubkey::default(),
        HexVaultError::NoPendingAdmin
    );
    require_keys_eq!(
        ctx.accounts.pending_admin.key(),
        pool.pending_admin,
        HexVaultError::Unauthorized
    );

    let previous = pool.admin;
    pool.admin = pool.pending_admin;
    pool.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        pool: pool.key(),
        previous,
        admin: pool.admin,
    });
    Ok(())
}

pub fn deposit<'info>(ctx: Context<'info, Deposit<'info>>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    // Sync before a fresh Player is stamped, so it starts at the index after
    // any gain the venue already paid and never earns that gain.
    venue::sync(&mut a.pool, &venue)?;

    let pool = &mut a.pool;
    let player = &mut a.player;

    // Stamps a fresh Player with the current epoch and Yield index, or is a
    // no-op on an existing one.
    player.init_if_fresh(a.owner.key(), pool, ctx.bumps.player);
    touch(player, pool);
    let owed = settle_before_growth(pool, player)?;
    let mut change = Change::default();
    change.settled(owed)?;

    require!(!player.is_house, HexVaultError::HouseCannotDeposit);
    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.paused, HexVaultError::PoolPaused);
    // A deposit into a short pool would take the haircut share of its money at
    // once. It reopens when the deficit clears.
    require!(!pool.impaired, HexVaultError::PoolImpaired);
    require!(
        amount >= pool.min_deposit,
        HexVaultError::BelowMinimumDeposit
    );

    // A first deposit appends this Player's leaf and the depositor pays the
    // rent for it. Refused with `WeightTreeFull` before anything moves if
    // the account would pass 10 MiB.
    if player.leaf_index == 0 {
        player.leaf_index = weight::append_leaves(
            &a.weight_tree,
            pool,
            &a.owner.to_account_info(),
            &a.system_program.to_account_info(),
            1,
        )?;
    }

    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.owner_token.to_account_info(),
                mint: a.accepted_mint.to_account_info(),
                to: a.principal_vault.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
        a.accepted_mint.decimals,
    )?;

    player.principal = player
        .principal
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // The deposit earns no Ticket in this epoch (ADR 0020): Tickets stay as
    // they are and the tree gets a Principal delta only. The next epoch's reset
    // folds it in, on a touch or lazily from the tree's `principal_sum`.
    player.pending_deposit = player
        .pending_deposit
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.pending_deposit_epoch = pool.current_epoch_id;
    pool.total_principal = pool
        .total_principal
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    change.principal(i128::from(amount))?;
    weight::apply(&a.weight_tree, pool, player, change)?;

    emit!(Deposited {
        owner: a.owner.key(),
        amount,
        principal: player.principal,
        entries: player.entries,
    });
    Ok(())
}

/// The one exit for a depositor (ADR 0020). The amount splits in two.
///
/// The part up to `pending_deposit` never held a Ticket, so it refunds at once.
/// It pays from free idle, the vault balance minus Pending withdrawals, so USDC
/// queued for a payout is never spent here. When free idle is short the gap is
/// redeemed from the venue in this instruction. A venue that cannot cover the
/// gap fails with `VenueIlliquid` before the redeem CPI, and nothing changes.
/// While the pool is impaired the refund pays the haircut value
/// (`sync::haircut`), and Principal still falls by the whole refund.
///
/// The rest queues (ADR 0009). It raises `pending_withdraw` and re-stamps
/// `pending_epoch` and `requested_at`, and moves no USDC, Principal, Tickets,
/// `total_principal` or tree weight: the amount stays in today's draw, the game
/// and the yield until `process_withdraw` pays it. A second request that queues
/// something merges into the first and re-stamps the maturity. A request the
/// refund covers whole leaves the maturity alone.
///
/// A queued amount is a sub-balance of Principal, so one request can take at
/// most Principal minus what is already queued. There is no Tickets rule: a
/// Player who lost Tickets in a round still gets every unit of Principal.
///
/// Allowed while paused or shut down.
pub fn request_withdraw<'info>(
    ctx: Context<'info, RequestWithdraw<'info>>,
    amount: u64,
) -> Result<()> {
    let now = utils::now()?;
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    let (_, read) = venue::sync(&mut a.pool, &venue)?;
    touch(&mut a.player, &a.pool);
    // Yield earned so far joins Principal first, so it can be requested too.
    let owed = settle(&mut a.pool, &mut a.player)?;
    let mut change = Change::default();
    change.settled(owed)?;

    // Invariant 3: a withdrawal is never blocked by `paused`.
    require!(amount > 0, HexVaultError::ZeroAmount);
    // Queued Principal cannot be asked for twice. `pending_withdraw` never
    // passes `principal`, so the saturation only guards the subtraction.
    require!(
        amount <= a.player.principal.saturating_sub(a.player.pending_withdraw),
        HexVaultError::InsufficientPrincipal
    );

    let refund = amount.min(a.player.pending_deposit);
    let queued = amount - refund;

    let mut paid = 0;
    let mut redeemed = 0;
    if refund > 0 {
        // Impaired, the refund pays the haircut value (ticket 10). Worked out
        // before the redeem moves value from the venue to the vault, which does
        // not change the sum it reads.
        paid = haircut(&a.pool, a.principal_vault.amount, refund);

        // Saturating: a vault that holds less than is queued has no free idle,
        // and the whole payment is the gap.
        let free_idle = a
            .principal_vault
            .amount
            .saturating_sub(a.pool.pending_withdrawals);
        let gap = paid.saturating_sub(free_idle);
        if gap > 0 {
            // The venue's own value, not the booked one, as in `recall`. The
            // backing also refuses a gap above the reserve's free liquidity
            // before its CPI.
            require!(gap <= read, HexVaultError::VenueIlliquid);
            let before = a.principal_vault.amount;
            let funds = Funds {
                vault: &a.principal_vault,
                mint: &a.accepted_mint,
                token_program: &a.token_program,
            };
            venue::redeem(&a.pool, &venue, &funds, gap)?;
            let after = venue::value(&a.pool, &venue)?;
            let fall = read
                .checked_sub(after)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            a.principal_vault.reload()?;
            let received = a.principal_vault.amount.saturating_sub(before);
            require!(received >= gap, HexVaultError::VenueShortReturn);
            // Book the fall now so the redeem is not a loss at the next sync.
            // What the value fell by beyond what arrived is rounding dust,
            // charged to the fee owed and floored at zero, as in `recall`.
            a.pool.venue_value = a.pool.venue_value.saturating_sub(fall);
            absorb_dust(&mut a.pool, fall.saturating_sub(received))?;
            redeemed = gap;
        }

        // Principal and the pending deposit fall together, and Tickets stay:
        // these units never held one.
        a.player.principal = a
            .player
            .principal
            .checked_sub(refund)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        a.player.pending_deposit = a
            .player
            .pending_deposit
            .checked_sub(refund)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        a.pool.total_principal = a
            .pool
            .total_principal
            .checked_sub(refund)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        change.principal(-i128::from(refund))?;
        // The loss this refund realised leaves the deficit, and takes no part
        // in a later recovery.
        clear_if_realised(a.pool.key(), &mut a.pool, refund - paid, impaired_cause::WITHDRAWAL);
    }

    if queued > 0 {
        a.player.pending_withdraw = a
            .player
            .pending_withdraw
            .checked_add(queued)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        a.pool.pending_withdrawals = a
            .pool
            .pending_withdrawals
            .checked_add(queued)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        a.player.pending_epoch = a.pool.current_epoch_id;
        a.player.requested_at = now;
    }
    weight::apply(&a.weight_tree, &a.pool, &a.player, change)?;

    if paid > 0 {
        let pool_id_bytes = a.pool.pool_id.to_le_bytes();
        let pool_bump = [a.pool.bump];
        let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.principal_vault.to_account_info(),
                    mint: a.accepted_mint.to_account_info(),
                    to: a.owner_token.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            paid,
            a.accepted_mint.decimals,
        )?;
    }

    emit!(WithdrawRequested {
        owner: a.owner.key(),
        amount,
        pending: a.player.pending_withdraw,
        pending_epoch: a.player.pending_epoch,
        refunded: refund,
        paid,
        redeemed,
    });
    Ok(())
}

/// Pays a matured request. Not impaired, no signer at all: the operator pushes
/// these every epoch, and the depositor (or anyone) can push their own if it
/// does not. Impaired, the payout is the haircut value, so the Player's owner
/// must sign for it (`OwnerSignatureRequired`).
///
/// Refused with `OpenPositions` while the Player has a Position on the board,
/// because the stake would come back at settle to a Player whose Principal has
/// left. Anyone can settle a finished Position, then this goes through.
///
/// Syncs, settles and touches first, so the yield earned up to this second
/// stays with the Player and the Tickets reset has run. Then Principal falls by
/// the pending amount, Tickets by the same with a floor at zero, and
/// `total_principal` and the tree follow. While the pool is impaired the payout
/// is the haircut value of the pending amount as of this second, and what the
/// Player gave up comes off the deficit.
pub fn process_withdraw<'info>(ctx: Context<'info, ProcessWithdraw<'info>>) -> Result<()> {
    let now = utils::now()?;
    let a = &mut *ctx.accounts;

    let pending = a.player.pending_withdraw;
    require!(pending > 0, HexVaultError::NothingPending);
    // Either the epoch the request was made in has been left behind, or a
    // whole epoch's worth of seconds has passed since the request. The
    // second can never come first while the operator is alive, because the
    // epoch the request landed in ends within `epoch_seconds` of it; it is
    // the escape hatch for an operator that stopped calling `begin_epoch`.
    let deadline = a
        .player
        .requested_at
        .checked_add(a.pool.epoch_seconds)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // Shutdown lets a request and its payout land in one transaction: a
    // depositor pulls their own money instead of waiting on the epoch lock.
    require!(
        a.pool.shutdown || a.pool.current_epoch_id > a.player.pending_epoch || now > deadline,
        HexVaultError::WithdrawalNotDue
    );
    require!(
        a.player.open_positions == 0,
        HexVaultError::OpenPositions
    );

    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    venue::sync(&mut a.pool, &venue)?;
    // After the sync, which can set or clear the impaired flag.
    require!(
        !a.pool.impaired || a.owner.is_some(),
        HexVaultError::OwnerSignatureRequired
    );
    touch(&mut a.player, &a.pool);
    let owed = settle(&mut a.pool, &mut a.player)?;
    let mut change = Change::default();
    change.settled(owed)?;

    // Impaired, the request pays the haircut value as of this sync. Not
    // impaired, that is `pending`.
    let paid = haircut(&a.pool, a.principal_vault.amount, pending);
    // Checked before anything is written, so a vault still waiting on the
    // yield venue leaves the request exactly as it was for the next attempt.
    require!(
        a.principal_vault.amount >= paid,
        HexVaultError::InsufficientVaultLiquidity
    );

    a.player.principal = a
        .player
        .principal
        .checked_sub(pending)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // No Tickets rule: Tickets the Player lost in a round floor at zero, as the
    // epoch reset would have done. The same floor covers yield settled above
    // and withdrawn in this epoch: it raised Principal and never held Tickets
    // (principal 110, entries 100, withdraw 10 leaves entries 90). That costs
    // the Player 10 Tickets they never had, and is accepted over a per-epoch
    // "unticketed Principal" counter (ADR 0020).
    let entries_before = a.player.entries;
    a.player.entries = entries_before.saturating_sub(pending);
    change.principal(-i128::from(pending))?;
    change.tickets(-i128::from(entries_before - a.player.entries))?;
    weight::apply(&a.weight_tree, &a.pool, &a.player, change)?;
    a.pool.total_principal = a
        .pool
        .total_principal
        .checked_sub(pending)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    a.player.pending_withdraw = 0;
    a.pool.pending_withdrawals = a
        .pool
        .pending_withdrawals
        .checked_sub(pending)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    clear_if_realised(a.pool.key(), &mut a.pool, pending - paid, impaired_cause::WITHDRAWAL);

    let pool_id_bytes = a.pool.pool_id.to_le_bytes();
    let pool_bump = [a.pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.principal_vault.to_account_info(),
                mint: a.accepted_mint.to_account_info(),
                to: a.owner_token.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        paid,
        a.accepted_mint.decimals,
    )?;

    emit!(Withdrawn {
        owner: a.player.owner,
        amount: paid,
        principal: a.player.principal,
        entries: a.player.entries,
    });
    Ok(())
}

/// Takes back a queued request before it pays. A Pending withdrawal is only a
/// flag on Principal that never left (ADR 0020), so this clears the flag and
/// the pool's reservation and moves no USDC, Principal, Tickets or tree weight.
/// A merged request cancels as one amount.
///
/// Allowed while paused, shut down or impaired and with a Position open, as
/// the request is: nothing leaves the pool. Cancelling while impaired keeps the
/// Player exposed like everyone who never asked to leave.
pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
    let a = &mut *ctx.accounts;
    let amount = a.player.pending_withdraw;
    require!(amount > 0, HexVaultError::NothingPending);
    a.player.pending_withdraw = 0;
    a.pool.pending_withdrawals = a
        .pool
        .pending_withdrawals
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    emit!(WithdrawCancelled {
        owner: a.owner.key(),
        amount,
        pending_epoch: a.player.pending_epoch,
    });
    Ok(())
}

/// Takes a haircut withdrawal's loss off the deficit and, if that took it to
/// zero, emits `ImpairedCleared`.
fn clear_if_realised(pool_key: Pubkey, pool: &mut Pool, loss: u64, cause: u8) {
    if let Some(deficit) = realise_loss(pool, loss) {
        emit!(ImpairedCleared {
            pool: pool_key,
            deficit,
            cause,
        });
    }
}

/// Permissionless (yield-claimer ticket 05). Syncs, then moves idle USDC
/// above the idle target into the venue. Pending withdrawals are not free
/// idle, so they never leave. Refused past the reserve-share cap or when it
/// would leave the reserve under its minimum free liquidity (ticket 10).
pub fn deploy_to_venue<'info>(
    ctx: Context<'info, DeployToVenue<'info>>,
    amount: u64,
) -> Result<()> {
    let a = &mut *ctx.accounts;
    // A proposal account owned by this program means a venue change is open.
    // Absent, it is system-owned (even if someone sent it lamports).
    require!(
        a.venue_proposal.owner != &crate::ID,
        HexVaultError::VenueProposalOpen
    );
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };

    let (_, read) = venue::sync(&mut a.pool, &venue)?;

    let pool = &a.pool;
    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.deploy_paused, HexVaultError::DeployPaused);
    require!(!pool.impaired, HexVaultError::PoolImpaired);
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(
        amount >= pool.min_venue_move,
        HexVaultError::VenueMoveTooSmall
    );

    let free_idle = a
        .principal_vault
        .amount
        .checked_sub(pool.pending_withdrawals)
        .ok_or(HexVaultError::BelowPendingWithdrawals)?;
    let total = u128::from(free_idle)
        .checked_add(u128::from(pool.venue_value))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // Rounded up: the idle band is never undershot by rounding.
    let target = total
        .checked_mul(u128::from(pool.idle_target_bps))
        .and_then(|v| v.checked_add(u128::from(BPS_DENOMINATOR) - 1))
        .ok_or(HexVaultError::ArithmeticOverflow)?
        / u128::from(BPS_DENOMINATOR);
    require!(
        u128::from(amount) <= u128::from(free_idle).saturating_sub(target),
        HexVaultError::DeployExceedsIdle
    );

    // The two reserve caps, judged on the reserve as it will stand afterwards.
    let stats = venue::reserve_stats(&a.pool, &venue)?;
    venue::check_deploy_caps(
        stats,
        read,
        amount,
        a.pool.reserve_share_cap_bps,
        a.pool.reserve_liquidity_floor_bps,
    )?;

    let funds = Funds {
        vault: &a.principal_vault,
        mint: &a.accepted_mint,
        token_program: &a.token_program,
    };
    venue::deposit(&a.pool, &venue, &funds, amount)?;

    // Book only what the deposit itself added to the venue's value, on top of
    // what the pool already recorded, so the deploy is not a gain at the next
    // sync and a gain a same-second sync skipped stays visible to it. The
    // part of `amount` the venue did not credit (rounding) is not the
    // depositors' to lose, so it comes off the fee owed, floored at zero.
    let after = venue::value(&a.pool, &venue)?;
    let rise = after
        .checked_sub(read)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let dust = amount
        .checked_sub(rise)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let pool = &mut a.pool;
    pool.venue_value = pool
        .venue_value
        .checked_add(rise)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    absorb_dust(pool, dust)?;

    emit!(VenueDeployed {
        pool: pool.key(),
        amount,
        venue_value: pool.venue_value,
    });
    Ok(())
}

/// Permissionless (yield-claimer ticket 07). Syncs, then redeems `amount`
/// from the venue into the principal vault.
///
/// Free idle is the vault balance minus Pending withdrawals. It goes negative
/// when the vault holds less than is queued, which is the case recall exists
/// for, so the idle arithmetic is signed.
///
/// Before Shutdown a recall must:
///  - find free idle strictly under the idle target,
///  - leave free idle at or under it, and
///  - be at least `min_venue_move`, unless `amount` is exactly the gap between
///    the vault and `pending_withdrawals`, so a small queued withdrawal can
///    always be made payable.
///
/// After Shutdown none of that applies: the whole position may come home.
pub fn recall<'info>(ctx: Context<'info, Recall<'info>>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };

    let (_, read) = venue::sync(&mut a.pool, &venue)?;

    let pool = &a.pool;
    require!(amount > 0, HexVaultError::ZeroAmount);

    if !pool.shutdown {
        let vault = i128::from(a.principal_vault.amount);
        let free_idle = vault - i128::from(pool.pending_withdrawals);
        // A pool that is solvent never has a negative total; clamp so a
        // broken invariant cannot turn into a negative target.
        let total = (free_idle + i128::from(pool.venue_value)).max(0) as u128;
        // Rounded up, as in `deploy_to_venue`.
        let target = total
            .checked_mul(u128::from(pool.idle_target_bps))
            .and_then(|v| v.checked_add(u128::from(BPS_DENOMINATOR) - 1))
            .ok_or(HexVaultError::ArithmeticOverflow)?
            / u128::from(BPS_DENOMINATOR);
        let target = i128::try_from(target).map_err(|_| error!(HexVaultError::ArithmeticOverflow))?;
        require!(free_idle < target, HexVaultError::RecallNotNeeded);

        let short = pool.pending_withdrawals.saturating_sub(a.principal_vault.amount);
        require!(
            amount >= pool.min_venue_move || (short > 0 && amount == short),
            HexVaultError::VenueMoveTooSmall
        );
        require!(
            free_idle + i128::from(amount) <= target,
            HexVaultError::RecallExceedsTarget
        );
    }

    // The venue's own value, not the booked one: a gain a same-second sync
    // skipped can be recalled too.
    require!(amount <= read, HexVaultError::VenueIlliquid);

    let before = a.principal_vault.amount;
    let funds = Funds {
        vault: &a.principal_vault,
        mint: &a.accepted_mint,
        token_program: &a.token_program,
    };
    venue::redeem(&a.pool, &venue, &funds, amount)?;
    let after = venue::value(&a.pool, &venue)?;
    let fall = read
        .checked_sub(after)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    a.principal_vault.reload()?;
    let received = a.principal_vault.amount.saturating_sub(before);
    require!(received >= amount, HexVaultError::VenueShortReturn);

    // Book the fall in value now, so the recall is not a loss at the next
    // sync. Measured from `read`, so a gain a same-second sync skipped is not
    // booked here; if this recall takes it, it is simply never credited. What
    // the value fell by beyond what arrived is rounding dust: it comes off the
    // fee owed, floored at zero.
    let pool = &mut a.pool;
    pool.venue_value = pool.venue_value.saturating_sub(fall);
    absorb_dust(pool, fall.saturating_sub(received))?;

    emit!(VenueRecalled {
        pool: pool.key(),
        amount,
        venue_value: pool.venue_value,
    });
    Ok(())
}

/// Permissionless (ticket 07). Syncs, redeems the fee owed plus the prize
/// share owed, pays the first to `pool.treasury` and the second to the
/// jackpot vault, and zeroes both. Depositors' yield, every Player and the
/// index are untouched.
///
/// With nothing owed it fails with `NothingToHarvest`, moving no USDC.
///
/// A gain is booked against the venue's value, so the owed USDC is at the
/// venue. The one case where it is not is after a recall that brought the
/// whole position home (Shutdown): then `venue_value` is under what is owed,
/// the rest already sits in the vault, and only `min(owed, venue_value)` is
/// redeemed. If the venue cannot return that much the redeem fails with
/// `VenueIlliquid` and the whole instruction reverts, sync included, with
/// nothing paid and nothing zeroed.
pub fn harvest<'info>(ctx: Context<'info, Harvest<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };

    let (_, read) = venue::sync(&mut a.pool, &venue)?;

    require!(!a.pool.impaired, HexVaultError::PoolImpaired);
    let fee_owed = a.pool.fee_owed;
    let prize_owed = a.pool.prize_owed;
    let owed = fee_owed
        .checked_add(prize_owed)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(owed > 0, HexVaultError::NothingToHarvest);

    let from_venue = owed.min(read);
    let mut dust = 0;
    if from_venue > 0 {
        let before = a.principal_vault.amount;
        let funds = Funds {
            vault: &a.principal_vault,
            mint: &a.accepted_mint,
            token_program: &a.token_program,
        };
        venue::redeem(&a.pool, &venue, &funds, from_venue)?;
        let after = venue::value(&a.pool, &venue)?;
        let fall = read
            .checked_sub(after)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        a.principal_vault.reload()?;
        let received = a.principal_vault.amount.saturating_sub(before);
        require!(received >= from_venue, HexVaultError::VenueShortReturn);
        a.pool.venue_value = a.pool.venue_value.saturating_sub(fall);
        dust = fall.saturating_sub(received);
    }

    // The dust the redeem cost is the fee's to bear: pay that much less, and
    // the vault keeps exactly what the venue lost beyond the redeem.
    // Dust past the fee owed is booked as deficit.
    let pool = &mut a.pool;
    absorb_dust(pool, dust)?;
    let fee_paid = pool.fee_owed;
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];
    for (to, amount) in [
        (a.treasury.to_account_info(), fee_paid),
        (a.jackpot_vault.to_account_info(), prize_owed),
    ] {
        if amount == 0 {
            continue;
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.principal_vault.to_account_info(),
                    mint: a.accepted_mint.to_account_info(),
                    to,
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            a.accepted_mint.decimals,
        )?;
    }

    pool.fee_owed = 0;
    pool.prize_owed = 0;
    emit!(Harvested {
        pool: pool.key(),
        gain: pool.harvest_gain,
        fee: pool.harvest_fee,
        depositor_share: pool.harvest_depositor,
        prize_share: pool.harvest_prize,
        fee_paid,
        prize_paid: prize_owed,
    });
    pool.harvest_gain = 0;
    pool.harvest_fee = 0;
    pool.harvest_depositor = 0;
    pool.harvest_prize = 0;
    Ok(())
}

/// Admin-only (ticket 07). Both accounts must hold the pool's mint. Nothing
/// else is checked, as at `create_pool`: on mainnet they are the multisig's
/// own accounts. `harvest` and `payout` pin their destinations to these two
/// addresses (`has_one`), so the change is the next call's destination.
pub fn set_treasury_accounts(ctx: Context<SetTreasuryAccounts>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.treasury = ctx.accounts.treasury.key();
    pool.buyback_reserve = ctx.accounts.buyback_reserve.key();
    emit!(TreasuryAccountsSet {
        pool: pool.key(),
        treasury: pool.treasury,
        buyback_reserve: pool.buyback_reserve,
    });
    Ok(())
}

/// Turns the deploy switch on or off (ticket 10). Same asymmetry as
/// `set_pause`: the Admin or the Operator key turns it on, only the Admin turns
/// it off, so a stolen Operator key cannot reopen it.
pub fn set_deploy_pause(ctx: Context<SetDeployPause>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let signer = ctx.accounts.signer.key();
    let allowed = signer == pool.admin || (paused && signer == pool.operator);
    require!(allowed, HexVaultError::Unauthorized);

    pool.deploy_paused = paused;
    emit!(DeployPauseSet {
        pool: pool.key(),
        paused,
    });
    Ok(())
}

/// Permissionless (ticket 10). Syncs, then moves `amount` USDC from the
/// caller into the principal vault against the recorded deficit. Capped at the
/// deficit: only that much moves, so overpaying is safe. `impaired` clears when
/// the deficit reaches zero. Fails with `NoDeficit` when there is none.
pub fn cover_deficit<'info>(ctx: Context<'info, CoverDeficit<'info>>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    // A gain since the last sync repays the deficit first, so the cap is the
    // deficit after it.
    venue::sync(&mut a.pool, &venue)?;

    require!(amount > 0, HexVaultError::ZeroAmount);
    let deficit = a.pool.deficit;
    require!(deficit > 0, HexVaultError::NoDeficit);
    let paid = amount.min(deficit);

    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.payer_token.to_account_info(),
                mint: a.accepted_mint.to_account_info(),
                to: a.principal_vault.to_account_info(),
                authority: a.payer.to_account_info(),
            },
        ),
        paid,
        a.accepted_mint.decimals,
    )?;

    let pool = &mut a.pool;
    pool.deficit = deficit - paid;
    if pool.deficit == 0 {
        pool.impaired = false;
        emit!(ImpairedCleared {
            pool: pool.key(),
            deficit,
            cause: impaired_cause::COVER,
        });
    }
    emit!(DeficitCovered {
        pool: pool.key(),
        payer: a.payer.key(),
        amount: paid,
        deficit: pool.deficit,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SetVenueParamsArgs {
    pub yield_fee_bps: Option<u16>,
    pub idle_floor_bps: Option<u16>,
    pub idle_target_bps: Option<u16>,
    pub reserve_share_cap_bps: Option<u16>,
    pub reserve_liquidity_floor_bps: Option<u16>,
    pub min_venue_move: Option<u64>,
    pub loss_tolerance_bps: Option<u16>,
}

/// Admin-only (ticket 10). Each value is bounded by a program constant, and
/// the idle floor may not pass the idle target. The pair is judged on where it
/// ends up, so one call can move both. Pinned venue addresses are not settable.
/// The base rate (`set_params`) is the exception: it has no floor, so the Admin
/// can send all yield above the Yield fee to the Prize.
pub fn set_venue_params(ctx: Context<SetVenueParams>, params: SetVenueParamsArgs) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    if let Some(v) = params.yield_fee_bps {
        require!(v <= MAX_YIELD_FEE_BPS, HexVaultError::InvalidParameter);
        pool.yield_fee_bps = v;
    }
    if let Some(v) = params.idle_floor_bps {
        pool.idle_floor_bps = v;
    }
    if let Some(v) = params.idle_target_bps {
        require!(v <= MAX_IDLE_TARGET_BPS, HexVaultError::InvalidParameter);
        pool.idle_target_bps = v;
    }
    require!(pool.idle_floor_bps <= pool.idle_target_bps, HexVaultError::InvalidParameter);
    if let Some(v) = params.reserve_share_cap_bps {
        require!(v <= MAX_RESERVE_SHARE_CAP_BPS, HexVaultError::InvalidParameter);
        pool.reserve_share_cap_bps = v;
    }
    if let Some(v) = params.reserve_liquidity_floor_bps {
        require!(
            (MIN_RESERVE_LIQUIDITY_FLOOR_BPS..=MAX_RESERVE_LIQUIDITY_FLOOR_BPS).contains(&v),
            HexVaultError::InvalidParameter
        );
        pool.reserve_liquidity_floor_bps = v;
    }
    if let Some(v) = params.min_venue_move {
        require!(v > 0 && v <= MAX_MIN_VENUE_MOVE, HexVaultError::InvalidParameter);
        pool.min_venue_move = v;
    }
    if let Some(v) = params.loss_tolerance_bps {
        require!(v <= MAX_LOSS_TOLERANCE_BPS, HexVaultError::InvalidParameter);
        pool.loss_tolerance_bps = v;
    }

    emit!(VenueParamsSet {
        pool: pool.key(),
        yield_fee_bps: pool.yield_fee_bps,
        idle_floor_bps: pool.idle_floor_bps,
        idle_target_bps: pool.idle_target_bps,
        reserve_share_cap_bps: pool.reserve_share_cap_bps,
        reserve_liquidity_floor_bps: pool.reserve_liquidity_floor_bps,
        min_venue_move: pool.min_venue_move,
        loss_tolerance_bps: pool.loss_tolerance_bps,
    });
    Ok(())
}

/// Permissionless crank while the pool is not impaired, only valid once the
/// pool is shut down: pays one Player's whole Principal, which already holds
/// the pending deposit and the queued withdrawal, to their own USDC ATA, so a
/// depositor gets out even if the team disappears (spec
/// "emergency_withdraw"). Impaired, the payout is the haircut value and the
/// Player's owner must sign for it (`OwnerSignatureRequired`). House is skipped: its principal is protocol money
/// and leaves through `sweep_house` instead.
pub fn emergency_withdraw<'info>(ctx: Context<'info, EmergencyWithdraw<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    venue::sync(&mut a.pool, &venue)?;
    // After the sync, which can set or clear the impaired flag.
    require!(
        !a.pool.impaired || a.owner.is_some(),
        HexVaultError::OwnerSignatureRequired
    );
    let pool = &mut a.pool;
    let player = &mut a.player;
    touch(player, pool);
    // Yield earned so far is paid out with the Principal, in this call.
    let owed = settle(pool, player)?;
    let mut change = Change::default();
    change.settled(owed)?;

    require!(pool.shutdown, HexVaultError::PoolNotShutDown);
    require!(
        !player.is_house,
        HexVaultError::HouseCannotEmergencyWithdraw
    );

    // Principal already holds the pending deposit and the queued withdrawal, so
    // it is the whole claim. Adding `pending_withdraw` would pay that part twice.
    let principal = player.principal;
    let pending = player.pending_withdraw;
    require!(principal > 0, HexVaultError::ZeroAmount);
    // Impaired, the whole balance pays the haircut value (ticket 10).
    let paid = haircut(pool, a.principal_vault.amount, principal);
    // No partial payouts: either the vault covers this Player in full, or
    // nothing moves and the next attempt starts from the same numbers.
    require!(
        a.principal_vault.amount >= paid,
        HexVaultError::InsufficientVault
    );

    change.principal(-i128::from(principal))?;
    change.tickets(-i128::from(player.entries))?;
    weight::apply(&a.weight_tree, pool, player, change)?;
    player.principal = 0;
    player.entries = 0;
    player.pending_deposit = 0;
    player.pending_withdraw = 0;
    pool.total_principal = pool
        .total_principal
        .checked_sub(principal)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.pending_withdrawals = pool
        .pending_withdrawals
        .checked_sub(pending)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    clear_if_realised(pool.key(), pool, principal - paid, impaired_cause::WITHDRAWAL);

    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.principal_vault.to_account_info(),
                mint: a.accepted_mint.to_account_info(),
                to: a.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        paid,
        a.accepted_mint.decimals,
    )?;

    emit!(EmergencyWithdrawn {
        owner: player.owner,
        principal,
        pending,
        total: paid,
    });
    Ok(())
}

/// Admin-only, only valid once the pool is shut down (spec "sweep_house").
/// Moves the jackpot vault's surplus over `jackpot_reserved` to
/// `pool.treasury`. Principal is never swept: the House is a Player like any
/// other and exits through `request_withdraw`; `emergency_withdraw` skips it
/// on purpose. Callable more than once -- a later `fund_jackpot` can be swept
/// again. There is no Yield budget to sweep since the live-yield rewrite.
///
/// `jackpot_reserved` is the amount already promised to a drawn-but-unpaid
/// epoch, released in `payout` or `rollover_epoch`. `payout` still runs
/// after shutdown -- spec "an already-drawn epoch still pays" -- so sweeping
/// that reserved amount would strand its winner.
pub fn sweep_house(ctx: Context<SweepHouse>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    require!(pool.shutdown, HexVaultError::PoolNotShutDown);

    let jackpot = ctx
        .accounts
        .jackpot_vault
        .amount
        .saturating_sub(pool.jackpot_reserved);

    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.jackpot_vault.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        jackpot,
        ctx.accounts.accepted_mint.decimals,
    )?;

    emit!(HouseSwept { jackpot });
    Ok(())
}

/// Resets `bought_amount` to 0 when `bought_epoch` is not `current_epoch_id`,
/// adds `amount`, and checks the result against `principal` (the caller passes
/// the locked Principal, Pending deposit excluded). Returns the new
/// `bought_amount`; the caller still owns stamping `bought_epoch`.
fn bought_amount_after(
    bought_epoch: u64,
    bought_amount: u64,
    current_epoch_id: u64,
    principal: u64,
    amount: u64,
) -> Result<u64> {
    let base = if bought_epoch == current_epoch_id {
        bought_amount
    } else {
        0
    };
    let total = base
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // Also covers "principal > 0": with amount > 0 already required by the
    // caller, a zero Principal fails this the same way an already-spent cap
    // would.
    require!(total <= principal, HexVaultError::DailyBuyCapExceeded);
    Ok(total)
}

/// Spends real USDC on extra Tickets at a fixed price (spec "Bought
/// tickets"). The USDC goes to the jackpot vault and is never returned; the
/// Tickets are ordinary Entries from the moment they land.
///
/// Capped per Player per epoch at locked Principal, checked against the live
/// balance at call time rather than a start-of-day snapshot. `principal` only
/// falls when a refund pays or a queued withdrawal is processed, so a
/// `request_withdraw` before a `buy_tickets` can only tighten this player's remaining allowance for the
/// epoch, never raise it, and `bought_amount` is never reset by anything but
/// an epoch change, so re-depositing withdrawn principal cannot reopen room
/// the player already spent. While the ended epoch is still being drawn,
/// `pool.current_epoch_id` already points at the new epoch, so buying then is
/// an ordinary purchase against the new day's cap, not a way to buy twice
/// against the epoch that just closed.
pub fn buy_tickets(ctx: Context<BuyTickets>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    // Resets stale Tickets first, so the purchase lands on this epoch's.
    touch(player, pool);

    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.paused, HexVaultError::PoolPaused);
    // Bought before Epoch 1 exists would be Entries with no epoch to count in
    // and no epoch boundary to reset them, so they are just lost the moment
    // `begin_epoch` first runs (beta-launch-fixes ticket 03).
    require!(pool.current_epoch_id > 0, HexVaultError::NoEpochYet);
    require!(!pool.jackpot_paused, HexVaultError::JackpotPaused);
    require!(!pool.buy_tickets_paused, HexVaultError::BuyTicketsPaused);
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(!player.is_house, HexVaultError::HouseCannotBuyTickets);

    let bought_amount = bought_amount_after(
        player.bought_epoch,
        player.bought_amount,
        pool.current_epoch_id,
        player.locked_principal(pool.current_epoch_id),
        amount,
    )?;
    player.bought_epoch = pool.current_epoch_id;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    let tickets = amount
        .checked_mul(u64::from(pool.tickets_per_usdc))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.bought_amount = bought_amount;
    player.entries = player
        .entries
        .checked_add(tickets)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let mut change = Change::default();
    change.tickets(i128::from(tickets))?;
    weight::apply(&ctx.accounts.weight_tree, pool, player, change)?;

    emit!(TicketsBought {
        owner: player.owner,
        epoch_id: pool.current_epoch_id,
        usdc: amount,
        tickets,
    });
    Ok(())
}

/// Resets a bonus counter to 0 when its stored epoch is not
/// `current_epoch_id`, adds `amount`, and checks the result against `cap`.
/// Same reset-add-check shape as `bought_amount_after`, shared by
/// `grant_tickets`' per-Player and pool-wide operator caps, which differ only
/// in which counter and cap they check.
fn bonus_after(
    bonus_epoch: u64,
    bonus_granted: u64,
    current_epoch_id: u64,
    cap: u64,
    amount: u64,
    err: HexVaultError,
) -> Result<u64> {
    let base = if bonus_epoch == current_epoch_id {
        bonus_granted
    } else {
        0
    };
    let total = base
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    if total > cap {
        return Err(err.into());
    }
    Ok(total)
}

/// `epoch_start_principal * bonus_cap_bps / 10_000`, the pool-wide operator grant
/// cap for the current epoch. Widens to u128 first, like `yield_for`, since
/// `total_principal * bonus_cap_bps` can overflow u64.
fn pool_bonus_cap(total_principal: u64, bonus_cap_bps: u16) -> Result<u64> {
    let scaled = u128::from(total_principal)
        .checked_mul(u128::from(bonus_cap_bps))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let capped = scaled
        .checked_div(u128::from(BPS_DENOMINATOR))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    u64::try_from(capped).map_err(|_| HexVaultError::ArithmeticOverflow.into())
}

/// Credits playable Tickets to a Player by hand (spec "Granted tickets"),
/// signed by `pool.operator` or `pool.admin`.
///
/// The operator path is capped per Player per epoch at locked Principal and
/// pool-wide per epoch at `epoch_start_principal * bonus_cap_bps / 10_000`, tracked
/// by their own `bonus_epoch`/`bonus_granted` counters (separate from
/// `bought_epoch`/`bought_amount` so a grant and a purchase don't share a
/// cap), and refuses the House. The admin path is uncapped, allows the
/// House, and leaves both counters untouched, for the rare manual fix.
pub fn grant_tickets(ctx: Context<GrantTickets>, amount: u64) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let pool = &mut ctx.accounts.pool;
    let player = &mut ctx.accounts.player;

    let by_admin = signer == pool.admin;
    require!(
        by_admin || signer == pool.operator,
        HexVaultError::Unauthorized
    );

    // Resets stale Tickets first, so the grant lands on this epoch's.
    touch(player, pool);
    // Refused for both the admin and the operator path (production-hardening
    // ticket 02: pause stops all Ticket movement).
    require!(!pool.shutdown, HexVaultError::PoolShutDown);
    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(!pool.jackpot_paused, HexVaultError::JackpotPaused);
    require!(amount > 0, HexVaultError::ZeroAmount);

    if !by_admin {
        require!(!player.is_house, HexVaultError::HouseCannotBeGranted);
        // One grant per referrer per epoch: a resend after a lost
        // confirmation must not grant twice.
        require!(
            player.bonus_epoch != pool.current_epoch_id || player.bonus_granted == 0,
            HexVaultError::AlreadyGranted
        );

        let player_bonus = bonus_after(
            player.bonus_epoch,
            player.bonus_granted,
            pool.current_epoch_id,
            player.locked_principal(pool.current_epoch_id),
            amount,
            HexVaultError::DailyPlayerGrantCapExceeded,
        )?;
        let pool_cap = pool_bonus_cap(pool.epoch_start_principal, pool.bonus_cap_bps)?;
        let pool_bonus = bonus_after(
            pool.bonus_epoch,
            pool.bonus_granted,
            pool.current_epoch_id,
            pool_cap,
            amount,
            HexVaultError::DailyPoolGrantCapExceeded,
        )?;

        player.bonus_epoch = pool.current_epoch_id;
        player.bonus_granted = player_bonus;
        pool.bonus_epoch = pool.current_epoch_id;
        pool.bonus_granted = pool_bonus;
    }

    player.entries = player
        .entries
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let mut change = Change::default();
    change.tickets(i128::from(amount))?;
    weight::apply(&ctx.accounts.weight_tree, pool, player, change)?;

    emit!(TicketsGranted {
        owner: player.owner,
        epoch_id: pool.current_epoch_id,
        amount,
        by_admin,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: CreatePoolParams)]
pub struct CreatePool<'info> {
    /// Pays rent only. The admin and operator come in through `params`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_POOL, &params.pool_id.to_le_bytes()],
        bump,
        space = 8 + Pool::INIT_SPACE,
    )]
    pub pool: Box<Account<'info, Pool>>,

    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [crate::constants::SEED_JACKPOT, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_PLAYER, pool.key().as_ref(), params.operator.as_ref()],
        bump,
        space = 8 + Player::INIT_SPACE,
    )]
    pub house: Box<Account<'info, Player>>,

    /// Created in the same transaction by a top-level
    /// `system_program::create_account`, owned by this program and sized for
    /// the header alone (zero nodes). `zero` refuses one already in use.
    #[account(
        zero,
        constraint = weight_tree.to_account_info().data_len() == 8 + core::mem::size_of::<WeightTree>()
            @ HexVaultError::InvalidParameter,
    )]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    // Only the mint is checked. On mainnet these are the multisig's own
    // accounts, which nothing in this instruction signs for.
    #[account(constraint = treasury.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = buyback_reserve.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    // The venue, pinned onto the Pool below. A klend or stub pool is checked
    // for nothing beyond the default key (on mainnet these are klend's own
    // accounts, which only the Admin's choice of arguments can vouch for); a
    // kVault pool's four are checked against the vault state.
    /// The venue program. klend: the klend program. kVault: the kVault program.
    /// Stub: this program.
    /// CHECK: pinned to `pool.klend_program`.
    pub klend_program: UncheckedAccount<'info>,
    /// The venue market. klend: the lending market. kVault: the vault state
    /// account. Stub: the pool PDA.
    /// CHECK: pinned to `pool.klend_market`.
    pub klend_market: UncheckedAccount<'info>,
    /// The venue reserve. klend: the reserve. kVault: the vault's shares mint.
    /// Stub: the stub reserve PDA.
    /// CHECK: pinned to `pool.klend_reserve`.
    pub klend_reserve: UncheckedAccount<'info>,
    /// The pool's position token account. klend: the pool's cToken account.
    /// kVault: the pool's token account of the shares mint. Stub: the stub
    /// vault PDA.
    /// CHECK: pinned to `pool.klend_ctoken`.
    pub klend_ctoken: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: no signer, like `process_withdraw`. Extra accounts a
/// venue backing needs go in `remaining_accounts`.
#[derive(Accounts)]
pub struct DeployToVenue<'info> {
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
    /// Only its address and owner are read: the handler refuses while this
    /// program owns it (venue-switch ticket 03).
    #[account(seeds = [SEED_VENUE_PROPOSAL, pool.key().as_ref()], bump)]
    pub venue_proposal: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless, same accounts as `DeployToVenue` (ticket 07).
#[derive(Accounts)]
pub struct Recall<'info> {
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

    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless. The two destinations are the Pool's own, so a caller
/// cannot redirect them.
#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = treasury,
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

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = accepted_mint)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

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

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetTreasuryAccounts<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = treasury.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = buyback_reserve.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,
}

/// Same shape as `SetPause`: the signer may be either role, and the handler
/// decides which direction it may move.
#[derive(Accounts)]
pub struct SetDeployPause<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetVenueParams<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

/// Permissionless (ticket 10). Anyone pays; the venue accounts are for the
/// sync that runs first.
#[derive(Accounts)]
pub struct CoverDeficit<'info> {
    pub payer: Signer<'info>,

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

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = payer,
        token::token_program = token_program,
    )]
    pub payer_token: Box<InterfaceAccount<'info, TokenAccount>>,

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

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// Admin or operator. Which one is allowed depends on the direction, so
    /// the handler checks it rather than a `has_one` here.
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

/// Same shape as `SetPause`: the signer may be either role, and the handler
/// decides which direction it may move.
#[derive(Accounts)]
pub struct SetFeaturePause<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct Shutdown<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// Checked in the handler against `pool.pending_admin`, so an unset
    /// proposal fails with `NoPendingAdmin` instead of a constraint error.
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

// Boxed: the layout rewrite's larger Pool pushed `try_accounts` over the BPF
// stack frame.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init_if_needed,
        payer = owner,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump,
        space = 8 + Player::INIT_SPACE,
    )]
    pub player: Box<Account<'info, Player>>,

    /// Grows by one node at this Player's first deposit, `owner` paying.
    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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
    pub system_program: Program<'info, System>,
}

/// Signed by the Player's owner, who is paid straight to `owner_token` when
/// part of the request refunds. The venue accounts are for sync and the redeem;
/// a backing's extras go in `remaining_accounts`.
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
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

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

/// Signed by the Player's owner; touches nothing but the Player and the Pool.
#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,
}

#[derive(Accounts)]
pub struct ProcessWithdraw<'info> {
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Seeded from its own `owner`, which is what makes this safe without a
    /// signer: the destination below has to belong to that same owner.
    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    /// Needed only while the pool is impaired, when this exit pays the haircut
    /// value. Leave it out otherwise.
    #[account(address = player.owner)]
    pub owner: Option<Signer<'info>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = player.owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

/// Permissionless while the pool is not impaired, like `process_withdraw`. The
/// destination below has to belong to `player.owner`, so nobody but the
/// Player's own owner can ever receive the payout.
#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    /// Needed only while the pool is impaired. Leave it out otherwise.
    #[account(address = player.owner)]
    pub owner: Option<Signer<'info>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = player.owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

#[derive(Accounts)]
pub struct SweepHouse<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
        has_one = treasury,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Must already exist: a Player only has a cap to buy against once it
    /// holds Principal.
    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// The signer names neither role directly: it may be either `pool.admin` or
/// `pool.operator`, and the handler decides which, same reasoning as
/// `SetPause`.
#[derive(Accounts)]
pub struct GrantTickets<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Must already exist, like `BuyTickets`': a Player only has a Principal
    /// cap to grant against once it holds one.
    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_purchase_landing_exactly_on_the_cap_succeeds() {
        let bought = bought_amount_after(1, 700, 1, 1_000, 300).expect("at cap");
        assert_eq!(bought, 1_000);
    }

    #[test]
    fn one_more_than_the_cap_fails() {
        assert!(bought_amount_after(1, 700, 1, 1_000, 301)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }

    #[test]
    fn a_new_epoch_resets_the_counter_instead_of_carrying_it_over() {
        // Spent the whole cap in epoch 1; epoch 2 starts fresh even though
        // `bought_amount` on the Player still reads 1_000 from yesterday.
        let bought = bought_amount_after(1, 1_000, 2, 1_000, 1_000).expect("fresh epoch");
        assert_eq!(bought, 1_000);
    }

    #[test]
    fn zero_principal_fails_like_an_exhausted_cap() {
        // The House, or any Player who has never deposited: `principal > 0`
        // is folded into the same check rather than a separate require.
        assert!(bought_amount_after(0, 0, 1, 0, 1)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }

    #[test]
    fn a_request_withdraw_between_two_buys_only_tightens_the_remaining_room() {
        // Same epoch throughout: 1_000 principal, 400 already bought. A
        // request_withdraw drops principal to 500 before the next buy is
        // checked, so at most 100 more clears -- never more than the
        // original 1_000 cap, whichever order the two instructions land in.
        let after_withdraw = bought_amount_after(1, 400, 1, 500, 100).expect("still room");
        assert_eq!(after_withdraw, 500);
        assert!(bought_amount_after(1, 400, 1, 500, 101)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }

    fn player_with(principal: u64, pending_deposit: u64) -> Player {
        let data = vec![0u8; Player::INIT_SPACE];
        let mut p = Player::deserialize(&mut &data[..]).expect("zeroed player");
        p.principal = principal;
        p.pending_deposit = pending_deposit;
        p.pending_deposit_epoch = 1;
        p
    }

    #[test]
    fn a_pending_deposit_gives_no_buy_or_grant_room() {
        // Deposit 1_000 today with nothing locked: the flash sequence buys 1_000
        // against a cap of 0 and is refused.
        let p = player_with(1_000, 1_000);
        assert_eq!(p.locked_principal(1), 0);
        assert!(bought_amount_after(1, 0, 1, p.locked_principal(1), 1).is_err());
        assert!(bonus_after(
            1, 0, 1, p.locked_principal(1), 1, HexVaultError::DailyPlayerGrantCapExceeded
        )
        .is_err());
    }

    #[test]
    fn a_stale_pending_deposit_is_already_locked() {
        assert_eq!(player_with(1_000, 400).locked_principal(2), 1_000);
    }

    #[test]
    fn locked_principal_keeps_the_room_from_earlier_epochs() {
        let p = player_with(1_500, 500);
        assert_eq!(p.locked_principal(1), 1_000);
        assert_eq!(bought_amount_after(1, 0, 1, p.locked_principal(1), 1_000).expect("at cap"), 1_000);
        assert!(bought_amount_after(1, 0, 1, p.locked_principal(1), 1_001).is_err());
    }

    // --- `bonus_after` / `pool_bonus_cap` (grant_tickets, hexo-referrals
    // ticket 04): same reset-add-check shape as `bought_amount_after`, shared
    // by the per-Player and pool-wide operator caps.

    #[test]
    fn a_grant_landing_exactly_on_the_cap_succeeds() {
        let granted = bonus_after(1, 700, 1, 1_000, 300, HexVaultError::DailyPlayerGrantCapExceeded)
            .expect("at cap");
        assert_eq!(granted, 1_000);
    }

    #[test]
    fn one_more_than_the_cap_fails_with_the_caller_supplied_error() {
        assert!(
            bonus_after(1, 700, 1, 1_000, 301, HexVaultError::DailyPlayerGrantCapExceeded)
                .unwrap_err()
                .to_string()
                .contains("exceed the player's daily cap")
        );
        assert!(
            bonus_after(1, 700, 1, 1_000, 301, HexVaultError::DailyPoolGrantCapExceeded)
                .unwrap_err()
                .to_string()
                .contains("exceed the pool's daily bonus cap")
        );
    }

    #[test]
    fn a_new_epoch_resets_the_bonus_counter_instead_of_carrying_it_over() {
        let granted = bonus_after(1, 1_000, 2, 1_000, 1_000, HexVaultError::DailyPlayerGrantCapExceeded)
            .expect("fresh epoch");
        assert_eq!(granted, 1_000);
    }

    #[test]
    fn zero_principal_refuses_an_operator_grant_like_an_exhausted_cap() {
        assert!(
            bonus_after(0, 0, 1, 0, 1, HexVaultError::DailyPlayerGrantCapExceeded)
                .unwrap_err()
                .to_string()
                .contains("exceed the player's daily cap")
        );
    }

    #[test]
    fn pool_bonus_cap_is_the_default_five_percent_of_total_principal() {
        assert_eq!(pool_bonus_cap(1_000_000, 500).expect("cap"), 50_000);
    }

    #[test]
    fn pool_bonus_cap_floors_and_never_overflows_u64() {
        // 3 / 10_000 of u64::MAX floors rather than rounding up, and the
        // u128 widening keeps `total_principal * bonus_cap_bps` from
        // overflowing u64 the way a native multiply would at this scale.
        let cap = pool_bonus_cap(u64::MAX, 3).expect("cap");
        assert_eq!(cap, (u128::from(u64::MAX) * 3 / 10_000) as u64);
    }
}
