# Incident playbooks

`GET /alerts` is what pages a human: 200 with an empty list when things are fine, 503 with the
active codes otherwise (production-hardening ticket 05). Each playbook below opens with the code
that usually starts it. Admin commands run through the CLI,
`pnpm --filter @hexvault/backend admin <command>`, with the target environment's `.env` exported
first; see [`docs/ops/funds.md`](funds.md) for the full convention and signing through a Ledger or
Squads.

<a id="operator-stale"></a>
<a id="indexer-stale"></a>
## Operator or indexer stall

Starts with `OPERATOR_STALE`, sometimes alongside `INDEXER_STALE`.

1. Check `GET /status`: `operator.lastAction` and `operator.lastTickAt` for the operator,
   `cursor.ageSeconds` for the indexer.
2. The operator sleeps until the next chain-clock deadline, an epoch's end, a request's
   `vrf_timeout`, an epoch's `payout_timeout`, a venue deadline, and works through one epoch at a
   time: `begin_epoch`, `request_draw`, `draw`, `payout`, with `deploy_to_venue`, `recall` and
   `harvest` between them as the pool's liquidity needs, then `process_withdraw` for the queue. It
   sends no round transactions, because Rounds are off chain. A 60s safety tick is the backstop if a
   deadline is missed. Waiting on a deadline is not a stall by itself, as long as `lastTickAt` keeps
   advancing.
3. An epoch whose randomness never arrives rolls over once `vrf_timeout` passes its request, and an
   epoch stuck `Drawn` with no payout rolls over once `payout_timeout` passes. Neither needs a
   human today. See "VRF not fulfilling" below if this keeps repeating.
4. If the tick is genuinely stuck rather than waiting, check the backend logs
   (`docker compose -f <env's compose file> logs -f backend`) for the operator's own error, and
   check `/alerts` for `RPC_DOWN` alongside: a hung RPC read stalls the tick with nothing else to
   show for it, until production-hardening ticket 03's per-call timeout lands.
5. Restart the backend for the affected environment if the process looks hung, not just waiting:
   `docker compose -f docker-compose.dev.yml restart backend` (swap the compose file for the
   environment, see [`docs/ops/environments.md`](environments.md)).
6. Pause the game (`admin pause-game`, either key) if rounds stay visibly stuck after a restart.
   The backend then refuses new bets (`GamePaused`) and opens no new Round, and leaves deposits and
   the daily draw alone; an already-open Round still closes and settles. The pool-wide `pause` (see
   "Suspected exploit" below) stops `deposit` and `buy_tickets` on chain and stops bets and new
   Rounds in the backend. `pause-jackpot` holds `begin_epoch`, `request_draw` and `buy_tickets`.
7. Rounds do not wait on the operator. The backend closes a Round on the minute, reveals its tile
   from a drand beacon and books the settle rows itself, and it voids the Round and refunds every
   bet if no valid beacon arrives within 10 minutes of the beacon round's release. Players see the
   stage read DRAWING until the tile lands ([`runbook.md`](../../runbook.md)). A Round that stays
   DRAWING past that window points at the backend logs and the drand relays, not the chain. Anyone can check a
   settled or voided Round with `node scripts/verify-round.mjs https://<api host>/rounds/<id>/record`
   ([`docs/game-verification.md`](../game-verification.md)).

<a id="rpc-down"></a>
<a id="rpc-fallback-active"></a>
## RPC provider down

Starts with `RPC_DOWN` or `RPC_FALLBACK_ACTIVE`.

1. `RPC_FALLBACK_ACTIVE` means the fallback is already serving: a timeout, 5xx or 429 from the
   primary sends that one call to `RPC_FALLBACK_URL`, and the next call tries the primary again
   (production-hardening ticket 03). Check `GET /status`'s `rpcEndpoint` (`"primary"` or
   `"fallback"`) and `rpcFallbackAt`.
2. If `RPC_FALLBACK_URL` is set and the operator's sends are still landing (`operator.lastAction`
   and `operator.lastTickAt` recent), no action is needed beyond watching it.
3. `RPC_DOWN` without a working fallback needs a new endpoint. Set `RPC_URL` (and
   `RPC_FALLBACK_URL`, if a second provider is available) in the environment's env file, then
   recreate the backend so it picks up the change: `docker compose -f docker-compose.dev.yml up -d
   --force-recreate backend` (swap the compose file and add `--env-file .env.mainnet` on mainnet,
   see [`docs/ops/environments.md`](environments.md)).
4. Rotate the web's public RPC the same way: set `VITE_PUBLIC_RPC_URL` on the affected Vercel
   project to a working public endpoint and redeploy, a Vercel env var only reaches the bundle on
   the next build. Never put a keyed URL there; it ships to every visitor
   ([`runbook.md`](../../runbook.md), "Frontend RPC endpoint").

<a id="epoch-rolled-over-recently"></a>
## VRF not fulfilling

Starts with `EPOCH_ROLLED_OVER_RECENTLY`.

1. Confirm it is ORAO and not the operator: check the backend logs for a sent
   `request_draw` with a confirmed signature and no matching `draw`, and
   check `GET /epochs/current` for an epoch parked past its `vrf_timeout`.
2. Rollover fires on its own once the timeout passes: `rollover_epoch` once `vrf_timeout` passes a
   drawing epoch's request, or once `payout_timeout` passes a drawn epoch. Any signer may call it
   after the timeout, as a backstop if the operator itself is down. That is why the program floors
   both: `vrf_timeout` at 180s and `payout_timeout` at 600s (`constants.rs`), so a stranger cannot
   roll over a merely slow fulfilment.
3. Check ORAO's own status page or Discord for a network-wide outage, and whether other ORAO
   consumers on the same cluster are stuck too. A HexVault-only stall points at the operator or its
   RPC instead, see "Operator or indexer stall" above.
4. Raise `vrf_timeout` if ORAO is consistently slower than the configured value (180s at
   bootstrap, which is also the program's floor, so you can only raise it), so an honest but slow
   draw stops rolling over: `admin set-params --vrf-timeout N`.

## Suspected exploit

Starts with whichever code names the damage, or none if the report comes in first.

1. Pause first, from either key: `pnpm --filter @hexvault/backend admin pause`. It signs locally
   with whichever key the environment has loaded, admin or operator, and stops `deposit` and
   `buy_tickets` on chain. The backend reads the same switch: it refuses new bets and opens no
   Round. `grant-tickets` does not check any pause, because it only books a ledger row for a wallet
   on `OPS_WALLETS`.
2. Assess: compare recent events and vault balances (jackpot vault, principal vault, House Player)
   against what `GET /status`, `GET /rounds/:id/record` and `GET /players/:owner` report, and check
   the backend logs for anything unexpected.
3. Decide the next step:
   - **False alarm, or contained**: `pnpm --filter @hexvault/backend admin unpause` (admin-only,
     goes through Squads on mainnet).
   - **A code fix is needed**: ship it with `scripts/deploy.sh <env> --upgrade`
     ([`docs/ops/deploy.md`](deploy.md#upgrading)).
   - **Funds need to come out for good**: let any already-drawn epoch's `payout` land, then
     `shutdown --confirm <pool-id>`, recall the venue position, `emergency-crank [--batch N]`,
     `sweep-house`, in that order
     ([`docs/ops/funds.md`](funds.md#shutdown-and-the-emergency-exits)). While the pool is
     Impaired, `emergency-crank` fails with `OwnerSignatureRequired`, because each owner must sign
     their own exit at the Haircut value (ADR 0021). Run `cover-deficit` first, or leave the exits
     to the owners.
4. There is no on-call rotation yet (production-hardening ticket 13 sets up the uptime monitor's
   paging target); until it exists, whoever notices the incident runs this playbook and pulls the
   rest of the team in directly. `security.txt`'s `project_url` and `contacts` are still `TODO` in
   `programs/hex_vault/src/lib.rs`; once filled, an outside researcher's report lands on the
   address in that file's `contacts:` line instead.

<a id="operator-sol-low"></a>
## Operator out of SOL

Starts with `OPERATOR_SOL_LOW`.

1. Confirm with `GET /healthz`'s `operatorSol` field: below `OPERATOR_SOL_WARN` (default 0.5 SOL)
   is what triggers the alert.
2. Top up with a plain transfer: `solana transfer <operator-pubkey> 1 --url <cluster>`
   ([`docs/ops/funds.md`](funds.md#operator-sol)).
3. No restart needed. The same hot key just needed more lamports; the next tick's transactions go
   through once the balance lands.

<a id="operator-sol-read-failed"></a>
## Operator SOL balance unreadable

Starts with `OPERATOR_SOL_READ_FAILED`.

1. First check: the RPC used for the balance read, same endpoint as everything else. Check
   `/alerts` for `RPC_DOWN` or `RPC_FALLBACK_ACTIVE` alongside it; a bad RPC read is the usual
   cause, not an actually-empty wallet.
2. If the RPC looks healthy, check the backend logs for the read's own error (a malformed
   `OPERATOR_KEYPAIR`, wrong network). This alert never means "the balance is fine"; it means it
   could not be checked, so treat it as `OPERATOR_SOL_LOW` until it clears.

<a id="operator-failing"></a>
## Operator failing silently

Starts with `OPERATOR_FAILING`.

1. First check: `GET /status`'s `operator.lastError` code and the backend logs for the same tick's
   full error text (the log line the code was derived from). `lastTickAt` is still advancing here,
   which is what separates this from `OPERATOR_STALE`; every tick runs, every one errors.
2. Work the error like "Operator or indexer stall" above once the cause is in hand: an RPC problem, an
   Anchor error naming a bad account or balance, or a bug in the tick itself.
3. A `begin_epoch failed:`, `request_draw failed:`, `draw failed:` or `rollover_epoch failed:` error
   is the signal for a stuck Draw step (a refused VRF request, say). The tick records it and carries
   on, so venue cranks and Pending withdrawals keep flowing while the epoch waits; withdrawals are not
   held by it. The same error on every tick means the Draw step needs a human, so follow
   [Epoch stuck without progress](#epoch-no-progress).

<a id="epoch-no-progress"></a>
<a id="stuck-epoch"></a>
## Epoch stuck without progress

Starts with `EPOCH_NO_PROGRESS`. The console's `STUCK_EPOCH` line belongs here too. It appears once
the program would accept `rollover_epoch`, so step 2 is the Roll over epoch button under Advanced.

1. First check: `GET /epochs/current`'s `status` against `endsAt` and `vrfTimeout`. This fires only once an epoch has run well past the point the self-healing
   rollover should already have moved it on, so treat it as "the backstop itself didn't fire" and
   check the operator logs for why: `OPERATOR_STALE`, a stuck RPC, or a bug in the rollover path.
2. Push it by hand. The exit is permissionless and the program enforces the deadline, so a
   too-early call fails with `VrfTimeoutNotElapsed` and changes nothing:
   `admin rollover-epoch --epoch N` for an Ended, Drawing or Drawn epoch past its timeout. The id
   is in `GET /epochs/current`. The operator rolls over a Drawing or Drawn epoch itself, but never
   an Ended one: it sends that one to the draw with `request_draw`, and an Ended epoch that stays
   stuck means `request_draw` keeps failing, so read the operator's error before giving up the
   draw.

<a id="drawn-unpaid"></a>
## Drawn epoch sitting unpaid

Starts with `DRAWN_UNPAID`.

1. First check: `GET /epochs/current`'s `winner` and `status`. A human winner must never roll over
   quietly; if `payout` keeps failing, check the backend logs for the send error before
   `payout_timeout` passes and a real winner loses their prize to a rollover. If `SNAPSHOT_MISMATCH`
   is also firing, follow [Snapshot proof refused](#snapshot-mismatch).
2. `payout` is permissionless. `GET /epochs/<id>/draw` returns the winner and the proof, so anyone
   can send it if the operator cannot.

<a id="solvency-negative"></a>
## Pool not covering its balances

Starts with `SOLVENCY_NEGATIVE`.

1. First check: `GET /status`'s `solvencyMargin`. It is the vault plus the venue position, as of
   the last sync, less principal, queued withdrawals and everything owed, plus the recorded
   deficit. Under zero by more than a few base units of rounding dust means the pool holds less
   than it owes. Interest earned since the last sync is not in the figure, so a pool that is only
   slightly short may read healthy after the next deposit or harvest syncs it.
2. Check `impaired` in the same response and the logs for an `ImpairedSet` event. A venue loss sets
   `impaired`, which pays exits a haircut; see "Venue loss" below. A negative margin with `impaired`
   off is not expected: treat it as a program bug, `pause` the pool (see "Suspected exploit"
   below) and stop.

<a id="free-idle-low"></a>
<a id="reserve-liquidity-low"></a>
<a id="recall-due"></a>
## Free idle or reserve liquidity running low

Starts with `FREE_IDLE_LOW` or `RESERVE_LIQUIDITY_LOW`. The console's `RECALL_DUE` line is the same
condition seen from the Operator's rules, free idle under the floor. See also "A routine crank is
due" below.

1. `FREE_IDLE_LOW` means free idle (the vault less queued withdrawals) has sat under the idle floor
   for longer than `ALERT_IDLE_LOW_S`. The operator recalls from the venue when it falls under the
   floor, so this fires when that is not happening. Check `GET /status`'s `freeIdle`,
   `freeIdleBps`, `reserveFreeLiquidity` and the operator's `lastError`. A recall the reserve cannot
   pay (`VenueIlliquid`) is the usual cause, and means a refund of a same-day deposit past free idle
   fails (the depositor sees "try again later") until the reserve has liquidity again. Queued
   withdrawals still work and pay once the epoch ends.
2. `RESERVE_LIQUIDITY_LOW` means klend's reserve has less free liquidity than
   `ALERT_RESERVE_FREE_MIN` atomic USDC. The pool's own position can only be recalled as far as the
   reserve can pay, so check `reserveUtilizationBps` and consider `admin pause-deploy` to stop adding
   to a reserve that is running dry.

<a id="pool-impaired"></a>
<a id="deficit-open"></a>
## Venue loss

Starts with `POOL_IMPAIRED`, or the console's `DEFICIT_OPEN` line, which shows whenever the
recorded deficit is above zero. Cover deficit under Advanced pays it down.

1. The venue reported a loss past the tolerance. Deploy and harvest are refused, and exits pay a
   haircut (`GET /pool`'s `live.haircutFactor`). The prize share and the fee owed absorbed the loss
   first. `impaired` clears when later gains or a `cover_deficit` bring the recorded deficit to
   zero.
2. Read `GET /status`'s `solvencyMargin` and the `ImpairedSet` event's `deficit`. Decide with the
   team whether to cover it.
3. While the pool is Impaired it refuses deposits, and `process_withdraw` and `emergency_withdraw`
   need the owner's signature (ADR 0021). The Operator's withdrawal crank skips, so queued
   withdrawals stay queued until the owner pays their own or the deficit clears. Tell depositors
   that waiting costs them nothing and that leaving now pays the Haircut value.

## klend does not respond

Starts with `OPERATOR_FAILING` and an operator `lastError` that names a klend or reserve refresh
failure. There is no code of its own, and `RPC_DOWN` may stay quiet.

1. Every instruction that syncs the venue calls klend to refresh the reserve and value the
   position. If that call fails, the instruction fails. That covers `deposit`, `request_withdraw`,
   `process_withdraw` and `emergency_withdraw`, so no depositor can leave, and harvest, deploy and
   recall fail too. Nothing is lost. The pool's USDC is still at klend and in the vault.
2. Check whether it is klend or the path to it. Read the operator's `lastError` in `GET /status`
   and the backend logs for the failing instruction. Compare `reserveFreeLiquidity` and
   `reserveUtilizationBps` with the previous values, check the reserve in Kamino's own app, and
   test a plain read of the reserve account through a second RPC. A bad RPC is the common cause,
   see "RPC provider down" above.
3. If klend or its oracle is down for real, wait. There is no bypass before a program upgrade, and
   the team accepted that for launch (ADR 0021). `pause` stops new deposits if you want no new
   money in while exits are blocked. Do not `shutdown`. It does not skip the venue call, so it
   would add nothing and could not be undone.
4. Watch the queue. `WITHDRAW_FORECAST_SHORT` may fire because nothing can recall. Withdrawals
   resume on their own once klend answers.
5. If the outage runs for days, the fix is a program upgrade that adds an escape switch, Admin
   only and Shutdown only, under which exits skip the venue call and share the idle USDC pro
   rata. It is not built. Decide on it as a team before any upgrade, and ship it with
   `scripts/deploy.sh <env> --upgrade` ([`docs/ops/deploy.md`](deploy.md#upgrading)).

<a id="venue-lock-elapsed"></a>
## The venue is going bad

No alert code of its own. It starts with news or a signal outside the pool: a klend reserve deprecated or
its utilization near 100%, a Kamino Earn vault whose curator raised fees or set a withdrawal penalty, an
allocation market losing liquidity, or `RESERVE_LIQUIDITY_LOW` that does not clear. `POOL_IMPAIRED` means
the loss already happened, so go to "Venue loss" first. A planned venue switch lands here too: the
console's `VENUE_LOCK_ELAPSED` line means a proposal's 48 hour lock has passed, so the next move is
a drain, or the migration once the position is at the dust line. Both are steps 5 and 6 of the
migration in [`runbook.md`](../../runbook.md), and the venue switch stepper under Advanced marks
which one is next.

1. Decide to park, not to wait. Parking brings the position home and earns nothing, so it fits a venue the
   team no longer trusts, not a bad day.
2. Run the emergency park in [`runbook.md`](../../runbook.md), "Emergency park". It needs no proposal and no
   lock. The Operator key signs it on the box, and the CLI sets the deploy pause in the same transaction
   as the first drain. Keep draining until `venueValue` in `GET /ops/summary` is zero or dust. A klend
   reserve that cannot pay fails with `VenueIlliquid` and moves nothing, so retry in smaller steps.
3. `DEPLOY_PAUSED` will fire for as long as the pause stands. That is expected.
4. Pick the new venue and run the migration in the same runbook section. It waits out a 48 hour lock that
   nobody can shorten, so the idle USDC earns nothing for at least two days. Tell depositors the principal
   is safe in the pool's own vault and that withdrawals still pay.
5. If the old venue recovers, `admin start-deploy` resumes deploys and no proposal is needed.

<a id="deploy-paused"></a>
<a id="deploy-due"></a>
## Deployment paused

Starts with `DEPLOY_PAUSED`. The console's `DEPLOY_DUE` line is the other side of it: idle USDC is
above the target band and nothing has deployed it. If deployment is not paused, see "A routine
crank is due" below.

1. Either key can pause deployment; only the Admin can restart it. The alert holds for as long as
   the pause does, so a deliberate pause keeps paging until it is lifted. Idle USDC above the band
   stays idle and earns nothing, which lowers the rate for everyone.

<a id="ticket-ledger-mismatch"></a>
## Ticket ledger out of step

Starts with `TICKET_LEDGER_MISMATCH`. The indexer's daily check found wallets whose `TicketBalance.tickets`
differs from the sum of their `TicketLedger.delta` rows, or whose ledger Principal (`TicketBalance.principal`)
differs from their `Player` Principal. The snapshot and the draw read the balances, and every reset derives
Tickets from Principal, so a wrong balance can put the wrong count in a leaf.

0. For the Principal term, `GET /ops/summary` lists the first five wallets as `ledgerDrift` with both
   figures. A wallet that deposited seconds before the daily check can show once and clear on the next look;
   one that stays is a lost or doubled event, often a `EVENT_LOG_TRUNCATED` transaction.
1. Find the wallets whose Tickets differ from their rows: `SELECT b.owner, b.tickets, COALESCE(SUM(l.delta), 0) AS ledger FROM "TicketBalance" b
   LEFT JOIN "TicketLedger" l USING ("poolAddress", owner) GROUP BY b.owner, b.tickets
   HAVING b.tickets <> COALESCE(SUM(l.delta), 0)`.
2. Do not edit either table. The ledger is append-only, so a fix is a new row. Read the wallet's rows and
   its `Event` rows in order to see which one the balance missed.
3. An epoch whose snapshot is already committed on chain keeps that snapshot. Fix the wallet before the next
   `EpochBegan`, which snapshots and resets every balance.

<a id="event-log-truncated"></a>
## Transaction log truncated

Starts with `EVENT_LOG_TRUNCATED`. Solana cuts a transaction's log at 10 KB, and the indexer found one
for this pool (the alert names the signature). A big batch of withdrawals plus the venue's own CPI logs can
pass it. The indexer decoded none of that transaction's events and booked nothing to the Ticket ledger. It
did re-read every Pool, Epoch and Player account the transaction touched, so those mirrors are right. The
alert clears itself three days after the indexer recorded it.

1. Read the transaction on an explorer and list the wallets it touched: `SELECT * FROM "TruncatedLog"`
   gives the signatures and slots.
2. The Ticket side is yours. Compare each touched wallet's `TicketBalance.principal` with its `Player`
   Principal (`GET /ops/summary` lists the drifting ones as `ledgerDrift`) and book the difference as a new
   `TicketLedger` row. Do not edit rows.
3. Do it before the next `EpochBegan`, which snapshots and resets every balance from Principal.

<a id="snapshot-near-cap"></a>
## Snapshot near its leaf cap

Starts with `SNAPSHOT_NEAR_CAP`. Wallets holding Tickets are at 90% of `2^MAX_SNAPSHOT_DEPTH` (262,144),
the most leaves a snapshot can hold. Past the cap, the cutoff's `buildSumTree` throws inside the indexer's
`EpochBegan` transaction, the batch rolls back every tick, and `INDEXER_STALE` follows with no draw for
that epoch and no bets booked after it.

1. Count them: `SELECT count(*) FROM "TicketBalance" WHERE "poolAddress" = '<pool>' AND tickets > 0`.
2. The cap is shared with the program (`MAX_SNAPSHOT_DEPTH` in `programs/hex_vault/src/constants.rs`), so
   raising it is a program upgrade plus the backend constant in `apps/backend/src/snapshot/sum-tree.ts`.
   Land it before the next `EpochBegan`.
3. If the cap is already hit, the indexer is stopped at that `EpochBegan`. Nothing is lost: once the raised
   cap deploys, the next tick retries the same batch.

<a id="snapshot-mismatch"></a>
## Snapshot proof refused

Starts with `SNAPSHOT_MISMATCH`. The epoch drew a winner, but the proof the operator built from the stored
`EpochSnapshot` rows does not reach the root the chain holds (`ProofRootMismatch`, `ProofSumMismatch`,
`ProofRangeMismatch` or `ProofWrongLength`), or the rows cannot rebuild the root at all. The operator stops
retrying that epoch. Nobody is paid until the rows are right, and `DRAWN_UNPAID` follows after five minutes.

1. Read the chain's commitment from the Epoch account: `snapshot_root`, `total_tickets`, `snapshot_depth`,
   `leaf_count`. Compare it with `GET /epochs/<id>/snapshot` (root, depth, leaf count, total) and with
   `SELECT count(*), sum(tickets) FROM "EpochSnapshot" WHERE "epochId" = <id>`.
2. Rows missing or different (a restore from an old backup, a hand edit): restore the table from the
   last daily snapshot export, or from the published `GET /epochs/<id>/snapshot` pages, which are the same
   leaves. Rebuild the tree with `buildSumTree` over the restored leaves and check its root equals the
   chain's `snapshot_root` before anything else.
3. Rows match but the chain refuses: the chain's root was committed over different leaves than the rows
   hold. Do not edit the rows to fit. Leave the epoch for `rollover_epoch` once `payout_timeout` passes (the
   prize stays in the vault for the next draw) and find which `EpochBegan` booking diverged.
4. Once the rows rebuild the chain's root, restart the backend (it forgets the stop) or run `payout` by hand
   with the proof from `GET /epochs/<id>/draw`. `payout` is permissionless.

<a id="round-settle-failed"></a>
## A Round cannot settle

Starts with `ROUND_SETTLE_FAILED`, naming the Round ids. The reveal sweep tried to settle or void a
closed Round and its transaction threw. The stakes in that Round stay locked. Later Rounds are not
held back: the sweep skips the failing one and settles the rest. It retries the failing Round every
second, and the alert clears on the first sweep that settles it.

1. The backend logs `Round <id> failed to settle: <error>` once per new error. Read it first.
2. `pot ... does not match its Positions` means `Round.pot` differs from the sum of its Positions'
   tiles times stake. Compare them: `SELECT r.pot, COALESCE(SUM(bit_count(p.tiles::bit(36))::bigint * p."stakePerTile"), 0)
   FROM "Round" r LEFT JOIN "Position" p ON p."poolAddress" = r."poolAddress" AND p."roundId" = r.id
   WHERE r.id = <id> GROUP BY r.pot`. Find which side a hand edit or a failed write left wrong. The void path
   runs the same check, so a beacon that never comes does not get around it.
3. `has no House player` means the indexer has not mirrored the Pool's House Player. Check
   `SELECT owner FROM "Player" WHERE "isHouse"` and `INDEXER_STALE`; the Round settles once the row exists.
4. Anything else is a bug or a database fault. Do not edit the ledger tables to push a Round through.
   Keep the log line and the Round's rows, and fix the cause; the next sweep settles it.

<a id="venue-proposed"></a>
## A venue proposal is open

Starts with `VENUE_PROPOSED`. The message carries the proposed kind, the klend program, market, reserve
and cToken accounts, and the unix time the migration unlocks (48 hours after the proposal).

1. Check the accounts against the venue you meant to move to. The only other readers of this alert are
   the two keys that can propose, so an unexpected one means the Admin key signed something you did not.
2. If it is wrong, run `admin cancel-venue` before the unlock time. The alert ends when the proposal
   account closes, by cancel or by the migration.

<a id="params-changed"></a>
## Pool parameters changed

Starts with `PARAMS_CHANGED`. It stays up for an hour after any `set_params`, with the new values in
the message.

1. Compare the values with the change you made. If you made none, treat it as an Admin key incident:
   run the key-compromise steps above, then set the values back with `admin set-params`.

<a id="sparring-sol-low"></a>
## Sparring player out of SOL

Starts with `SPARRING_SOL_LOW`.

1. First check: the sparring player's balance the same way as the operator's, via
   `SPARRING_KEYPAIR`'s pubkey. Top up with a plain transfer, same as "Operator out of SOL" above;
   a lone human otherwise has no one to play against.

<a id="jackpot-low-near-close"></a>
## Jackpot short before close

Starts with `JACKPOT_LOW_NEAR_CLOSE`.

1. First check: `GET /status`'s `jackpotAmount` against `minJackpot` and `epochEndsAt`. It only
   fires inside the last hour before an epoch closes, so there is a real window to fund the jackpot
   vault (the operator's `harvest` pays the prize share into it) before `request_draw` snapshots it.

<a id="withdraw-forecast-short"></a>
<a id="withdraw-shortfall"></a>
## Withdrawals outrunning vault liquidity

Starts with `WITHDRAW_FORECAST_SHORT`, or `WITHDRAW_SHORTFALL`, which means the vault already fell
short of a pending withdrawal on the last tick.

1. First check: `GET /status`'s `pendingWithdrawals` against `vaultLiquidity`. The operator recalls
   from the venue when the vault is short of what is queued; if it cannot, see "Free idle or
   reserve liquidity running low" above
   ([`docs/ops/funds.md`](funds.md#shutdown-and-the-emergency-exits)).

<a id="harvest-due"></a>
<a id="withdraws-due"></a>
## A routine crank is due

Starts with the console's `HARVEST_DUE` or `WITHDRAWS_DUE` line, or `DEPLOY_DUE` or `RECALL_DUE`
when "Deployment paused" and "Free idle or reserve liquidity running low" above do not fit. These
come from the `todo` list in `GET /ops/summary`, not from `/alerts`.

1. Each one is a crank the Operator sends itself, by the same rules (`decideVenue`, and the
   withdrawal queue for `WITHDRAWS_DUE`). While the Operator is healthy and the condition is newer
   than `ALERT_TICK_STALE_S` (300s by default), the console shows it grey with "the bot will handle
   it on its next tick". Do nothing.
2. The line turns amber when the Operator is stale or failing, or when the condition has held past
   that window. The bot did not do its job. Work `OPERATOR_STALE` or `OPERATOR_FAILING` first
   ("Operator or indexer stall", "Operator failing silently" above).
3. If the Operator will stay down, press the matching button under Routine cranks: Deploy to venue,
   Recall, Harvest or Process withdraw. All four are permissionless, so any wallet with SOL can
   sign. A due todo fills in the amount for Deploy and Recall and the owner for Process withdraw.
   While the pool is Impaired, Process withdraw also needs that owner's signature ("Venue loss"
   above).
4. Harvest is due once the last 10 minutes of the epoch open and no Harvest has landed in them. It
   pays the Yield fee and the prize share, so a missed one leaves the jackpot short
   ("Jackpot short before close" above).

<a id="withdraw-owners-skipped"></a>
## Withdrawal owners skipped

Starts with `WITHDRAW_OWNERS_SKIPPED`.

1. After a failed batch the Operator sends queued withdrawals one at a time. An owner whose send
   fails three times in a row (`WITHDRAW_FAILURE_LIMIT`) is skipped for the rest of that epoch. The
   backend logs `withdrawal to <owner> failed 3 times in a row; skipping`. The count starts clean
   in the next epoch.
2. Read that owner's send error in the backend logs. An Impaired pool is the known cause, because
   `process_withdraw` then needs the owner's own signature ("Venue loss" above). Otherwise look at
   the owner's token account.
3. The skipped owner's withdrawal stays queued and keeps showing as `WITHDRAWS_DUE`. Once the
   cause is fixed, Process withdraw under Routine cranks pays it by hand.
