# Incident playbooks

`GET /alerts` is what pages a human: 200 with an empty list when things are fine, 503 with the
active codes otherwise (production-hardening ticket 05). Each playbook below opens with the code
that usually starts it. Admin commands run through the CLI,
`pnpm --filter @hexvault/backend admin <command>`, with the target environment's `.env` exported
first; see [`docs/ops/funds.md`](funds.md) for the full convention and signing through a Ledger or
Squads.

## Chain stall mid-round

Starts with `OPERATOR_STALE`, sometimes alongside `INDEXER_STALE`.

1. Check `GET /status`: `operator.lastAction` and `operator.lastTickAt` for the operator,
   `cursor.ageSeconds` for the indexer.
2. The operator sleeps until the next chain-clock deadline, a round's `close_buffer`, a request's
   `vrf_timeout`, an epoch's `payout_timeout`, and works through one epoch and one round at a time:
   `begin_epoch`, `request_draw`, `draw`, `payout`, and `create_round`, then
   `settle_round` or `void_round`, with `deploy_to_venue`, `recall` and `harvest` between them as the
   pool's liquidity needs. A 60s safety tick is the backstop if a deadline is missed.
   Waiting on a deadline is not a stall by itself, as long as `lastTickAt` keeps advancing.
3. A round whose randomness never arrives voids itself once `vrf_timeout` passes its request; an
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
   It stops `create_round` and `buy_position` and leaves deposits and the daily draw alone; an
   already-open round still plays out to settlement. The pool-wide `pause` (see "Suspected
   exploit" below) stops `create_round`, `deposit` and `buy_tickets`. `pause-jackpot` holds the
   next epoch and the draw.
7. Players see the countdown end at `close_buffer` and the stage read DRAWING until settle lands
   ([`runbook.md`](../../runbook.md)). A real stall shows as DRAWING, or "no open round", staying
   that way well past the usual few seconds.

## RPC provider down

Starts with `RPC_DOWN` or `RPC_FALLBACK_ACTIVE`.

1. `RPC_FALLBACK_ACTIVE` means the fallback is already serving: a timeout, 5xx or 429 from the
   primary sends that one call to `RPC_FALLBACK_URL`, and the next call tries the primary again
   (production-hardening ticket 03). Check `GET /status`'s `rpcEndpoint` (`"primary"` or
   `"fallback"`) and `rpcFallbackAt`.
2. If `RPC_FALLBACK_URL` is set and rounds and draws are still landing (`operator.lastAction`
   recent, `openRoundId` advancing), no action is needed beyond watching it.
3. `RPC_DOWN` without a working fallback needs a new endpoint. Set `RPC_URL` (and
   `RPC_FALLBACK_URL`, if a second provider is available) in the environment's env file, then
   recreate the backend so it picks up the change: `docker compose -f docker-compose.dev.yml up -d
   --force-recreate backend` (swap the compose file and add `--env-file .env.mainnet` on mainnet,
   see [`docs/ops/environments.md`](environments.md)).
4. Rotate the web's public RPC the same way: set `VITE_PUBLIC_RPC_URL` on the affected Vercel
   project to a working public endpoint and redeploy, a Vercel env var only reaches the bundle on
   the next build. Never put a keyed URL there; it ships to every visitor
   ([`runbook.md`](../../runbook.md), "Frontend RPC endpoint").

## VRF not fulfilling

Starts with `ROUND_VOIDED_RECENTLY` or `EPOCH_ROLLED_OVER_RECENTLY`.

1. Confirm it is ORAO and not the operator: check the backend logs for a sent
   `request_round_randomness` or `draw` with a confirmed signature and no matching settle, and
   check `GET /status` / `GET /epochs/current` for a round or epoch parked past its `vrf_timeout`.
2. Void and rollover fire on their own once the timeout passes: `void_round` once `vrf_timeout`
   passes a round's or a drawing epoch's request, `rollover_epoch` once `payout_timeout` passes a
   drawn epoch. Any signer may call either one after the timeout, as a backstop if the operator
   itself is down. That is why the program floors both: `vrf_timeout` at 60s and `payout_timeout`
   at 600s (`constants.rs`), so a stranger cannot void a merely slow fulfilment.
3. Check ORAO's own status page or Discord for a network-wide outage, and whether other ORAO
   consumers on the same cluster are stuck too. A HexVault-only stall points at the operator or its
   RPC instead, see "Chain stall mid-round" above.
4. Raise `vrf_timeout` if ORAO is consistently slower than the configured value (120s at
   bootstrap), so an honest but slow draw stops voiding: `admin set-params --vrf-timeout N`.

## Suspected exploit

Starts with whichever code names the damage, or none if the report comes in first.

1. Pause first, from either key: `pnpm --filter @hexvault/backend admin pause`. It signs locally
   with whichever key the environment has loaded, admin or operator, and stops `create_round`,
   `deposit` and `buy_tickets`. An already-open round still takes `buy_position`, and
   `grant_tickets` still mints, until production-hardening ticket 02 lands.
2. Assess: compare recent events and vault balances (jackpot vault, principal vault, House Player)
   against what `GET /status`, `GET /rounds/:id` and `GET /players/:owner` report, and check the
   backend logs for anything unexpected.
3. Decide the next step:
   - **False alarm, or contained**: `pnpm --filter @hexvault/backend admin unpause` (admin-only,
     goes through Squads on mainnet).
   - **A code fix is needed**: ship it with `scripts/deploy.sh <env> --upgrade`
     ([`docs/ops/deploy.md`](deploy.md#upgrading)). Run it only once no Round is open
     (`GET /status`'s `openRoundId`).
   - **Funds need to come out for good**: let any already-drawn epoch's `payout` land, then
     `shutdown --confirm <pool-id>`, recall the venue position, `emergency-crank [--batch N]`,
     `sweep-house`, in that order
     ([`docs/ops/funds.md`](funds.md#shutdown-and-the-emergency-exits)).
4. There is no on-call rotation yet (production-hardening ticket 13 sets up the uptime monitor's
   paging target); until it exists, whoever notices the incident runs this playbook and pulls the
   rest of the team in directly. `security.txt`'s `project_url` and `contacts` are still `TODO` in
   `programs/hex_vault/src/lib.rs`; once filled, an outside researcher's report lands on the
   address in that file's `contacts:` line instead.

## Operator out of SOL

Starts with `OPERATOR_SOL_LOW`.

1. Confirm with `GET /healthz`'s `operatorSol` field: below `OPERATOR_SOL_WARN` (default 0.5 SOL)
   is what triggers the alert.
2. Top up with a plain transfer: `solana transfer <operator-pubkey> 1 --url <cluster>`
   ([`docs/ops/funds.md`](funds.md#operator-sol)).
3. No restart needed. The same hot key just needed more lamports; the next tick's transactions go
   through once the balance lands.

## Operator SOL balance unreadable

Starts with `OPERATOR_SOL_READ_FAILED`.

1. First check: the RPC used for the balance read, same endpoint as everything else. Check
   `/alerts` for `RPC_DOWN` or `RPC_FALLBACK_ACTIVE` alongside it; a bad RPC read is the usual
   cause, not an actually-empty wallet.
2. If the RPC looks healthy, check the backend logs for the read's own error (a malformed
   `OPERATOR_KEYPAIR`, wrong network). This alert never means "the balance is fine"; it means it
   could not be checked, so treat it as `OPERATOR_SOL_LOW` until it clears.

## Operator failing silently

Starts with `OPERATOR_FAILING`.

1. First check: `GET /status`'s `operator.lastError` code and the backend logs for the same tick's
   full error text (the log line the code was derived from). `lastTickAt` is still advancing here,
   which is what separates this from `OPERATOR_STALE`; every tick runs, every one errors.
2. Work the error like "Chain stall mid-round" above once the cause is in hand: an RPC problem, an
   Anchor error naming a bad account or balance, or a bug in the tick itself.

## Epoch stuck without progress

Starts with `EPOCH_NO_PROGRESS`.

1. First check: `GET /epochs/current`'s `status` against `endsAt` and `vrfTimeout`. This fires only once an epoch has run well past the point every self-healing
   timeout (void, rollover) should already have moved it on, so treat it as "the backstop itself
   didn't fire" and check the operator logs for why: `OPERATOR_STALE`, a stuck RPC, or a bug in the
   void/rollover path.
2. Push it by hand. Both exits are permissionless and the program enforces the deadline, so a
   too-early call fails with `VrfTimeoutNotElapsed` and changes nothing:
   `admin rollover-epoch --epoch N` for an Ended, Drawing or Drawn epoch past its timeout,
   `admin void-round --round N` for an Open or Requested round past `vrf_timeout`. Ids are in
   `GET /epochs/current` and `GET /status`. The operator voids a round itself, Open or Requested,
   and rolls over a Drawing or Drawn epoch, but never an Ended one: it sends that one to the draw
   with `request_draw`, and an Ended epoch that stays stuck means `request_draw` keeps failing, so
   read the operator's error before giving up the draw.

## Drawn epoch sitting unpaid

Starts with `DRAWN_UNPAID`.

1. First check: `GET /epochs/current`'s `winner` and `status`. A human winner must never roll over
   quietly; if `payout` keeps failing, check the backend logs for the send error before
   `payout_timeout` passes and a real winner loses their prize to a rollover.

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

## Free idle or reserve liquidity running low

Starts with `FREE_IDLE_LOW` or `RESERVE_LIQUIDITY_LOW`.

1. `FREE_IDLE_LOW` means free idle (the vault less queued withdrawals) has sat under the idle floor
   for longer than `ALERT_IDLE_LOW_S`. The operator recalls from the venue when it falls under the
   floor, so this fires when that is not happening. Check `GET /status`'s `freeIdle`,
   `freeIdleBps`, `reserveFreeLiquidity` and the operator's `lastError`. A recall the reserve cannot
   pay (`VenueIlliquid`) is the usual cause, and means instant withdrawals past free idle will fail
   until the reserve has liquidity again; queued withdrawals still work.
2. `RESERVE_LIQUIDITY_LOW` means klend's reserve has less free liquidity than
   `ALERT_RESERVE_FREE_MIN` atomic USDC. The pool's own position can only be recalled as far as the
   reserve can pay, so check `reserveUtilizationBps` and consider `admin pause-deploy` to stop adding
   to a reserve that is running dry.

## Venue loss

Starts with `POOL_IMPAIRED`.

1. The venue reported a loss past the tolerance. Deploy and harvest are refused, and exits pay a
   haircut (`GET /pool`'s `live.haircutFactor`). The prize share and the fee owed absorbed the loss
   first. `impaired` clears when later gains or a `cover_deficit` bring the recorded deficit to
   zero.
2. Read `GET /status`'s `solvencyMargin` and the `ImpairedSet` event's `deficit`. Decide with the
   team whether to cover it.

## Deployment paused

Starts with `DEPLOY_PAUSED`.

1. Either key can pause deployment; only the Admin can restart it. The alert holds for as long as
   the pause does, so a deliberate pause keeps paging until it is lifted. Idle USDC above the band
   stays idle and earns nothing, which lowers the rate for everyone.

## Weight tree filling up

Starts with `WEIGHT_TREE_NEARLY_FULL`.

1. `GET /status`'s `treeNodeCount` against `treeCapacity` (145,634 Players). Past the capacity
   deposits from a new wallet fail with `WeightTreeFull`. A second tree is out of scope for the
   current program, so this needs a design decision well before the last leaf is taken.

## Sparring player out of SOL

Starts with `SPARRING_SOL_LOW`.

1. First check: the sparring player's balance the same way as the operator's, via
   `SPARRING_KEYPAIR`'s pubkey. Top up with a plain transfer, same as "Operator out of SOL" above;
   a lone human otherwise has no one to play against.

## Jackpot short before close

Starts with `JACKPOT_LOW_NEAR_CLOSE`.

1. First check: `GET /status`'s `jackpotAmount` against `minJackpot` and `epochEndsAt`. It only
   fires inside the last hour before an epoch closes, so there is a real window to fund the jackpot
   vault (the operator's `harvest` pays the prize share into it) before `request_draw` snapshots it.

## Withdrawals outrunning vault liquidity

Starts with `WITHDRAW_FORECAST_SHORT`.

1. First check: `GET /status`'s `pendingWithdrawals` against `vaultLiquidity`. The operator recalls
   from the venue when the vault is short of what is queued; if it cannot, see "Free idle or
   reserve liquidity running low" above
   ([`docs/ops/funds.md`](funds.md#shutdown-and-the-emergency-exits)).
