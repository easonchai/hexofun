//! The touch rule: the lazy reset of Tickets to Principal at an epoch
//! boundary (spec §2.2).
//!
//! Every instruction that reads or changes a Player's Tickets calls
//! [`touch`] first, before it applies its own change. Nothing sweeps players
//! at an epoch boundary; each player pays for their own reset the next time
//! they act.
//!
//! The per-Player Weight accrual and the freeze that fed `register` were
//! removed by the layout rewrite (yield-claimer ticket 04). The Fenwick tree
//! keeps a Ticket count per epoch instead (tickets 08 and 19).

use crate::state::{Player, Pool};

/// Resets `entries` to `principal` the first time `player` is touched in an
/// epoch later than the one its Tickets belong to. A no-op within an epoch,
/// and before the first epoch begins.
pub fn touch(player: &mut Player, pool: &Pool) {
    if player.epoch_id < pool.current_epoch_id {
        player.entries = player.principal;
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

    fn player(principal: u64, entries: u64, epoch_id: u64) -> Player {
        let mut p: Player = zeroed(Player::INIT_SPACE);
        p.principal = principal;
        p.entries = entries;
        p.epoch_id = epoch_id;
        p
    }

    #[test]
    fn within_an_epoch_tickets_are_left_alone() {
        let mut p = player(100, 30, 3);
        touch(&mut p, &pool_in(3));
        assert_eq!((p.entries, p.epoch_id), (30, 3));
    }

    #[test]
    fn a_later_epoch_resets_tickets_to_principal() {
        let mut p = player(100, 300, 3);
        touch(&mut p, &pool_in(5));
        assert_eq!((p.entries, p.epoch_id), (100, 5));
    }

    #[test]
    fn the_house_resets_to_zero_tickets() {
        let mut house = player(0, 5_000, 3);
        house.is_house = true;
        touch(&mut house, &pool_in(4));
        assert_eq!(house.entries, 0);
    }

    #[test]
    fn before_the_first_epoch_nothing_resets() {
        let mut p = player(100, 40, 0);
        touch(&mut p, &pool_in(0));
        assert_eq!((p.entries, p.epoch_id), (40, 0));
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
