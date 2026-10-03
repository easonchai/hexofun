# A configurable House cut comes off every settled round pot, and rounds stay zero-sum across Players including the House

> **2026-10-04: narrowed by [ADR 0019](0019-game-rules-at-mainnet.md).** The cut is taken from
> the losers' pot, the pot minus the winning tile's total, so winners get their own stake back
> whole. The rest of this ADR stands.

ADR 0003 made rounds zero-sum among the players at the table, with the House only ever receiving forfeited pots. That left the product with one revenue path, the House winning the daily draw on forfeited odds, which PRD-V2 §revenue judged too thin. This decision narrows 0003: `settle_round` credits `pot × house_cut_bps / 10000` (floored) to the House as Entries before the winners split the remainder, so `Σ entries == total_principal` still holds and no Entries are minted or burned. The rate is a Pool parameter with no cap beyond 100%, set at `create_pool` and via `set_params`, and applies to the next round settled.

Considered and rejected: taxing each winner's net profit instead of the gross pot. It spares a player who covers every tile from paying on their own stake back, but needs per-position math and a stored per-position stake-on-winning-tile, and the PRD already specifies the pot-level cut. Also rejected: subtracting the cut from `round.pot` in place. It touches no client code, but leaves nothing on chain that says how much the House took, and the position screen has to show it. So `round.pot` stays gross and the cut is stored on the Round and emitted in `RoundSettled`.

Consequences: the House's draw odds now grow with game volume, not just forfeits, so the 50/30/20 split of a House win matters more. Forfeited and voided rounds take no cut. A round whose epoch has already rolled over evaporates its cut along with its pot, as in audit-fixes/01.
