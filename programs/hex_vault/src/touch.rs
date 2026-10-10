//! The touch rule: the lazy stamp of a Player's epoch and the fold of its
//! pending deposit at an epoch boundary (spec §2.2).
//!
//! Every instruction that reads or changes a Player's Principal calls
//! [`touch`] first, before it applies its own change. Nothing sweeps players
//! at an epoch boundary; each player pays for their own stamp the next time
//! they act. Tickets are not on chain: the backend resets them from the
//! `EpochBegan` event (ADR 0025).

use crate::state::{Player, Pool};

/// Stamps `player` with the current epoch and zeroes its pending deposit the
/// first time it is touched in an epoch later than its stamp (ADR 0020). A
/// no-op within an epoch, and before the first epoch begins.
pub fn touch(player: &mut Player, pool: &Pool) {
    if player.epoch_id < pool.current_epoch_id {
        player.pending_deposit = 0;
        player.epoch_id = pool.current_epoch_id;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use anchor_lang::prelude::*;

    /// An all-zero account of type `T`: every field at its zero value.
    pub(crate) fn zeroed<T: AnchorDeserialize>(space: usize) -> T {
        T::deserialize(&mut &vec![0u8; space][..]).expect("zeroed account")
    }

    fn pool_in(epoch: u64) -> Pool {
        let mut pool: Pool = zeroed(Pool::INIT_SPACE);
        pool.current_epoch_id = epoch;
        pool
    }

    fn player(principal: u64, epoch_id: u64) -> Player {
        let mut p: Player = zeroed(Player::INIT_SPACE);
        p.principal = principal;
        p.epoch_id = epoch_id;
        p
    }

    #[test]
    fn within_an_epoch_nothing_is_stamped() {
        let mut p = player(100, 3);
        p.pending_deposit = 40;
        touch(&mut p, &pool_in(3));
        assert_eq!((p.epoch_id, p.pending_deposit), (3, 40));
    }

    #[test]
    fn a_later_epoch_stamps_the_player_and_leaves_principal_alone() {
        let mut p = player(100, 3);
        touch(&mut p, &pool_in(5));
        assert_eq!((p.epoch_id, p.principal), (5, 100));
    }

    #[test]
    fn a_pending_deposit_folds_in_the_next_epoch_and_not_before() {
        let mut p = player(300, 3);
        p.pending_deposit = 200;
        p.pending_deposit_epoch = 3;
        touch(&mut p, &pool_in(3));
        assert_eq!(p.pending_deposit, 200);
        touch(&mut p, &pool_in(4));
        assert_eq!((p.pending_deposit, p.principal), (0, 300));
    }

    #[test]
    fn before_the_first_epoch_nothing_is_stamped() {
        let mut p = player(100, 0);
        p.pending_deposit = 100;
        touch(&mut p, &pool_in(0));
        assert_eq!((p.epoch_id, p.pending_deposit), (0, 100));
    }

    #[test]
    fn a_fresh_player_starts_in_the_current_epoch_at_the_current_index() {
        let mut pool = pool_in(2);
        pool.yield_index = 7;
        let mut p: Player = zeroed(Player::INIT_SPACE);
        p.init_if_fresh(Pubkey::new_unique(), &pool, 254);
        assert_eq!((p.epoch_id, p.yield_index, p.bump), (2, 7, 254));
        assert_eq!(p.version, crate::constants::LAYOUT_VERSION);
    }
}
