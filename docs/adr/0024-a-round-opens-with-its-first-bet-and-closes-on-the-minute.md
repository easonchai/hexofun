# A Round opens with its first bet and closes on the minute

Superseded by ADR 0025 (2026-10-08): Rounds leave the chain, so there is no Round account to open lazily. The close-on-the-minute rule survives in the backend game engine (`docs/plan/off-chain-tickets/spec.md`). Never built; the text below is as accepted on `feature/lazy-rounds`.

Status: accepted (2026-10-08). The spec is `docs/plan/lazy-rounds/spec.md`. It supersedes the
empty-round-skip plan (`docs/plan/empty-round-skip/spec.md`), which was never built.

The Operator opened a Round every `round_seconds` around the clock and asked ORAO for randomness
on each one, so an idle board cost about 1.6 SOL a day for draws that decided nothing. Skipping
empty Rounds at the close would have kept the clock-driven schedule and added a third ending for a
Round.

Now no Round exists until a Player bets. One instruction, `open_round_and_buy`, creates the Round
and buys the Position together, so every Round holds a Position from its first slot and an empty
Round cannot exist. The program sets the schedule from the chain clock: betting closes at the
first multiple of `round_seconds` that is at least `round_seconds` away, and the draw is
`close_buffer` later. `round_seconds` therefore means the grain and the minimum open window, no
longer the exact length. The opener pays the Round's rent and `close_round` refunds whoever paid,
read from a new `rent_payer` field in the Round's reserved bytes. The Operator never opens a
Round; `create_round` stays operator-only, on the same schedule, for tests and drills.

Rejected: a backend endpoint that asks the Operator to open a Round when a player wants to bet.
It needs no program change but adds an endpoint, a wake path and an "opening" wait in the web, and
the Round it opens can still end up empty, so the skip work stays. Rejected: the Operator opening
a follow-on Round after every played one so the board looks alive. That is a second opening path,
and the Round after the last player leaves is empty again. Rejected: pool-paid Round rent through
a PDA signer, a SOL balance to fund and watch for a cost the player already fronts on Positions.

Consequence: the board is idle between Rounds until someone bets, and says so. Two openers in the
same second race; the loser's transaction fails with `RoundAlreadyOpen` and the web resends it as
a plain bet into the Round that won. An idle day costs no randomness and no Operator transactions
beyond the epoch cranks.
