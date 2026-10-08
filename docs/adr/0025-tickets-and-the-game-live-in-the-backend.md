# Tickets and the game live in the backend; the jackpot draw commits a Merkle sum root before VRF

Status: accepted (2026-10-08). The spec is `docs/plan/off-chain-tickets/spec.md`. It overturns
one sentence of ADR 0018, which rejected an off-chain draw because it "brings back the trusted key
0002 removed", and it supersedes ADR 0024 whole. ADR 0020's rule that Tickets count from the next
epoch stands; the ledger applies it instead of the tree, and it closes the gap 0020 accepted: the
reset counts unsettled yield as Principal, computed off chain with the program's own formula, so a
wallet that never transacts is no longer short its yield's Tickets.

Every Ticket movement was a Solana transaction: a deposit appended a Leaf to a 10 MiB Weight tree,
a bet created a Position account, every Round asked ORAO for randomness at 0.0018 SOL, a referral
bonus was a `grant_tickets` transaction per Referrer per day. The program was about 1 MB, most of
it game, tree and grant code the audit had to read, and none of it decided whether a depositor's
USDC was safe.

Now the program is custody only: deposit, the withdraw queue, epochs, venue, harvest, pauses,
`buy_tickets` as a USDC sink that emits an event, and the jackpot draw. Tickets, grants, bought
Tickets, Rounds and Positions are Postgres rows in a Ticket ledger the backend owns. Code says
`tickets`; `entries` is gone.

The draw keeps ORAO VRF and stays checkable on chain without the tree. At each epoch end the
Operator builds the Epoch snapshot as a Merkle sum tree (SHA-256, `0x00` leaf and `0x01` node
prefixes, positional proofs, sums in the nodes) and passes its root, total, depth and leaf count to
`request_draw`, which mixes the root into the VRF seed and freezes it. `payout` verifies the
winner's proof reaches that root, that the sums reach the total, and that the target falls in the
winner's range. A sum tree rather than a prefix-in-leaf tree because the proof itself fixes the
range, so leaves cannot overlap or leave a gap the prize could fall into.

The game's randomness is a commit-reveal with a drand quicknet beacon. The backend commits
`sha256(seed)` when a Round opens, closes on a minute mark, and mixes the seed with beacon round
`roundAt(closeAt) + 2`, which does not exist at close. Not a Solana blockhash, because a slot
leader can skip or reshape its block to choose between hashes. Not bettor seeds, because the
Sparring player bets last. No fallback source: if no relay serves the beacon within 10 minutes the
Round voids and refunds. Each bet is an ed25519 signature by a session key the wallet delegated
once a day in a Sign-In-With-Solana shaped message, as dYdX, Polymarket and Drift do, so the
published Round record proves who bet what and a dropped bet shows as a sequence gap.

What ADR 0018 feared was a key that picks the winner. The trust accepted here is narrower and is
published: the Operator writes the snapshot and runs the game, both records are public and
recomputable, and neither can change after the randomness, because the root is in the seed and the
beacon follows the close. What remains the Operator's word: a wallet omitted or inflated in the
snapshot (caught by recomputing the published root), a session's final bet dropped (the last one
has no following `seq` to expose it), a bet's receive time backdated past the close, and a beacon
declared missing that a relay later serves (provable from the relay). A per-Round memo on chain
would anchor two of these and was declined for now.

Ledger users deposit and win the draw but cannot play the game, because wallet-adapter's Ledger
path has no `signMessage` to delegate with.

Considered and rejected: an operator-signed winner through the ed25519 precompile, which makes the
VRF decoration; an optimistic payout with a challenge window, which needs an arbiter and delays
every prize; a zk inclusion proof, which costs 78k CU and a trusted setup for privacy nobody asked
for; keeping the game on chain with lazy Rounds (ADR 0024), which removes the idle cost and
nothing else.

Consequences: the program loses the Weight tree, FreeLeaves, Round, Position, their instructions,
`grant_tickets` and `release_leaf`, and the game parameters leave `Pool` for a signed Game config
row. The Operator tick loses its Round steps. The pool ships fresh under ADR 0016 with no account
migration. A played Round costs no chain transaction. The snapshot rows become the only way to
build a payout proof, so the published snapshot is the replicable copy and the database backup
gains a daily snapshot export. The glossary retires Weight tree, Leaf, FreeLeaves and Leaf release
and adds Ticket ledger, Epoch snapshot, Session key, Round record, Beacon and Game config.
