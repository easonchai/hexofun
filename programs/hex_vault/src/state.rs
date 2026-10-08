//! Account layouts. Changing a field here churns the IDL, the indexer's
//! Prisma schema, and the frontend.
//!
//! `Pool` and `Player` were rewritten for live yield (yield-claimer ticket 04,
//! ADR 0013 amendment) and again for custody only (off-chain-tickets ticket 08,
//! ADR 0025). Each carries `version = LAYOUT_VERSION` and a discriminator of
//! its own instead of Anchor's default, so an account of an earlier layout
//! fails to load with `AccountDiscriminatorMismatch` instead of being
//! misread. The rewrites ship on a fresh pool (ADR 0016), so none should ever
//! be met. From the first mainnet deposit the append-only rule of ADR 0013
//! holds again.

use anchor_lang::prelude::*;

use crate::constants::LAYOUT_VERSION;

/// One deployed instance of the product: one accepted mint, one principal
/// vault, one jackpot vault, one epoch schedule.
#[account(discriminator = b"HVPool03")]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u64,
    /// Changes parameters, unpauses, rotates the operator, and hands its own
    /// role on. A multisig on mainnet.
    pub admin: Pubkey,
    /// The hot key the operator service cranks with. Also the House Player's
    /// owner and, on devnet, the mint authority.
    pub operator: Pubkey,
    /// Proposed next admin. `Pubkey::default()` means no handover is open.
    pub pending_admin: Pubkey,
    pub accepted_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub jackpot_vault: Pubkey,
    /// Token account that takes 20% of a jackpot the House wins.
    pub treasury: Pubkey,
    /// Token account that takes 50% of a jackpot the House wins.
    pub buyback_reserve: Pubkey,
    /// The House `Player` PDA, created in `create_pool`.
    pub house: Pubkey,
    /// ORAO VRF network state, pinned at pool creation.
    pub vrf_network_state: Pubkey,
    /// Applies to the next epoch created, not the open one.
    pub epoch_seconds: i64,
    /// Fixes the phase of the epoch grid `epoch_anchor + k * epoch_seconds`.
    /// Every epoch boundary is a point on it, so the draw lands at the same
    /// clock time whatever second the pool was bootstrapped on.
    pub epoch_anchor: i64,
    /// Seconds after a randomness request before void / rollover is allowed.
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub paused: bool,
    /// 0 before the first epoch.
    pub current_epoch_id: u64,
    pub current_epoch_start: i64,
    /// End of the current epoch, copied from its `Epoch.ends_at`, so changing
    /// `epoch_seconds` never moves an epoch that has already begun.
    pub current_epoch_ends_at: i64,
    /// Start of the epoch before the current one. Usually that is
    /// `current_epoch_start` too, except when `begin_epoch` skipped a gap.
    pub previous_epoch_start: i64,
    /// End of the epoch before the current one.
    pub previous_epoch_ends_at: i64,
    pub total_principal: u64,
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub jackpot_vault_bump: u8,
    /// Σ `Player.pending_withdraw` across the pool. USDC the principal vault
    /// holds for queued withdrawals, which no other payout may spend. Part of
    /// `total_principal`, not a second claim beside it.
    pub pending_withdrawals: u64,
    /// An epoch whose jackpot vault holds less than this at the draw request
    /// rolls over instead of paying out dust.
    pub min_jackpot: u64,
    /// Seconds after `Epoch.drawn_at` before a Drawn epoch may be rolled
    /// over unpaid. The escape hatch for a winner nobody can pay.
    pub payout_timeout: i64,
    /// Jackpot already promised to an epoch that is Drawing or Drawn and has
    /// not paid yet. The draw request snapshots the vault minus this, so the
    /// next epoch cannot take a prize the previous one still owes. Released
    /// on `payout` and on either branch of `rollover_epoch`.
    pub jackpot_reserved: u64,
    /// The ceiling on the depositor share of a venue gain, as an annual rate on
    /// `total_principal` in basis points, capped at `BPS_DENOMINATOR`. Gain
    /// above it goes to the prize share (ADR 0017). It has no floor: at zero
    /// every gain above the Yield fee goes to the prize share.
    pub base_rate_bps: u16,
    /// Set to [`LAYOUT_VERSION`] by `create_pool`. Lets a future upgrade
    /// tell an old account apart from a freshly created one and migrate it
    /// lazily on first touch.
    pub version: u8,
    /// Admin-only and irreversible (spec "Shutdown"). Stops every inflow,
    /// the game and the draw, and lets withdrawals skip the epoch lock.
    pub shutdown: bool,
    /// The backend's game engine refuses new Rounds and bets while this is set
    /// (game-jackpot-pause ticket 01). Nothing in the program reads it.
    /// `create_pool` sets this `true`.
    pub game_paused: bool,
    /// Stops the epoch cycle's next step: `begin_epoch` and `buy_tickets`
    /// (game-jackpot-pause ticket 01). An epoch already
    /// Drawing or Drawn still finishes. `create_pool` sets this `true`.
    pub jackpot_paused: bool,

    // Live yield (ADR 0017), added by the ticket 04 rewrite. Everything below
    // starts at the value `create_pool` writes; ticket 05's sync is the first
    // thing to move them.
    /// The four pinned venue accounts. The names are klend's and stay, because
    /// renaming a field breaks every client's IDL; what each one is depends on
    /// `venue_kind`. `create_pool` takes them (never the default key) and every
    /// venue instruction checks its accounts against them.
    ///
    /// Venue program. klend: the klend program. kVault: the kVault program.
    /// Stub: this program.
    pub klend_program: Pubkey,
    /// Venue market. klend: the lending market. kVault: the vault state
    /// account (a deposit and a redeem write it, so the client passes it
    /// writable). Stub: the pool PDA.
    pub klend_market: Pubkey,
    /// Venue reserve. klend: the reserve. kVault: the vault's shares mint.
    /// Stub: the stub reserve PDA.
    pub klend_reserve: Pubkey,
    /// The pool's position token account. klend: the pool's cToken account.
    /// kVault: the pool's token account of the shares mint. Stub: the stub
    /// vault PDA.
    pub klend_ctoken: Pubkey,
    /// Depositor share per unit of Principal, scaled by 1e18. Only rises.
    pub yield_index: u128,
    /// The venue position's value at the last sync, and when that was.
    pub venue_value: u64,
    pub last_sync_at: i64,
    /// Depositor yield the index has credited and no Player has settled.
    pub yield_owed: u64,
    /// Yield fee owed to the Treasury, paid out by harvest.
    pub fee_owed: u64,
    /// Prize share owed to the jackpot vault, paid out by harvest.
    pub prize_owed: u64,
    /// Venue loss not yet repaid. Nonzero only while `impaired`.
    pub deficit: u64,
    /// The team's share of every gain, at most `MAX_YIELD_FEE_BPS`.
    pub yield_fee_bps: u16,
    /// Idle band: free idle USDC as a share of the pool. The program never
    /// reads the floor. The Operator recalls when free idle is under it. Deploy
    /// moves idle above the target.
    pub idle_floor_bps: u16,
    pub idle_target_bps: u16,
    /// Deploy cap: the pool's largest share of the reserve's supply.
    pub reserve_share_cap_bps: u16,
    /// Deploy cap: free liquidity the reserve must keep after a deploy, as a
    /// multiple of the pool's position in basis points (20_000 is twice it).
    pub reserve_liquidity_floor_bps: u16,
    /// Smallest deploy or recall, in USDC atomic units.
    pub min_venue_move: u64,
    /// A fall in venue value past this share of it is a venue loss.
    pub loss_tolerance_bps: u16,
    /// Stops deploy. Either key sets it, only the Admin clears it.
    pub deploy_paused: bool,
    /// Set by a venue loss, cleared when `deficit` reaches zero.
    pub impaired: bool,
    /// Stops `buy_tickets` (ADR 0019). Admin-only setter in ticket 11.
    pub buy_tickets_paused: bool,
    /// Running totals of every gain booked since the last harvest, for the
    /// harvest event (yield-claimer ticket 07). `apply_sync` adds to them,
    /// `harvest` reads and zeroes them. They are not claims: only the owed
    /// amounts above are.
    pub harvest_gain: u64,
    pub harvest_fee: u64,
    pub harvest_depositor: u64,
    pub harvest_prize: u64,
    /// `total_principal` as it stood when `begin_epoch` opened the current
    /// epoch. The backend's referral bonus cap reads it, so a deposit made
    /// mid-epoch cannot widen the cap. Zero before epoch 1.
    pub epoch_start_principal: u64,
    /// Which backing the four pinned venue keys point at, a
    /// `constants::venue_kind` value: 0 klend, 1 stub (localnet only), 2 kVault.
    /// Zero is klend, so a pool made before the byte existed reads as klend.
    /// `create_pool` sets it.
    pub venue_kind: u8,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013.
    pub _reserved: [u8; 87],
}

/// The Admin's announced venue change (venue-switch ticket 03): a PDA from the
/// pool, `[SEED_VENUE_PROPOSAL, pool]`, created by `propose_venue` and closed
/// by `cancel_venue` (or the migration, ticket 05). While it exists the pool
/// refuses to deploy. The four pins mean what they mean on the Pool for
/// `venue_kind`.
#[account]
#[derive(InitSpace)]
pub struct VenueProposal {
    pub pool: Pubkey,
    pub venue_kind: u8,
    pub klend_program: Pubkey,
    pub klend_market: Pubkey,
    pub klend_reserve: Pubkey,
    pub klend_ctoken: Pubkey,
    /// Unix seconds of the latest `propose_venue`; the lock counts from it.
    pub proposed_at: i64,
    pub bump: u8,
}

/// One lottery cycle. Contiguous: the next opens the moment this one ends.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    /// [`EpochStatus`]
    pub status: u8,
    /// The Ticket total of this epoch's snapshot, committed by the Operator in
    /// `request_draw` with the three fields below. Frozen once the status is
    /// Drawing.
    pub total_tickets: u64,
    /// Leaves in the snapshot, padding excluded.
    pub leaf_count: u32,
    /// Jackpot vault balance snapshotted at the draw request.
    pub jackpot_amount: u64,
    pub vrf_seed: [u8; 32],
    pub requested_at: i64,
    /// Point in `total_tickets` selected by the draw.
    pub target: u64,
    pub winner: Pubkey,
    pub bump: u8,
    /// When `draw` landed. 0 until then. `rollover_epoch` measures
    /// `Pool.payout_timeout` from here.
    pub drawn_at: i64,
    /// When `begin_epoch` ended this epoch and started the next. 0 until then.
    /// `rollover_epoch` measures `Pool.vrf_timeout` from the later of this
    /// and `ends_at` for an epoch that was never sent to the draw.
    pub registration_opened_at: i64,
    /// Set to [`crate::constants::EPOCH_VERSION`] by `begin_epoch`. See
    /// `Pool::version`.
    pub version: u8,
    /// Root of the snapshot's Merkle sum tree, committed by `request_draw`.
    /// All zeros until then.
    pub snapshot_root: [u8; 32],
    /// Levels above the leaves, so the tree holds `2^snapshot_depth` leaves.
    pub snapshot_depth: u8,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013.
    pub _reserved: [u8; 31],
}

/// One wallet's account in one pool.
#[account(discriminator = b"HVPlyr03")]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// 1:1 claim on deposited USDC. Never at risk.
    pub principal: u64,
    /// The epoch this Player was last touched in. [`crate::touch::touch`] folds
    /// the pending deposit into locked Principal the first time the Player is
    /// touched in a later epoch.
    pub epoch_id: u64,
    pub is_house: bool,
    pub bump: u8,
    /// Queued by `request_withdraw` and waiting for `process_withdraw` to move
    /// the USDC. A sub-balance of `principal`, which it leaves only when it
    /// pays. 0 when nothing is queued.
    pub pending_withdraw: u64,
    /// The epoch the pending amount was requested in. It pays out once
    /// `pool.current_epoch_id` is past it.
    pub pending_epoch: u64,
    /// When `request_withdraw` booked the pending amount. The second way a
    /// request matures, so a stalled operator who never calls `begin_epoch`
    /// cannot freeze a depositor's money.
    pub requested_at: i64,
    /// The epoch `bought_amount` is counted against. `buy_tickets` resets
    /// `bought_amount` to 0 when this no longer matches the pool's current
    /// epoch.
    pub bought_epoch: u64,
    /// USDC spent in `buy_tickets` so far in `bought_epoch`, capped at
    /// `principal`.
    pub bought_amount: u64,
    /// `Pool.yield_index` at this Player's last settle (ADR 0017).
    pub yield_index: u128,
    /// Set to [`LAYOUT_VERSION`] by `Player::init_if_fresh` and
    /// `create_pool`. See `Pool::version`.
    pub version: u8,
    /// Principal deposited in `pending_deposit_epoch` that has earned no Ticket
    /// yet. A sub-balance of `principal`, not an addition to it. [`crate::touch::touch`]
    /// zeroes it on the first touch in a later epoch (ADR 0020).
    pub pending_deposit: u64,
    /// The epoch of the latest deposit. Its Tickets count from the next one.
    pub pending_deposit_epoch: u64,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013. Smaller
    /// than `Pool`'s: Player rent is paid by the depositor.
    pub _reserved: [u8; 44],
}

impl Player {
    /// Principal less the Pending deposit: what has been in the pool since
    /// before this epoch. The Bought ticket cap counts this, since
    /// a Pending deposit refunds on request and so cannot back a cap. One from
    /// an earlier epoch is already locked, whether or not `touch` has folded it.
    pub fn locked_principal(&self, current_epoch_id: u64) -> u64 {
        if self.pending_deposit_epoch >= current_epoch_id {
            self.principal.saturating_sub(self.pending_deposit)
        } else {
            self.principal
        }
    }

    /// Fills a freshly `init_if_needed`ed account. A no-op on an existing
    /// one, so callers can run it unconditionally before `touch`.
    ///
    /// A new Player starts at the pool's current Yield index, so it earns
    /// nothing that accrued before it arrived (ADR 0017).
    pub fn init_if_fresh(&mut self, owner: Pubkey, pool: &Pool, bump: u8) {
        if self.owner != Pubkey::default() {
            return;
        }
        self.owner = owner;
        self.epoch_id = pool.current_epoch_id;
        self.yield_index = pool.yield_index;
        self.bump = bump;
        self.version = LAYOUT_VERSION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use anchor_lang::error::ErrorCode;

    // Pins every account's on-chain size to a literal so a field added,
    // removed, reordered or resized has to update this test on purpose
    // (ticket ops-and-envs/01) instead of silently churning the layout.
    #[test]
    fn account_sizes_are_pinned_to_their_literal_byte_counts() {
        assert_eq!(Pool::INIT_SPACE, 793);
        assert_eq!(Epoch::INIT_SPACE, 207);
        assert_eq!(Player::INIT_SPACE, 167);
        assert_eq!(VenueProposal::INIT_SPACE, 170);
    }

    /// On-chain offset (discriminator included) of whichever field `set`
    /// makes nonzero, found by serialising an otherwise all-zero account.
    fn offset<T: AnchorSerialize + AnchorDeserialize>(space: usize, set: impl FnOnce(&mut T)) -> usize {
        let mut account = T::deserialize(&mut &vec![0u8; space][..]).expect("zeroed account");
        set(&mut account);
        let mut bytes = Vec::new();
        account.serialize(&mut bytes).expect("serialise");
        8 + bytes.iter().position(|b| *b != 0).expect("field set")
    }

    #[test]
    fn rewritten_fields_sit_at_pinned_offsets() {
        let pool =|set: fn(&mut Pool)| offset(Pool::INIT_SPACE, set);
        assert_eq!(pool(|p| p.total_principal = 1), 409);
        assert_eq!(pool(|p| p.version = 1), 454);
        assert_eq!(pool(|p| p.jackpot_paused = true), 457);
        assert_eq!(pool(|p| p.klend_program = Pubkey::new_from_array([1; 32])), 458);
        assert_eq!(pool(|p| p.klend_market = Pubkey::new_from_array([1; 32])), 490);
        assert_eq!(pool(|p| p.klend_reserve = Pubkey::new_from_array([1; 32])), 522);
        assert_eq!(pool(|p| p.klend_ctoken = Pubkey::new_from_array([1; 32])), 554);
        assert_eq!(pool(|p| p.yield_index = 1), 586);
        assert_eq!(pool(|p| p.venue_value = 1), 602);
        assert_eq!(pool(|p| p.last_sync_at = 1), 610);
        assert_eq!(pool(|p| p.yield_owed = 1), 618);
        assert_eq!(pool(|p| p.fee_owed = 1), 626);
        assert_eq!(pool(|p| p.prize_owed = 1), 634);
        assert_eq!(pool(|p| p.deficit = 1), 642);
        assert_eq!(pool(|p| p.yield_fee_bps = 1), 650);
        assert_eq!(pool(|p| p.idle_floor_bps = 1), 652);
        assert_eq!(pool(|p| p.idle_target_bps = 1), 654);
        assert_eq!(pool(|p| p.reserve_share_cap_bps = 1), 656);
        assert_eq!(pool(|p| p.reserve_liquidity_floor_bps = 1), 658);
        assert_eq!(pool(|p| p.min_venue_move = 1), 660);
        assert_eq!(pool(|p| p.loss_tolerance_bps = 1), 668);
        assert_eq!(pool(|p| p.deploy_paused = true), 670);
        assert_eq!(pool(|p| p.impaired = true), 671);
        assert_eq!(pool(|p| p.buy_tickets_paused = true), 672);
        assert_eq!(pool(|p| p.harvest_gain = 1), 673);
        assert_eq!(pool(|p| p.harvest_fee = 1), 681);
        assert_eq!(pool(|p| p.harvest_depositor = 1), 689);
        assert_eq!(pool(|p| p.harvest_prize = 1), 697);
        assert_eq!(pool(|p| p.epoch_start_principal = 1), 705);
        assert_eq!(pool(|p| p.venue_kind = 1), 713);
        assert_eq!(pool(|p| p._reserved[0] = 1), 714);

        let player = |set: fn(&mut Player)| offset(Player::INIT_SPACE, set);
        // `owner` at 8 is what the indexer's per-owner memcmp filters on.
        assert_eq!(player(|p| p.owner = Pubkey::new_from_array([1; 32])), 8);
        assert_eq!(player(|p| p.epoch_id = 1), 48);
        assert_eq!(player(|p| p.yield_index = 1), 98);
        assert_eq!(player(|p| p.version = 1), 114);
        assert_eq!(player(|p| p.pending_deposit = 1), 115);
        assert_eq!(player(|p| p.pending_deposit_epoch = 1), 123);
        assert_eq!(player(|p| p._reserved[0] = 1), 131);

        let proposal = |set: fn(&mut VenueProposal)| offset(VenueProposal::INIT_SPACE, set);
        assert_eq!(proposal(|p| p.pool = Pubkey::new_from_array([1; 32])), 8);
        assert_eq!(proposal(|p| p.venue_kind = 1), 40);
        assert_eq!(proposal(|p| p.klend_program = Pubkey::new_from_array([1; 32])), 41);
        assert_eq!(proposal(|p| p.klend_market = Pubkey::new_from_array([1; 32])), 73);
        assert_eq!(proposal(|p| p.klend_reserve = Pubkey::new_from_array([1; 32])), 105);
        assert_eq!(proposal(|p| p.klend_ctoken = Pubkey::new_from_array([1; 32])), 137);
        assert_eq!(proposal(|p| p.proposed_at = 1), 169);
        assert_eq!(proposal(|p| p.bump = 1), 177);
    }

    /// A version-1 account: Anchor's default discriminator, then zeroes for
    /// the old size. Every rewritten type must refuse it by name.
    fn v1_account(name: &str, old_space: usize) -> Vec<u8> {
        let disc = solana_sha256_hasher::hash(format!("account:{name}").as_bytes()).to_bytes();
        [&disc[..8], &vec![0u8; old_space][..]].concat()
    }

    fn assert_refused<T: AccountDeserialize>(data: Vec<u8>) {
        match T::try_deserialize(&mut &data[..]) {
            Err(Error::AnchorError(e)) => assert_eq!(
                e.error_code_number,
                ErrorCode::AccountDiscriminatorMismatch as u32
            ),
            Err(other) => panic!("wrong error: {other:?}"),
            Ok(_) => panic!("a version-1 account deserialised"),
        }
    }

    #[test]
    fn a_layout_2_account_fails_with_discriminator_mismatch() {
        // The Weight tree layout: same size family, discriminators ending in 02.
        assert_refused::<Pool>([&b"HVPool02"[..], &[0u8; 879][..]].concat());
        assert_refused::<Player>([&b"HVPlyr02"[..], &[0u8; 199][..]].concat());
    }

    #[test]
    fn a_version_1_account_fails_with_discriminator_mismatch() {
        assert_refused::<Pool>(v1_account("Pool", 653));
        assert_refused::<Player>(v1_account("Player", 307));
    }
}
