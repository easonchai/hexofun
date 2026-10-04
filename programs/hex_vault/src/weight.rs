//! The Weight tree's side of a Ticket change (yield-claimer ticket 08).
//! Ticket 06 only fixes the call site and signature the callers use.

use anchor_lang::prelude::*;

use crate::state::{Player, Pool};

/// Credits `tickets` just added to `player` to its leaf: `tickets` times the
/// seconds from `now` to the current epoch's end, zero once that end has
/// passed (`weight_tree_proto::Clock::forward`).
///
/// A no-op until ticket 08, which adds the tree account to its arguments and
/// writes the Fenwick update path. Callers pass the Tickets already added to
/// `player.entries`.
pub fn credit_tickets(_pool: &Pool, _player: &Player, _tickets: u64, _now: i64) -> Result<()> {
    Ok(())
}
