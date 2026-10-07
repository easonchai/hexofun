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
was deposited in. Bought tickets, Granted tickets, round rewards, void refunds, House credits and the
Prize all credit Tickets the moment they land. Fresh Principal waits, and settled yield is fresh
Principal (amended 2026-10-07, see below). Second, the Player gains `pending_deposit` and `pending_deposit_epoch`, taken from the
reserved bytes. Principal already includes the pending amount, so pending is a sub-balance. A deposit
raises Principal and `pending_deposit` and leaves Tickets alone. The first touch in a later epoch
sets Tickets to Principal, zeroes `pending_deposit` and stamps the epoch, so a pending deposit folds
into active Tickets inside the reset that already exists.

Third, each tree entry keeps `principal_sum` and its two parity slots, and a slot stores its stamp,
its base and a Ticket count in one 64-bit word. The entry shrinks from 72 to 56 bytes, so the 10 MiB
cap holds about 187,000 Leaves instead of 145,000. A write in epoch `e` resets a slot stamped
otherwise to `stamp = e`, `base = principal_sum`, `tickets = principal_sum`, with no multiplication
by epoch length. A deposit adds to `principal_sum` and adds nothing to the slot's Tickets. Every
other Ticket change adds its signed amount to the slot's Tickets. A settled yield adds to
`principal_sum` only; a Prize adds to both. The read rule is unchanged: epoch `p` reads the slot stamped `p`, else
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
A round that ended inside its epoch can still settle after the epoch rolled. That settle runs `touch`
first, and the reset has already put every stake of the earlier epoch back into Tickets, because a
stake never lowers Principal. So `settle_position` credits only what the reset did not restore. A
winner gets the share of the losers' pot as a plain Ticket delta in the epoch now current, a void
credits nothing, and a settle inside the round's own epoch still credits stake plus reward. The House
credit in `settle_round` is the same in both cases, since the House never stakes. This replaces the
"credit only while the round's epoch is current" rule of ADR 0007 and ADR 0019, so the program has no
wrong-epoch branch left.

The Prize is the one case of fresh Principal earning Tickets in the same epoch. It is added to the
winner's Principal and Tickets at once. The winner already holds a ticketed balance, and holding the
Prize back for a day would buy a day of odds at the price of extra code.

Amended 2026-10-07: settled yield is fresh Principal, like a deposit. `settle` adds the owed yield
to Principal and `total_principal` and leaves Tickets alone, so it counts from the next epoch's
reset. The first version of this ADR credited it to Tickets at once and called the result cents a
day. The fork run showed two flaws. Yield earned on a pending deposit became live Tickets in the
deposit's own epoch, although the deposit waited (366 Tickets from 366.87 settled, on a 50,000 USDC
pending deposit after a 77-day warp). And a Player who transacted had their yield ticketed at once,
while a lazy Player's stayed in `yield_owed` with no Tickets, so odds depended on who happened to
transact. The winner's settle before the Prize follows the same rule; only the Prize credits Tickets.

Accepted gap: Tickets come from Principal, and unsettled yield is not in Principal. From the next
epoch on, a Player who transacted holds their yield as Tickets and a lazy Player does not until
their next touch. The gap is the lazy Player's unsettled yield, about 4% of Principal a year at
today's rate, and a 1 USDC deposit closes it for them. Closing it for everyone needs a settle-only
instruction and an operator crank over every Player each epoch. There is no such instruction, and
it is out of scope.

Accepted cost: `process_withdraw` takes the withdrawn amount out of Tickets with a saturating
subtract. A Player whose yield settled and who withdraws it in the same epoch loses Tickets the
yield never held. With Principal 110, Tickets 100 and a withdrawal of 10 of yield, Tickets end at
90. It is the same floor the No Tickets rule already applies after a round loss, it is
conservative, and telling the two cases apart would need a per-epoch "unticketed Principal" counter
on the Player.

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
layout and the tree entry both change. The queued amount stays in `total_principal` until it pays,
so Pending withdrawals are a reservation of idle USDC inside Principal and not a second claim beside
it. The solvency invariant is therefore `vault balance + venue value >= total_principal + yield owed
+ fee owed + prize owed - deficit`, with no Pending term. The Haircut is `amount x (vault balance +
venue value - owed amounts) / total_principal`, where ADR 0017 had `total_principal + Pending
withdrawals` in the denominator. Free idle stays the vault balance minus Pending withdrawals, so a
refund of a pending deposit never spends USDC held for a queued one. `emergency_withdraw` pays the
Haircut of Principal alone, because Principal already holds the pending deposit and the queued
amount, and adding Pending withdrawals would pay that part twice. The glossary defines Tickets,
Weight, Weight tree, Leaf, Draw, Pending withdrawal and Pending deposit in the new terms.
