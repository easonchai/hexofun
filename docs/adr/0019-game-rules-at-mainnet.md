# At mainnet voids refund, the House cut comes off the losers' pot, and two features ship switched off

The game is what players and regulators will judge first, and five of its rules were written for a
devnet demo. They change once, in the same rewrite as ADRs 0017 and 0018. The reasoning and the
code readings behind each are in `docs/plan/yield-claimer/research/05-game-and-draw-design-options.md`.

Voided rounds refund. Today `void_round` moves the round's pot into `carry_pot`, so every staker's
Tickets go to the next round's winners. Now `settle_position` returns each Position's stake as
Tickets, `carry_pot` is deleted, and a void charges no House cut. A void happens when ORAO's
randomness does not arrive within `vrf_timeout`, which is an oracle outage, not something a player
did, and every parimutuel precedent read refunds in that case. The carry rule also gave a VRF node
a free option: stall on an outcome it dislikes, and the stakers lose while someone else gains.
Under a refund, stalling only delays the round. Whether the refund still lands when the round's
epoch has already rolled over is for the prototype to confirm and ticket 11 to record. A forfeit
does not change: a round nobody covered on the winning tile still sends its whole pot to the House.

The House cut comes off the losers' pot. The cut is `house_cut_bps` of the pot minus the winning
tile's total, so a winner gets their own stake back whole plus their share of the rest. ADR 0007
took the cut from the whole pot, so a winner paid it on money they already had. 0007 rejected
taxing net profit because it needed per-position math and a stored stake on the winning tile, but
the losers' pot needs neither: `Round.tile_totals` already holds the winning tile's total. This
narrows 0007's cut base and leaves the rest of 0007 standing. The House earns less per round than
it did.

The Sparring player runs behind a backend environment flag that is off by default and unset in
every production env file. No program change. It buys all 36 tiles at one Ticket each in every
round, so it gets back at least `1 − house_cut` per Ticket and more when humans crowd a few tiles.
Against people, that is a structural edge held by a team-run wallet that looks like any other
player on screen. Rounds where it plays alone also spend about 0.00185 SOL of ORAO fees each for
nothing. Devnet keeps it on so a lone tester has someone to play against.

Bought Tickets are paused on chain. `buy_tickets` is refused while the pool's buy-tickets-paused
switch is set. Only the Admin sets it, and it is on at mainnet launch. Counsel has not answered on
selling Tickets for USDC that goes to a prize, and the web's Feature gate only hides the button:
anyone with a script could still call the instruction. The web gate stays as well.

Outcomes derive from a hash of all 64 bytes of ORAO's randomness, for the round tile and for the
draw target. Today `vrf.rs` reads bytes 0 to 7 for a tile and 0 to 15 for a weight point, and
ignores the rest. ORAO's output is an XOR of Ed25519 signatures, whose bytes 31 and 63 are not
uniform, so which bytes a consumer reads matters; a hash over all of them removes that choice and
uses every byte. In the same change `Round` records the slot of its VRF request, and the
`vrf_timeout` floor rises from 60 s to 180 s, because ORAO's measured tail reached 62 to 77 s and a
floor-level timeout would void about one round in six. The default moves to the floor if it is
below it.

Considered and rejected: dropping the Sparring player outright. Devnet needs it, and a flag costs
nothing.

Considered and rejected: relying on the web gate alone for Bought Tickets. The gate covers the
app, not the program.

Consequences: `carry_pot` leaves `Pool`, and the void and forfeit paths differ: a void returns
stakes, a forfeit pays the House. Round screens show a winner's stake coming back whole. House
revenue from rounds drops, and so do the draw odds the House gains from game volume under ADR 0007. The Sparring player's absence on mainnet means a lone human waits for a second player.
Lifting the Bought Tickets pause is an Admin transaction once counsel answers, with no upgrade.
