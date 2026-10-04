//! HexVault: a no-loss lottery with zero-sum hex rounds (see `CONTEXT.md`
//! and `docs/plan/rebuild/spec.md`).
//!
//! This module only declares instructions and delegates to their owning
//! module: custody in `custody.rs`, rounds in `rounds.rs`, epochs in
//! `epochs.rs`. `register`, `close_registration`, `admin_withdraw` and
//! `fund_yield` were removed by the live-yield layout rewrite (yield-claimer
//! ticket 04; ADRs 0017, 0018).

pub mod constants;
pub mod custody;
pub mod epochs;
pub mod errors;
pub mod events;
pub mod rounds;
pub mod state;
pub mod sync;
#[cfg(feature = "test-venue")]
pub mod test_venue;
#[cfg(feature = "test-vrf")]
pub mod test_vrf;
pub mod touch;
pub mod utils;
pub mod venue;
pub mod vrf;
// Yield-claimer ticket 02 prototype; test-only, never in the binary.
#[cfg(test)]
mod weight_tree_proto;

use anchor_lang::prelude::*;

use custody::*;
use epochs::*;
use rounds::*;
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

    /// Admin-only and irreversible (ops-and-envs ticket 02, spec
    /// "Shutdown"). Stops every inflow, the game and the draw, and lets
    /// withdrawals skip the epoch lock.
    pub fn shutdown(ctx: Context<Shutdown>) -> Result<()> {
        custody::shutdown(ctx)
    }

    /// Permissionless, only valid once shut down (ops-and-envs ticket 03):
    /// pays one Player's whole balance to their own USDC ATA.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
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

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        custody::deposit(ctx, amount)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, amount: u64) -> Result<()> {
        custody::request_withdraw(ctx, amount)
    }

    pub fn process_withdraw(ctx: Context<ProcessWithdraw>) -> Result<()> {
        custody::process_withdraw(ctx)
    }

    pub fn buy_tickets(ctx: Context<BuyTickets>, amount: u64) -> Result<()> {
        custody::buy_tickets(ctx, amount)
    }

    pub fn grant_tickets(ctx: Context<GrantTickets>, amount: u64) -> Result<()> {
        custody::grant_tickets(ctx, amount)
    }

    // Rounds (spec §2.3 "Rounds").

    pub fn create_round(ctx: Context<CreateRound>, starts_at: i64, ends_at: i64) -> Result<()> {
        rounds::create_round(ctx, starts_at, ends_at)
    }

    pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
        rounds::buy_position(ctx, tiles, stake_per_tile)
    }

    pub fn request_round_randomness(
        ctx: Context<RequestRoundRandomness>,
        nonce: [u8; 32],
    ) -> Result<()> {
        rounds::request_round_randomness(ctx, nonce)
    }

    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        rounds::settle_round(ctx)
    }

    pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
        rounds::settle_position(ctx)
    }

    pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
        rounds::void_round(ctx)
    }

    /// Permissionless (ops-and-envs ticket 05): reclaims a finished Round's
    /// rent for the operator once every Position on it has settled.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        rounds::close_round(ctx)
    }

    // Epochs (spec §2.3 "Epochs"). Ticket 08 replaces the draw with the
    // Weight tree's `request_draw`; until then nothing moves an epoch to
    // Drawing, and `payout` refuses with `DrawPendingWeightTree`.

    pub fn begin_epoch(ctx: Context<BeginEpoch>) -> Result<()> {
        epochs::begin_epoch(ctx)
    }

    pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
        epochs::fund_jackpot(ctx, amount)
    }

    pub fn draw(ctx: Context<Draw>) -> Result<()> {
        epochs::draw(ctx)
    }

    pub fn payout(ctx: Context<Payout>) -> Result<()> {
        epochs::payout(ctx)
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

    // Localnet only: the stub venue behind `venue.rs` (yield-claimer ticket
    // 05). Created once after `create_pool`, repriced by the tests.
    #[cfg(feature = "test-venue")]
    pub fn test_venue_init(ctx: Context<TestVenueInit>) -> Result<()> {
        test_venue::test_venue_init(ctx)
    }

    #[cfg(feature = "test-venue")]
    pub fn test_set_venue_rate(ctx: Context<TestSetVenueRate>, rate: u128) -> Result<()> {
        test_venue::test_set_venue_rate(ctx, rate)
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
