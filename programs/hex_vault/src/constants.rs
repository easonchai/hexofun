/// Hex tiles on a round's board, indexed 0..35.
pub const TILE_COUNT: u8 = 36;
pub const TILE_MASK: u64 = (1u64 << TILE_COUNT) - 1;

/// 100% in basis points. `Pool::house_cut_bps` and `Pool::base_rate_bps` are
/// capped at this.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Written to `version` on a freshly created `Epoch`. Epoch kept its layout
/// through the live-yield rewrite. See ADR 0013.
pub const EPOCH_VERSION: u8 = 1;

/// Written to `version` on `Pool`, `Player`, `Round` and `Position` since the
/// live-yield layout rewrite (yield-claimer ticket 04, ADR 0013 amendment).
/// Version 1 of each had a different layout and a different discriminator
/// (see `state.rs`), so Anchor refuses a version-1 account with
/// `AccountDiscriminatorMismatch` before reading a byte of it.
pub const LAYOUT_VERSION: u8 = 2;

/// Written to the Weight tree header by `create_pool`.
pub const WEIGHT_TREE_VERSION: u8 = 1;

/// Denominator for `base_rate_bps`, an APR: seconds in a 365-day year.
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

// Venue parameter defaults, written by `create_pool` (spec "Layout
// rewrite"). Ticket 10's `set_venue_params` changes them within the caps.

/// Yield fee: the team's share of every venue gain.
pub const DEFAULT_YIELD_FEE_BPS: u16 = 1_000;
/// No key can raise the Yield fee past this.
pub const MAX_YIELD_FEE_BPS: u16 = 2_000;
/// Idle band: free idle USDC as a share of the pool.
pub const DEFAULT_IDLE_FLOOR_BPS: u16 = 500;
pub const DEFAULT_IDLE_TARGET_BPS: u16 = 1_000;
/// Deploy cap: the pool's largest share of the reserve's supply.
pub const DEFAULT_RESERVE_SHARE_CAP_BPS: u16 = 500;
/// Deploy cap: free liquidity the reserve must keep after a deploy, as a
/// multiple of the pool's position in basis points. 20_000 is twice it.
pub const DEFAULT_RESERVE_LIQUIDITY_FLOOR_BPS: u16 = 20_000;
/// Smallest deploy or recall: 100 USDC at 6 decimals.
pub const DEFAULT_MIN_VENUE_MOVE: u64 = 100_000_000;
/// A fall in venue value past this share of it is a venue loss.
pub const DEFAULT_LOSS_TOLERANCE_BPS: u16 = 1;

// Bounds `set_venue_params` enforces (yield-claimer ticket 10). The fee cap is
// `MAX_YIELD_FEE_BPS` above. A stolen Admin key can move each setting only
// inside these.

/// The idle target cannot pass this share of the pool. The idle floor cannot
/// pass the target.
pub const MAX_IDLE_TARGET_BPS: u16 = 5_000;
/// The pool's largest share of the reserve's supply, never above 20%.
pub const MAX_RESERVE_SHARE_CAP_BPS: u16 = 2_000;
/// Free liquidity the reserve must keep after a deploy, as a multiple of the
/// pool's position, between 1x and 6x (the field is a `u16`).
pub const MIN_RESERVE_LIQUIDITY_FLOOR_BPS: u16 = 10_000;
pub const MAX_RESERVE_LIQUIDITY_FLOOR_BPS: u16 = 60_000;
/// Smallest deploy or recall, at most 10,000 USDC at 6 decimals.
pub const MAX_MIN_VENUE_MOVE: u64 = 10_000_000_000;
/// A fall under this share of venue value is dust, never a loss. 1%.
pub const MAX_LOSS_TOLERANCE_BPS: u16 = 100;

/// Floors for the two timeouts that gate the permissionless `void_round` and
/// `rollover_epoch` (production-hardening 14, Finding 5). Below these, a
/// merely slow ORAO fulfilment or an honest late Payout could be voided or
/// rolled over by any stranger the second the timeout passes. Localnet tests
/// run epochs of a few seconds, so `test-vrf` builds keep the floor at 1;
/// `lib.rs` refuses that feature together with `staging` or `mainnet`.
///
/// 180 s since ADR 0019: ORAO's measured tail reached 62 to 77 s, and a 60 s
/// floor would void about one round in six.
#[cfg(not(feature = "test-vrf"))]
pub const MIN_VRF_TIMEOUT: i64 = 180;
#[cfg(feature = "test-vrf")]
pub const MIN_VRF_TIMEOUT: i64 = 1;
#[cfg(not(feature = "test-vrf"))]
pub const MIN_PAYOUT_TIMEOUT: i64 = 600;
#[cfg(feature = "test-vrf")]
pub const MIN_PAYOUT_TIMEOUT: i64 = 1;

pub const SEED_POOL: &[u8] = b"pool";
pub const SEED_PRINCIPAL: &[u8] = b"principal";
pub const SEED_JACKPOT: &[u8] = b"jackpot";
pub const SEED_EPOCH: &[u8] = b"epoch";
pub const SEED_ROUND: &[u8] = b"round";
pub const SEED_PLAYER: &[u8] = b"player";
pub const SEED_POSITION: &[u8] = b"position";

/// `ImpairedCleared::cause`: what took the deficit to zero.
pub mod impaired_cause {
    /// A venue gain repaid it in a sync.
    pub const GAIN: u8 = 0;
    /// `cover_deficit`.
    pub const COVER: u8 = 1;
    /// Haircut withdrawals realised the last of it.
    pub const WITHDRAWAL: u8 = 2;
}

/// `Epoch::status`. An epoch is Open while it is the current one. `begin_epoch`
/// moves it to Ended, then `request_draw` walks it Drawing → Drawn → Paid, or
/// short-circuits to RolledOver. An Ended epoch nobody draws for leaves
/// through `rollover_epoch`.
pub mod epoch_status {
    pub const OPEN: u8 = 0;
    pub const ENDED: u8 = 1;
    pub const DRAWING: u8 = 2;
    pub const DRAWN: u8 = 3;
    pub const PAID: u8 = 4;
    pub const ROLLED_OVER: u8 = 5;
}

/// `Round::status`. Open → Requested → Settled or Forfeited, or Voided when
/// the randomness never arrives.
pub mod round_status {
    pub const OPEN: u8 = 0;
    pub const REQUESTED: u8 = 1;
    pub const SETTLED: u8 = 2;
    pub const FORFEITED: u8 = 3;
    pub const VOIDED: u8 = 4;
}

#[cfg(test)]
mod tests {
    use super::*;

    // `cargo test` builds without `test-vrf`, so this is the deployable floor
    // `create_pool` and `set_params` enforce (ADR 0019).
    #[test]
    fn the_deployable_vrf_timeout_floor_is_180_seconds() {
        assert_eq!(MIN_VRF_TIMEOUT, 180);
    }
}
