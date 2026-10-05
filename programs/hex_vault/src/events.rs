//! Every event the indexer decodes (spec §2.6). Renaming one breaks the
//! backend's event coder and the frontend feed.

use anchor_lang::prelude::*;

use crate::custody::PauseFeature;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub pool_id: u64,
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub accepted_mint: Pubkey,
}

#[event]
pub struct OperatorChanged {
    pub pool: Pubkey,
    pub previous: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub pool: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminChanged {
    pub pool: Pubkey,
    pub previous: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct ParamsSet {
    pub pool: Pubkey,
    pub epoch_seconds: i64,
    pub epoch_anchor: i64,
    pub round_seconds: i64,
    pub close_buffer: i64,
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub house_cut_bps: u16,
    pub min_jackpot: u64,
    pub payout_timeout: i64,
    pub base_rate_bps: u16,
    pub tickets_per_usdc: u16,
    pub bonus_cap_bps: u16,
}

#[event]
pub struct Paused {
    pub pool: Pubkey,
    pub paused: bool,
}

/// `set_feature_pause` changed the game or the jackpot switch
/// (game-jackpot-pause ticket 01). `set_pause` keeps its own `Paused` event,
/// unchanged.
#[event]
pub struct FeaturePaused {
    pub pool: Pubkey,
    pub feature: PauseFeature,
    pub paused: bool,
    pub at: i64,
}

/// `set_buy_tickets_pause` flipped the Bought Tickets switch (yield-claimer
/// ticket 11).
#[event]
pub struct BuyTicketsPauseSet {
    pub pool: Pubkey,
    pub paused: bool,
    pub at: i64,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub entries: u64,
}

#[event]
pub struct WithdrawRequested {
    pub owner: Pubkey,
    /// This request alone.
    pub amount: u64,
    /// Everything the player now has waiting, this request included.
    pub pending: u64,
    pub pending_epoch: u64,
}

/// A `Withdrawn` event follows once `process_withdraw` moves the USDC.
#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub entries: u64,
}

#[event]
pub struct RoundOpened {
    pub round_id: u64,
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
}

#[event]
pub struct PositionBought {
    pub round_id: u64,
    pub owner: Pubkey,
    pub tiles: u64,
    pub stake_per_tile: u64,
    pub total: u64,
}

#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub winning_tile: u8,
    /// Gross: the House cut has not been subtracted from it.
    pub pot: u64,
    /// True when nobody covered the winning tile and the pot went to the House.
    pub forfeited: bool,
    /// Entries taken out of `pot` for the House. 0 on a forfeited round.
    pub house_cut: u64,
}

#[event]
pub struct RoundVoided {
    pub round_id: u64,
}

/// Permissionless: `close_round` reclaimed a finished Round's rent for
/// `pool.operator` once every Position on it had settled.
#[event]
pub struct RoundClosed {
    pub round: Pubkey,
    pub round_id: u64,
}

#[event]
pub struct PositionSettled {
    pub round_id: u64,
    pub owner: Pubkey,
    /// Stake back plus the share of the losers' pot, for a winner.
    pub reward: u64,
    /// The whole stake returned as Tickets on a voided round (ADR 0019).
    pub refund: u64,
}

#[event]
pub struct EpochBegan {
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
}

#[event]
pub struct JackpotFunded {
    pub source: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochDrawn {
    pub epoch_id: u64,
    pub target: u128,
    pub registered_weight: u128,
}

#[event]
pub struct JackpotPaid {
    pub epoch_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
    pub is_house: bool,
    /// True for a non-House winner: the prize was moved into the principal
    /// vault and added to the winner's Principal instead of paid to a token
    /// account. Always false for a House win, which keeps its 50/30/20 split.
    pub compounded: bool,
}

#[event]
pub struct EpochRolledOver {
    pub epoch_id: u64,
    pub jackpot_amount: u64,
}

#[event]
pub struct TicketsBought {
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub usdc: u64,
    pub tickets: u64,
}

#[event]
pub struct TicketsGranted {
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount: u64,
    /// True for the uncapped admin path; false for the capped operator path.
    pub by_admin: bool,
}

/// Admin-only and irreversible (spec "Shutdown"). Stops every inflow, the
/// game and the draw, and lets withdrawals skip the epoch lock.
#[event]
pub struct PoolShutdown {
    pub pool: Pubkey,
    pub at: i64,
}

/// Permissionless: `emergency_withdraw` paid one Player's whole balance to
/// its own USDC ATA once the pool was shut down.
#[event]
pub struct EmergencyWithdrawn {
    pub owner: Pubkey,
    pub principal: u64,
    pub pending: u64,
    pub total: u64,
}

/// A sync saw the venue's value rise and split the gain (yield-claimer
/// ticket 05). `fee + depositor_share + prize_share` is the gain. Not emitted
/// for a sync that saw no gain, or that ran in the same second as the last.
#[event]
pub struct Synced {
    pub pool: Pubkey,
    pub gain: u64,
    pub fee: u64,
    pub depositor_share: u64,
    pub prize_share: u64,
    pub yield_index: u128,
    pub venue_value: u64,
}

/// `deploy_to_venue` moved `amount` of idle USDC into the venue.
/// `venue_value` is the pool's recorded venue value afterwards.
#[event]
pub struct VenueDeployed {
    pub pool: Pubkey,
    pub amount: u64,
    pub venue_value: u64,
}

/// Admin-only: `sweep_house` moved the jackpot's unreserved balance to
/// `pool.treasury` once the pool was shut down. Principal is never swept.
#[event]
pub struct HouseSwept {
    pub jackpot: u64,
}

/// `recall` moved `amount` of USDC from the venue back into the principal
/// vault (yield-claimer ticket 07). `venue_value` is the recorded value after.
#[event]
pub struct VenueRecalled {
    pub pool: Pubkey,
    pub amount: u64,
    pub venue_value: u64,
}

/// `harvest` paid the yield fee to the Treasury and the prize share to the
/// jackpot vault (ticket 07). `gain`, `fee`, `depositor_share` and
/// `prize_share` are the totals booked since the previous harvest. `fee_paid`
/// is `fee_owed` less any rounding dust the redeem cost, so it can be a few
/// units under what the pool owed. `prize_paid` is the whole prize owed.
#[event]
pub struct Harvested {
    pub pool: Pubkey,
    pub gain: u64,
    pub fee: u64,
    pub depositor_share: u64,
    pub prize_share: u64,
    pub fee_paid: u64,
    pub prize_paid: u64,
}

/// Admin-only: `set_treasury_accounts` replaced the Treasury and the buyback
/// reserve (ticket 07).
#[event]
pub struct TreasuryAccountsSet {
    pub pool: Pubkey,
    pub treasury: Pubkey,
    pub buyback_reserve: Pubkey,
}

/// `instant_withdraw` paid `amount` to the owner in the same transaction
/// (yield-claimer ticket 09). `redeemed` is what it took from the venue to
/// cover free idle, `settled` the yield that joined Principal first.
/// `principal` and `entries` are the Player's balances afterwards.
#[event]
pub struct InstantWithdrawn {
    pub owner: Pubkey,
    pub amount: u64,
    pub redeemed: u64,
    pub settled: u64,
    pub principal: u64,
    pub entries: u64,
}
