# Tickets count from the next epoch, and the queued withdrawal is the only exit for ticketed Principal

Status: accepted (2026-10-05). The design is in `docs/plan/yield-claimer/spec-next-epoch-tickets.md`, which amends `spec.md` in the same folder.

A depositor sees "Tickets: 100" on screen, but the draw does not select over that number. ADR 0018
made the draw select over Weight, which is Tickets times the seconds held, so a depositor who
arrives at noon has half the odds of one who arrived at midnight with the same number showing. The
screen cannot show the real figure either, because it is not final until the epoch ends. ADR 0017
also gave a depositor two ways out. The instant one needs Tickets to back the amount, so a player
who lost in the game found their money locked for a reason they did not expect.

The rule is now one sentence a depositor can repeat. USDC you hold at the start of a day is your
Tickets for that day. Deposit today and you are in tomorrow's draw. Ask to withdraw today and you
stay in today's draw and the game, and your USDC pays out after the day ends. The number on screen
is exact: Tickets are a whole-unit count, one per micro-USDC, and the draw selects over that same
count.

This ADR supersedes the time-weighting of ADR 0018 and the instant withdraw of ADR 0017, and
nothing else in them. From ADR 0017 the Idle band, deploy, recall, harvest, the Yield index, venue
loss and the Haircut stand. From ADR 0018 the Fenwick tree, the parity slots, the lazy reset, the
idle rule, append, the removal of registration and the Leaf cap stand. Weight retires as a quantity
and the tree's slots hold Tickets instead. ADR 0001 stands: Principal and Tickets stay numbers on
the Player.

The mechanism changes four things. First, Principal earns Tickets from the epoch after the one it
was deposited in. Yield settled into Principal, Bought tickets, Granted tickets, round rewards, void
refunds, House credits and the Prize all credit Tickets the moment they land. Only fresh Principal
waits. Second, the Player gains `pending_deposit` and `pending_deposit_epoch`, taken from the
reserved bytes. Principal already includes the pending amount, so pending is a sub-balance. A deposit
raises Principal and `pending_deposit` and leaves Tickets alone. The first touch in a later epoch
sets Tickets to Principal, zeroes `pending_deposit` and stamps the epoch, so a pending deposit folds
into active Tickets inside the reset that already exists.

Third, each tree entry keeps `principal_sum` and its two parity slots, and a slot stores its stamp,
its base and a Ticket count in one 64-bit word. The entry shrinks from 72 to 56 bytes, so the 10 MiB
cap holds about 187,000 Leaves instead of 145,000. A write in epoch `e` resets a slot stamped
otherwise to `stamp = e`, `base = principal_sum`, `tickets = principal_sum`, with no multiplication
by epoch length. A deposit adds to `principal_sum` and adds nothing to the slot's Tickets. Every
other Ticket change adds its signed amount to the slot's Tickets, and a settled yield and a Prize
also add to `principal_sum`. The read rule is unchanged: epoch `p` reads the slot stamped `p`, else
the next epoch's base if that slot is stamped, else the live `principal_sum`. Append is unchanged
except that it sums Tickets and bases. The epoch clock drops its start and end times and the
forward-credit helper, and keeps the epoch id, the two-epoch readability rule and the guard against
beginning an epoch while the one two behind is still drawing. `request_draw` snapshots the root as
a 64-bit Ticket total, `draw` reduces the VRF digest under it, and `payout` checks the winner's
Leaf range as before. No parameter is added.

Fourth, `request_withdraw(amount)` is the one exit and it splits the amount. The part up to
`pending_deposit` never held a Ticket and refunds at once. It pays from free idle and redeems any
gap from the venue in the same instruction, with the reserve liquidity pre-check that ADR 0017
introduced. If the venue cannot cover the gap the whole call fails with a named error and nothing
changes. The Haircut applies to the refund while Impaired, as it applies to every exit. The rest
queues. The request raises `pending_withdraw` and re-stamps `pending_epoch` and `requested_at`, and
it changes no Principal, no Tickets, no `total_principal` and nothing in the tree. A queued request
therefore stays in the draw and the game and keeps earning yield until it pays. `process_withdraw`
matures as before and then lowers Principal, Tickets with a floor at zero, `total_principal` and the
tree, and computes the Haircut on the pending amount at that moment. A player who requests
everything and then loses Tickets in a round still gets their Principal in full, because the
Tickets side floors at zero, which the epoch reset would have done anyway. `emergency_withdraw`
pays active Principal, the pending deposit and the pending withdrawal together.

ADR 0017 required Tickets of at least the amount for an instant withdraw. That rule stopped an exit
and re-deposit from refilling Tickets lost in the game. It goes, because a re-deposit now earns
Tickets only from the next epoch, when the reset would have refilled them regardless.

Rounds follow from the same rule. `buy_position` is refused with a named error when the round would
end after the current epoch ends. The stake leaves Tickets and the tree at `buy_position` and comes
back with the reward at `settle_position`, both as plain Ticket deltas. This replaces the
time-based pre-credit. No round can outlive its epoch, so a stake can never fall between two draws.

The Prize is the one case of fresh Principal earning Tickets in the same epoch. It is added to the
winner's Principal and Tickets at once. The winner already holds a ticketed balance, and holding the
Prize back for a day would buy a day of odds at the price of extra code. One drift is accepted too.
Yield earned on a pending deposit credits live Tickets, because settle adds owed yield to Principal
and Tickets together. That is cents a day, and one uniform rule is worth more than routing it.

ADR 0018 rejected a snapshot at epoch end with a deposit delay because it broke the instant
withdraw. That objection no longer holds. The instant withdraw is gone, so no exit competes with a
deposit delay. The stamped slots stay, so a lazy depositor needs no activation transaction and the
ended epoch stays readable for two epochs. What ADR 0018 rejected was a snapshot built on a crank
or a freeze, and this design needs neither.

Considered and rejected on 2026-10-05: a plain sum tree with no stamped slots. It needs either a
crank that activates every lazy depositor, or a freeze of the game and the rolls between
`request_draw` and `payout`. A stuck VRF request stalling the whole pool was a beta blocker, so the
freeze is out, and the crank brings back a per-Player transaction that ADR 0018 removed. The
stamped slots already give lazy activation and the two-epoch read, so swapping what a slot stores is
the smaller change.

Considered and rejected on 2026-10-05: splitting game Tickets from the draw, so that a new deposit
could play at once while a separate count fed the draw. It puts two numbers on the Player and
needs a rule for moving Tickets between them, and the number on screen would again differ from the
one the draw selects over, which is the problem this ADR removes. New depositors get Bought tickets
as the way into the game on day one.

Out of scope, not rejected. An instant exit for ticketed Principal, including a "leave now and
forfeit today's draw" variant, can return behind a flag without touching the tree. Cancelling a
queued withdrawal, wagering pending Tickets in the game and routing yield on a pending deposit into
pending Tickets are also left for later.

Consequences: `instant_withdraw` leaves the program, the IDL, the backend and the web. Ticket 16
landed in commit 8c048d4 before this decision, so tickets 22 and 23 remove it instead of a revert
that would also undo tickets 14 and 15. Compute falls, because every tree write loses a 64 by 128 bit multiply
per entry, and rent per Leaf falls from 72 to 56 bytes, about 0.00028 SOL at 5,080 lamports a byte.
Pools ship fresh through the pool cutover of ADR 0016 with no account migration, because the Player
layout and the tree entry both change. The queued amount now stays in `total_principal` until it
pays, so the solvency invariant and the Haircut formula of ADR 0017, which add or subtract Pending
withdrawals beside `total_principal`, have to count it once, and the ticket that builds the split has to settle those formulas. The
glossary defines Tickets, Weight, Weight tree, Leaf, Draw, Pending withdrawal and Pending deposit
in the new terms.
