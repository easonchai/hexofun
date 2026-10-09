# The engine keeps a Round open, and the Sparring player waits for a human

Status: accepted (2026-10-09). It supersedes the first-bet rule of ADR 0024 (a Round opens with its
first bet), which ADR 0025 carried into the backend engine as a lazy open. ADR 0024's other rule,
closing on the minute mark, stands. The spec is `docs/plan/off-chain-tickets/spec.md`, tickets 29
and 30.

ADR 0024 opened a Round only on a bet because every Round cost VRF and rent on chain, about 1.6 SOL a
day idle. ADR 0025 moved Rounds into Postgres. An idle Round now costs a row, so the reason for
opening lazily is gone, and its price is visible: the board sat on "place a bet to open the next
round", and the Sparring player, which never opens a Round, did nothing until a human did.

Now the engine opens the next Round as soon as none is open: on startup and when a Round closes. Its
`closeAt` is the next minute mark, so Rounds run exactly `roundSeconds` back to back and the
countdown always shows. It opens none while the game is paused or shut down, or when the Round would
close after the epoch end; the board is idle until the next epoch. A bet that finds no Round open
still opens one, with the old rule (a `closeAt` at least `roundSeconds` away), and a bet that names
the next Round id while the engine's is open gets `RoundAlreadyOpen`. Two openers still make one
Round: both take the pool's ledger lock and the second finds the first.

An empty Round is written and runs the normal close and reveal path. It books no ledger rows, since
a settle skips zero amounts. That is about 1,440 small rows a day at 60 s, and a drand fetch each.
Pruning them can wait. `GET /state` returns the newest Round with a pot as `lastRound`, never an
empty one, so the web does not replay a reveal every minute.

The Sparring player bets into an open Round only once a wallet other than itself holds a Position in
it. Alone in an empty Round it would pay the House cut on its own losing tiles every minute, about
3,000 Tickets a day with nobody else playing. This is for now. It also means the Sparring player's
bet always comes after a human's, which the commit-reveal already assumed.

Rejected: a backend wake path that opens a Round when a player wants to bet. It adds an "opening"
wait to the web for a saving that no longer exists. Rejected: the Sparring player opening Rounds, for
the cost above.

Consequence: the board is never idle while the game runs, and an unplayed minute leaves a settled row
with a pot of 0.
