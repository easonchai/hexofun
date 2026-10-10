# A queued withdrawal waits for open Positions, an Impaired pool refuses deposits, and a Haircut exit needs the owner

Status: accepted (2026-10-05). It amends ADR 0017 and ADR 0020. The 2026-10-05 review of `feature/mainnet-contracts` found the three gaps below, and the spec is `docs/plan/mainnet-review-fixes/spec.md`.

ADR 0020 let a queued withdrawal stay in the draw and the game until it pays. That opened one hole.
A Player could queue a full withdrawal, stake Tickets in a round the next epoch, let
`process_withdraw` pay while the stake sat on the board, and take the stake back at settle. They
ended up holding Tickets with no Principal behind them and a chance at the Prize. ADR 0017 also
left two gaps for the Impaired state. Deposits stayed open, and anyone could push another Player's
exit through at the Haircut value. This ADR closes all three and records two risks the team accepts
for launch.

Rule 1. A queued withdrawal cannot pay while the Player has a Position open. The `Player` counts
its open Positions in a field taken from its reserved bytes. `buy_position` raises the count and
`settle_position` lowers it. `process_withdraw` fails with a named error while the count is above
zero, and the Operator treats that error as "try again later". Anyone can settle a finished
Position, and the Operator already does so before it pays withdrawals, so a depositor sees no
difference. `request_withdraw`, the refund of a Pending deposit and `emergency_withdraw` are not
gated. The first two change no Tickets. The last runs only after Shutdown, when no draw can be
requested and no new Position can be bought.

Rule 2. An Impaired pool refuses deposits. A deposit of 1000 into a pool that holds 750 against
1000 owed is worth 875 a second later, because the Haircut applies to it at once. The newcomer
loses money on arrival for a loss they did not see. Rejected, on 2026-10-05: keep deposits open
with a warning on the form. A warning does not stop an integrator or a script, and the program is
the only place that can promise a depositor never buys into a loss. A Prize paid while Impaired
still compounds into Principal, because an epoch already Drawn must be able to finish. The
instructions `request_withdraw`, `recall` and `cover_deficit` keep working while Impaired.

Rule 3. While Impaired, `process_withdraw` and `emergency_withdraw` need the signature of the
Player's owner. The owner account is optional in both instructions, and a call without it fails
with a named error. While the pool is not Impaired, both stay permissionless and pay to the owner's
own account as before. The Operator's withdrawal crank skips while the mirrored pool is Impaired
and resumes when it clears. The point is that the depositor decides whether to leave at the Haircut
value or wait for a recovery, since a Player who leaves at the Haircut takes no part in a later
gain. Rejected: let anyone realise a Haircut for someone else. It lets a stranger, or the Operator's
own crank, lock in a loss that a recovery might have undone. The refund of a Pending deposit
already needs the owner. Applying the rule to `emergency_withdraw` follows from the same reasoning.

Solvency. After every instruction, within rounding dust, `vault balance + venue value >=
total_principal + yield_owed + fee_owed + prize_owed - deficit`. There is no Pending withdrawals
term. A queued withdrawal stays inside Principal until it pays, as ADR 0020 says, so adding it
counts the same USDC twice. The formula in ADR 0017 and in the yield-claimer spec added the term
and is wrong. They now point here and to ADR 0020.

Accepted risk 1, no floor on `base_rate_bps`. The Admin, a Squads multisig on mainnet, can set the
ceiling on the depositor share to zero. Every venue gain above the Yield fee then goes to the
Prize. The other venue parameters are bounded by program constants, and this one is not. The
comment in the program says so. A floor would stop a compromised Admin from starving depositors of
yield. It would also stop the team from ever lowering the rate to grow the Prize, and the multisig
already needs to be trusted with every other parameter. The decision on 2026-10-05 was no floor.

Accepted risk 2, exits depend on klend. Every instruction that syncs the venue fails if klend does
not respond. That includes `request_withdraw`, `process_withdraw` and `emergency_withdraw`. Until
klend answers, no depositor can leave, and there is no bypass before a program upgrade. The team
accepts this for launch. The incident playbook has an entry for it. A later upgrade should add an
escape switch that only the Admin can set and only after Shutdown, under which exits skip the venue
call and share the idle USDC pro rata. It is not built here.

Consequences: the open-Positions count lands in the reserved bytes of `Player`, so the account size
does not change and zero is the safe default. Pools ship fresh through the ADR 0016 cutover, so no
migration is needed. ADR 0017 stays accepted. Its sentence that deposit still works while Impaired,
and its solvency formula, are corrected in place with a pointer to this ADR. The Haircut, Impaired
and Pending withdrawal entries in the glossary describe the new rules. The web closes the deposit
form with a one-line reason while the pool is Impaired. It also shows a due queued withdrawal's
Haircut value beside a button that sends `process_withdraw` signed by the owner.
