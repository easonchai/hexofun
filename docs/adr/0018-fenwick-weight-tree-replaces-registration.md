# Every Player is in the draw through a Fenwick weight tree, and registration is removed

Status: accepted (2026-10-04). Prototype 02 reported the same day: the tree matched today's `touch` and `register` to the unit over 1,000 random sequences in both readable epochs, a node is 72 bytes, and a worst-path update costs about 2,000 CU at 100,000 nodes. One correction from the prototype: the Player keeps an epoch stamp, because the lazy reset of Tickets to Principal needs it and the tree holds range sums, not per-Player stamps.

ADR 0002 made the draw time-weighted and on chain: each Player accumulated `entries × seconds` on
every touch, and after the epoch ended `register` turned that into a contiguous interval of the
epoch's total. That needs one `register` per Player per epoch, which the Operator batches 8 to a
transaction inside a 600 second `registration_window`. A Player the Operator misses is out of that
day's draw. At 10,000 Players it is 1,250 transactions a day that all have to land, and the queue
comes from the Indexer, so a stale Indexer delays the close. `register` also credited Base yield,
which ADR 0017 moves to the Yield index, so only the Weight half of the crank was left. This ADR
supersedes 0002. Its core still holds: no trusted key picks the winner, and PoolTogether V5's
per-Player win check stays rejected because it gives zero or several winners.

Weight now accrues forward. Every Ticket change credits `Δtickets × (epoch_end − now)` into the
Player's Leaf, the way `buy_position` already pre-credits a round. A change after `epoch_end` and
before the next `begin_epoch` credits zero, as the clamp in `touch` does today, and a deposit in
that gap earns Weight from the new epoch's start, never backdated. A Player's Weight at the end of
the epoch is the same `tickets × seconds` figure registration computed, so the odds do not change.

The Leaves live in a Fenwick tree in one zero-copy account per pool. The Admin creates it at
`create_pool` with a top-level `create_account`, because it can pass the 10 KiB limit of an
in-program create. Each entry is 72 bytes: a live `principal_sum` and two slots, one per epoch
parity. A slot holds `stamp`, the epoch id; `base`, the entry's `principal_sum` when the slot was
first written in that epoch; and `weight`. A write in epoch `e` walks the Fenwick update path, and
any slot whose stamp is not `e` is first reset to `stamp = e`, `base = principal_sum`,
`weight = principal_sum × length(e)` before the delta lands. A read of epoch `p` uses the slot
stamped `p` if there is one. Otherwise the entry was idle through `p`, and its weight is
`base × length(p)`, with `base` taken from the next epoch's slot if that is stamped, else from the
live `principal_sum`. So `begin_epoch` is O(1). Epoch `p` stays readable until
`begin_epoch(p + 2)`, which is why payout must land before then, as the guard in `epochs.rs`
already requires.

The tree grows by append. A Player's Leaf index is assigned at first deposit, stored on the
Player, and the account grows by one 72-byte entry that the depositor pays for: 0.00037 SOL at
5,080 lamports a byte. The new entry is set to the sum of the entries it covers, each resolved
through the slot rule. Nothing is pre-allocated. A deposit that would take the account past
10 MiB, about 145,000 Players, fails with a named error. A second tree is out of scope.

The draw hashes the VRF result, reduces it to a target under the root weight of the ended epoch,
and finds the winner by binary lifting over the tree, about 14 entry reads at 16,384 Players.
`payout` takes the winner's Player account and checks its Leaf index against the target, as it
checks `reg_start <= target < reg_end` today. A Player update touches 8 entries on average and 15
at worst at that size.

The prototype in ticket 02 has to show three things before ticket 04 builds on this. The append
rule and the parity reset must match an eager model of today's `touch` to the unit, for the
current epoch and for the previous one while the new one is written. The compute for an update,
an append and a draw must fit. A `resize` by 72 bytes inside deposit must work. If any of them
fails, the fallback is the dense tree below, and this ADR is revised.

Considered and rejected, from `docs/plan/yield-claimer/research/06-sum-tree-storage-options.md`:

- A dense heap tree of 2N − 1 nodes starting at 4,096 Leaves. It stores twice the nodes, cannot
  grow by append because doubling moves every level, and needs an Admin growth crank with 3 to
  12 SOL prefunded per doubling. It is the fallback if the prototype finds a hole.
- Two-level buckets under a root account. No cheaper, 6.17 SOL against 5.99 at 16,384 Players,
  two accounts per action, and the root is still one write lock. It is the way past 145,000.
- A Leaf on each Player account with only inner nodes shared. The same shared rent as Fenwick
  plus 72 bytes per Player, and the draw would depend on the caller passing the right group of
  Player accounts.
- A concurrent Merkle tree. It hashes and does not sum, stores a change log instead of the
  nodes so every write needs a client proof from an indexer, and has no node for the parity
  slots to live on.

Also considered and rejected: keeping registration and only dropping its yield half, which keeps
the per-Player crank; an exponential race, which needs a fixed-point `ln` and a challenge window;
a snapshot at epoch end with a deposit delay, which breaks with instant withdraw; and an off-chain
draw, which brings back the trusted key 0002 removed. A free list that reuses a closed Player's
Leaf is deferred, not rejected: Players do not close today.

Consequences: `register`, `close_registration`, `registration_window`, the Operator's
registration queue and the Player's `weight_acc`, `last_update`, `frozen_weight`, `frozen_epoch`,
`reg_epoch`, `reg_start` and `reg_end` go. The epoch flow is `begin_epoch`, play, `request_draw`,
`payout`, with no transaction at epoch end. Every instruction that changes Tickets takes the
tree as one more shared writable account, next to `Pool`, which it already writes. Rent moves from
the Operator's per-epoch transaction fees to a one-time per-Player entry the depositor pays. A
Fenwick entry is a range sum, not a Leaf value, so one Player's own Weight is the difference of
two prefix reads; the Indexer computes it, and nothing on chain needs it.

Built in ticket 08 (2026-10-05). The House takes Leaf 1 at `create_pool`, rent paid by the
creator, because it holds Tickets (forfeited pots, the cut) and can win. The tree holds at most
145,634 Leaves. `request_draw`, which is Operator-only, snapshots the ended epoch's root and the
prize; `draw` hashes all 64 VRF bytes with SHA-256 and reduces the digest under that root; `payout`
checks the winner's Leaf range. On a localnet validator with 16,384 Leaves, a first deposit that
appends the last Leaf costs about 45,000 to 50,000 CU in all, against 38,000 on a tiny tree, and
a repeat deposit on the longest path about 33,000. `buy_position` costs 24,000 to 33,000, which is
mostly the Position account's address search.
