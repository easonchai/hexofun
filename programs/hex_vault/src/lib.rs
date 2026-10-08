//! HexVault: a no-loss lottery (see `GLOSSARY.md` and ADR 0025).
//!
//! This module only declares instructions and delegates to their owning
//! module: custody in `custody.rs`, epochs in `epochs.rs`. The program is
//! custody and the epoch draw only. Tickets, the game and grants live in the
//! backend (ADR 0025).

pub mod constants;
pub mod custody;
pub mod epochs;
pub mod errors;
pub mod events;
pub mod snapshot;
pub mod state;
pub mod sync;
#[cfg(feature = "test-venue")]
pub mod test_venue;
#[cfg(feature = "test-vrf")]
pub mod test_vrf;
pub mod touch;
pub mod utils;
pub mod venue;
pub mod venue_change;
pub mod vrf;

use anchor_lang::prelude::*;

use custody::*;
use epochs::*;
use snapshot::SumNode;
use venue_change::*;
#[cfg(feature = "test-venue")]
use test_venue::*;
#[cfg(feature = "test-vrf")]
use test_vrf::*;

// One program ID per environment (ops-and-envs ticket 06): dev keeps the
// original devnet/localnet id, staging and mainnet each get their own
// keypair under `keys/`, gitignored. `scripts/check-deployable.sh` refuses
// `test-vrf` built together with either, and this refuses both at once.
#[cfg(all(feature = "staging", feature = "mainnet"))]
compile_error!("features `staging` and `mainnet` are mutually exclusive");
#[cfg(all(feature = "devnew", any(feature = "staging", feature = "mainnet")))]
compile_error!("feature `devnew` cannot combine with `staging` or `mainnet`");
// beta-launch-fixes ticket 03 / production-hardening ticket 02: a `test-vrf`
// build fabricates its own "fulfilled" randomness instead of ever calling
// ORAO, so it must never be deployable to a real cluster even if someone
// skips `scripts/deploy.sh`'s runtime check.
#[cfg(all(feature = "test-vrf", any(feature = "staging", feature = "mainnet")))]
compile_error!("feature `test-vrf` cannot combine with `staging` or `mainnet`");
// yield-claimer ticket 05: a `test-venue` build values and moves USDC against
// a stub reserve anyone can reprice, so it is as undeployable as `test-vrf`.
#[cfg(all(feature = "test-venue", any(feature = "staging", feature = "mainnet")))]
compile_error!("feature `test-venue` cannot combine with `staging` or `mainnet`");

#[cfg(feature = "mainnet")]
declare_id!("EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH");
#[cfg(feature = "staging")]
declare_id!("H2iWyng2orJpHNGGWhrR7rBQNDqixThpTpAwF4dnPXax");
#[cfg(feature = "devnew")]
declare_id!("8JVqp7anmrrE5ZvJPnz9jimbZDHotMT8aq877Xgg7Aih");
#[cfg(not(any(feature = "staging", feature = "mainnet", feature = "devnew")))]
declare_id!("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");

// ops-and-envs ticket 12: a security.txt ELF section so a researcher can go
// from the deployed program address to a contact. Gated on `no-entrypoint`
// per the crate's own rule for library authors: a consumer building this
// crate as a CPI dependency (the `cpi` feature, which implies
// `no-entrypoint`) must not get a second `security_txt` symbol linked in
// alongside its own program's.
//
// project_url and contacts are TODO: the user owns the live app URL and the
// real contact channels (see spec.md "Open items the user owns"). Fill them
// in before the mainnet deploy; a placeholder security.txt is worse than
// none, since it earns a wasted report to a dead inbox.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "HexVault",
    // TODO(user): replace with the live app URL once deployed.
    project_url: "TODO: https://hexvault.example",
    // TODO(user): replace with a real, monitored contact before mainnet.
    contacts: "email:TODO@hexvault.example",
    policy: "We do not currently pay a bug bounty. Report vulnerabilities responsibly to the contact above; do not disclose or exploit before we confirm a fix.",
    source_code: "https://github.com/easonchai/HexVault"
}

#[program]
pub mod hex_vault {
    use super::*;

    // Custody (spec §2.3 "Custody")

    pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
        custody::create_pool(ctx, params)
    }

    pub fn set_params(ctx: Context<SetParams>, params: SetParamsArgs) -> Result<()> {
        custody::set_params(ctx, params)
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        custody::set_pause(ctx, paused)
    }

    /// Sets the game or the jackpot switch on its own (game-jackpot-pause
    /// ticket 01), same role rule as `set_pause`.
    pub fn set_feature_pause(
        ctx: Context<SetFeaturePause>,
        feature: PauseFeature,
        paused: bool,
    ) -> Result<()> {
        custody::set_feature_pause(ctx, feature, paused)
    }

    /// Admin-only. Stops `buy_tickets` while set (yield-claimer ticket 11).
    pub fn set_buy_tickets_pause(ctx: Context<SetBuyTicketsPause>, paused: bool) -> Result<()> {
        custody::set_buy_tickets_pause(ctx, paused)
    }

    /// Admin-only and irreversible (ops-and-envs ticket 02, spec
    /// "Shutdown"). Stops every inflow, the game and the draw, and lets
    /// withdrawals skip the epoch lock.
    pub fn shutdown(ctx: Context<Shutdown>) -> Result<()> {
        custody::shutdown(ctx)
    }

    /// Permissionless, only valid once shut down (ops-and-envs ticket 03):
    /// pays one Player's whole balance to their own USDC ATA.
    pub fn emergency_withdraw<'info>(ctx: Context<'info, EmergencyWithdraw<'info>>) -> Result<()> {
        custody::emergency_withdraw(ctx)
    }

    /// Admin-only, only valid once shut down (ops-and-envs ticket 04): moves
    /// the jackpot's unreserved balance to `pool.treasury`.
    pub fn sweep_house(ctx: Context<SweepHouse>) -> Result<()> {
        custody::sweep_house(ctx)
    }

    pub fn set_operator(ctx: Context<SetOperator>, new_operator: Pubkey) -> Result<()> {
        custody::set_operator(ctx, new_operator)
    }

    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        custody::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        custody::accept_admin(ctx)
    }

    pub fn deposit<'info>(ctx: Context<'info, Deposit<'info>>, amount: u64) -> Result<()> {
        custody::deposit(ctx, amount)
    }

    /// Owner-signed (ADR 0020): the pending deposit part refunds in this
    /// transaction, redeeming the gap from the venue when free idle is short.
    /// The rest queues for `process_withdraw`.
    pub fn request_withdraw<'info>(
        ctx: Context<'info, RequestWithdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        custody::request_withdraw(ctx, amount)
    }

    pub fn process_withdraw<'info>(ctx: Context<'info, ProcessWithdraw<'info>>) -> Result<()> {
        custody::process_withdraw(ctx)
    }

    /// Owner-signed: clears a queued request and moves nothing.
    pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
        custody::cancel_withdraw(ctx)
    }

    pub fn buy_tickets(ctx: Context<BuyTickets>, amount: u64) -> Result<()> {
        custody::buy_tickets(ctx, amount)
    }

    // Epochs (spec §2.3 "Epochs"). The flow is `begin_epoch`, play,
    // `request_draw`, `draw`, `payout` (yield-claimer ticket 08, ADR 0018).

    pub fn begin_epoch<'info>(ctx: Context<'info, BeginEpoch<'info>>) -> Result<()> {
        epochs::begin_epoch(ctx)
    }

    pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
        epochs::fund_jackpot(ctx, amount)
    }

    /// Operator-only: snapshots the ended epoch's prize, commits the Ticket
    /// snapshot's Merkle sum root, total and shape, then asks the VRF for the
    /// draw with the root in the seed, or rolls the epoch over.
    pub fn request_draw(
        ctx: Context<RequestDraw>,
        nonce: [u8; 32],
        root: [u8; 32],
        total_tickets: u64,
        depth: u8,
        leaf_count: u32,
    ) -> Result<()> {
        epochs::request_draw(ctx, nonce, root, total_tickets, depth, leaf_count)
    }

    pub fn draw(ctx: Context<Draw>) -> Result<()> {
        epochs::draw(ctx)
    }

    /// Permissionless: pays only when `siblings` carry the winner's leaf to
    /// the committed root and the drawn target falls in the leaf's range.
    pub fn payout<'info>(
        ctx: Context<'info, Payout<'info>>,
        index: u32,
        tickets: u64,
        siblings: Vec<SumNode>,
    ) -> Result<()> {
        epochs::payout(ctx, index, tickets, siblings)
    }

    pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
        epochs::rollover_epoch(ctx)
    }

    /// Permissionless (yield-claimer ticket 05): syncs, then moves idle USDC
    /// above the idle target into the venue. Venue-specific extra accounts go
    /// in `remaining_accounts`.
    pub fn deploy_to_venue<'info>(
        ctx: Context<'info, DeployToVenue<'info>>,
        amount: u64,
    ) -> Result<()> {
        custody::deploy_to_venue(ctx, amount)
    }

    /// Permissionless (yield-claimer ticket 07): syncs, then redeems `amount`
    /// from the venue while free idle is under the idle target.
    pub fn recall<'info>(ctx: Context<'info, Recall<'info>>, amount: u64) -> Result<()> {
        custody::recall(ctx, amount)
    }

    /// Permissionless (ticket 07): pays the yield fee owed to the Treasury and
    /// the prize share owed to the jackpot vault.
    pub fn harvest<'info>(ctx: Context<'info, Harvest<'info>>) -> Result<()> {
        custody::harvest(ctx)
    }

    /// Admin-only (ticket 07): sets `treasury` and `buyback_reserve`.
    pub fn set_treasury_accounts(ctx: Context<SetTreasuryAccounts>) -> Result<()> {
        custody::set_treasury_accounts(ctx)
    }

    /// Admin or Operator turns deploy off, only the Admin turns it back on
    /// (yield-claimer ticket 10).
    pub fn set_deploy_pause(ctx: Context<SetDeployPause>, paused: bool) -> Result<()> {
        custody::set_deploy_pause(ctx, paused)
    }

    /// Permissionless (ticket 10): pays USDC into the principal vault against
    /// the recorded venue deficit, capped at it.
    pub fn cover_deficit<'info>(
        ctx: Context<'info, CoverDeficit<'info>>,
        amount: u64,
    ) -> Result<()> {
        custody::cover_deficit(ctx, amount)
    }

    /// Admin-only (ticket 10): fee, idle band, caps, minimum size and loss
    /// tolerance, each inside its program constant.
    pub fn set_venue_params(ctx: Context<SetVenueParams>, params: SetVenueParamsArgs) -> Result<()> {
        custody::set_venue_params(ctx, params)
    }

    /// Admin-only (venue-switch ticket 03): announces a venue change, or
    /// replaces the open announcement and restarts its 48 hour lock. Deploys
    /// are refused while it stands.
    pub fn propose_venue<'info>(
        ctx: Context<'info, ProposeVenue<'info>>,
        args: ProposeVenueArgs,
    ) -> Result<()> {
        venue_change::propose_venue(ctx, args)
    }

    /// Admin-only: withdraws the open proposal and returns its rent.
    pub fn cancel_venue(ctx: Context<CancelVenue>) -> Result<()> {
        venue_change::cancel_venue(ctx)
    }

    /// Venue-switch ticket 04: redeems `amount` from the venue into the
    /// principal vault. Admin or Operator any time, anyone while a proposal
    /// is open.
    pub fn drain_venue<'info>(ctx: Context<'info, DrainVenue<'info>>, amount: u64) -> Result<()> {
        venue_change::drain_venue(ctx, amount)
    }

    /// Venue-switch ticket 05: repins the pool to the proposed venue once the
    /// lock has elapsed and the old position is down to dust. Permissionless;
    /// no USDC moves. Closes the proposal into the Admin.
    pub fn migrate_venue<'info>(ctx: Context<'info, MigrateVenue<'info>>) -> Result<()> {
        venue_change::migrate_venue(ctx)
    }

    // Localnet only: the stub venue behind `venue.rs` (yield-claimer ticket
    // 05). Created once after `create_pool`, repriced by the tests.
    #[cfg(feature = "test-venue")]
    pub fn test_venue_init(ctx: Context<TestVenueInit>) -> Result<()> {
        test_venue::test_venue_init(ctx)
    }

    /// A second stub venue with its own reserve and vault PDAs, for the
    /// stub-to-stub migration (venue-switch ticket 05).
    #[cfg(feature = "test-venue")]
    pub fn test_venue_init_alt(ctx: Context<TestVenueInitAlt>) -> Result<()> {
        test_venue::test_venue_init_alt(ctx)
    }

    /// Moves the open proposal's start back by `seconds`, standing in for the
    /// 48 hours a localnet clock cannot wait out.
    #[cfg(feature = "test-venue")]
    pub fn test_backdate_proposal(ctx: Context<TestBackdateProposal>, seconds: i64) -> Result<()> {
        test_venue::test_backdate_proposal(ctx, seconds)
    }

    #[cfg(feature = "test-venue")]
    pub fn test_set_venue_rate(ctx: Context<TestSetVenueRate>, rate: u128) -> Result<()> {
        test_venue::test_set_venue_rate(ctx, rate)
    }

    /// Sets what the stub reserve reports as its supply and free liquidity, for
    /// the deploy caps (ticket 10).
    #[cfg(feature = "test-venue")]
    pub fn test_set_reserve_stats(
        ctx: Context<TestSetVenueRate>,
        supply: u64,
        available: u64,
    ) -> Result<()> {
        test_venue::test_set_reserve_stats(ctx, supply, available)
    }

    /// Runs sync and nothing else, because only deploy runs it in ticket 05.
    #[cfg(feature = "test-venue")]
    pub fn test_sync<'info>(ctx: Context<'info, TestSync<'info>>) -> Result<()> {
        test_venue::test_sync(ctx)
    }

    // Localnet only (spec §2.5): fabricates a fulfilled ORAO randomness
    // account so tests never need a deployed VRF program.
    #[cfg(feature = "test-vrf")]
    pub fn test_fulfill(
        ctx: Context<TestFulfill>,
        seed: [u8; 32],
        randomness: [u8; 64],
    ) -> Result<()> {
        test_vrf::test_fulfill(ctx, seed, randomness)
    }
}
