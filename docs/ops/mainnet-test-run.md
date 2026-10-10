# Test run before mainnet

Five tiers, cheapest first. Each tier gates the next. Written 2026-10-05 at `879bb67` on
`feature/mainnet-contracts`, updated 2026-10-07 at `10542ae` for the venue switch (ADR 0023), the
kVault backing, the Ops console and `cancel_withdraw`, and 2026-10-09 for the off-chain rework
(ADR 0025: Tickets, grants and the game live in the backend). The run log below is history and
still names the retired pieces. Sources: `tests/run-local.sh`,
`tests/fork/run-fork.sh`, `scripts/surf.sh`, `scripts/deploy.sh`, `runbook.md`, `docs/ops/deploy.md`,
`docs/plan/yield-claimer/issues/17-devnet-rehearsal.md`,
`docs/plan/mainnet/issues/08-cutover-devnet-rehearsal-then-mainnet.md`.

| Tier | Chain | Venue | Money | Time |
| --- | --- | --- | --- | --- |
| 1 Rust unit | none | pure functions | none | 1 min |
| 2 Localnet suites | `solana-test-validator` | stub (`test-venue`) | mock hexUSDC | 15 min |
| 3 Mainnet fork | Surfpool | real klend and kVault, forked state | forked USDC | 15 min scripted + build, an afternoon by hand |
| 4 Devnet rehearsal | devnet | real klend on devnet, or stub | devnet USDC | 3 days (3 epochs) |
| 5 Mainnet smoke | mainnet-beta | real klend | ~100 USDC of ours | 2 days |

## Run log

### 2026-10-07 evening, `2cd5833` on `feature/mainnet-contracts`, Tier 3 by hand

Fresh `surf.sh up`, re-running the fork blocks of fork-run-fixes 01 to 06.

| Case | Result |
| --- | --- |
| A2 to A4 (01) | `/players` and `/leaderboard` 200 before `start-jackpot` |
| B (03) | settled yield raises Principal only, Tickets from the next epoch |
| B12 (04) | CLI reports what it sent |
| C13 to C17 (05) | feed and Dashboard list the refunds, requests and cancels |
| E28 (06) | open jackpot 0 between `request_draw` and `payout` |
| 02 | passed on kVault DWSX: harvest lifted epoch 3's jackpot 1 to 7,954 micro |
| I53 | passed: chain time, Principals and venue value unchanged across Ctrl-C and `up --resume`; indexer reconnected in 20 s, operator resumed rounds |

- The klend reserve paid about 4.4%, under the 488 bps base rate, so `prizeOwed` stayed 0. The pool
  moved to kVault `DWSXb18x…KaP` (propose, warp 48 h, drain, migrate, deploy) to test 02.
- First klend deploy panicked at `lending_checks.rs:462`, an incoherent fork snapshot.
  `surfnet_resetAccount` on the reserve and its two neighbours, one `getMultipleAccounts` over all
  three, and a backend restart to clear the 600 s venue cool-down fixed it.
- New tickets: 08 (Earnings shows a fresh deposit as yield), 09 (drop the withdraw sheet's Pending
  row), 10 (web player actions fail on a kVault pool: deposit 3005 `AccountNotEnoughKeys`).
- Epoch 3 rolled over (7,954 < `min_jackpot`), as designed.
- I54 (2026-10-08) failed, two bugs. `shutdown --confirm 1` landed. The operator then sent no
  recall, so the 1,282.95 USDC kVault position stayed out of reach (ticket 11: `decideVenue`
  ignores shutdown, and `funds.md` says the operator recalls). `emergency-crank` failed with 3005
  `AccountNotEnoughKeys`, because it sends no kVault remaining accounts (added to ticket 10).
  `sweep-house` and the `cancel_withdraw` sub-check were not run.
- I54 retest (2026-10-08), same shut-down pool, with 11 and 10's CLI part built. The operator
  recalled 1,282.945366 and then the 0.003702 gain its sync had booked; venue value 0.
  `emergency-crank` paid the admin 1,050.333175 and stopped on burner A with `InsufficientVault`,
  337 micro-USDC short (ticket 12: venue rounding dust beyond `fee_owed` is charged to no one).
  After a 0.001 USDC top-up to the principal vault, it paid burner A 375.149537. `sweep-house`
  moved the jackpot vault to treasury. Wallets rose by principal plus yield: burner A
  4,625 → 5,000.149537, admin 998,950 → 1,000,000.332175 (less the 0.001 top-up). The vault keeps
  663 micro-USDC. The `cancel_withdraw` sub-check was not run.

### 2026-10-08, Tier 3 scripted, all four suites in one `run-fork.sh`

Through the relay (`HEXVAULT_FORK_DATASOURCE=http://127.0.0.1:9402`). 29 of 29 passed in 223 s.

The first try failed 11 tests (timeouts, and `Cannot travel to past timestamp`). `klend.fork.ts`
and `kvault.pool.fork.ts` read time with `getBlockTime`, which Surfpool leaves at the pre-warp
time, so after `venue-switch.fork.ts` moved the clock about 4 days their waits never ended and
their warps aimed at the past. `onChainNowSeconds` in `tests/helpers/hx.ts` now reads the Clock
sysvar, and both suites use it.

### 2026-10-07, `e5a34cc` on `feature/mainnet-contracts`

After the fork-run-fixes (`docs/plan/fork-run-fixes`, tickets 01 to 07, commits `86fcdc5..477cebb`)
and the kVault short-drain test fix (`e5a34cc`).

| Tier | What ran | Result |
| --- | --- | --- |
| 1 | `cargo test -p hex_vault` | 99 passed (at `477cebb`) |
| 2 | `tests/run-local.sh` | 18 files, 232 tests passed (at `477cebb`) |
| 2 | `pnpm --filter @hexvault/backend test` after `test:db` | 869 passed, 5 skipped |
| 2 | `pnpm --filter @hexvault/web exec vitest run` | 39 files, 400 passed |
| 3 | `venue-switch.fork.ts` | 4/4, without the relay |
| 3 | `klend.fork.ts` | 12/12, through the relay |
| 3 | `kvault.fork.ts` | 1/1, through the relay |
| 3 | `kvault.pool.fork.ts` | 12/12 after `e5a34cc`, through the relay |

- The four fork suites passed in separate runs, never all in one. The program did not change between them.
- First full `run-fork.sh` without the relay: 8 of 29 failed on `Failed to fetch accounts from
  remote` (Surfpool's dead pooled connection, surfpool#847) and the timeouts that follow. The URL printed as
  `https://mainnet.helius-rpc.com/<redacted>` every time (ticket 07). Through the relay, none.
- `kvault.pool.fork.ts` "pays short when the vault cannot cover a redeem" failed before `e5a34cc`:
  cutting the vault's idle to 100 USDC lowered its value about 2.6% with today's mainnet idle, over
  the 1% loss tolerance, so the drain's own sync booked a loss the test did not expect. The test now
  syncs once after the cut and allows under 1 USDC of interest between the two syncs.
- Backend, first full run only: "GET /status reports the operator, the cursor age and rpc health"
  failed once, then passed alone, in its file and in a second full run. Looks like a timing flake
  on the 40 to 120 s cursor-age bound; the failure message was not captured.
- CU on kVault user transactions is over the 200,000 default: `request_withdraw` with a refund that
  redeems from the vault 367k, deposit 116k to 140k. The web sets `consumed x 1.1` from simulation
  (`apps/web/src/actions.ts`), so they land. klend user transactions stay under 84k.
- Not run: `test:e2e`, `bootstrap-localnet.sh`, Tier 3 by hand. The fork-run-fixes tickets still
  need their fork blocks re-run: A2 to A4 (01), harvest timing and E27 (02), E28 (06), B12 (04),
  C13 to C17 (05), and block B on a fresh `surf.sh up` for 03, a program change.

## Prerequisites

```sh
solana --version          # Solana CLI, ships solana-test-validator
anchor --version          # 1.x
brew install txtx/taps/surfpool
pnpm install
docker ps                 # for the backend DB tests and the devnet stack
solana-keygen pubkey ~/.config/solana/id.json   # ANCHOR_WALLET default
```

Run everything from the repo root. Never `cd` into a subdir for the scripts.

## Tier 1: Rust unit tests

```sh
cargo test -p hex_vault
```

Expect all green (66 passed on 2026-10-05, 7 of them in `venue::klend::tests`; 99 on 2026-10-07). Covers the
yield index arithmetic, the snapshot proof check (`snapshot.rs`), `check_fresh`, solvency formula.

## Tier 2: localnet suites, stub venue

Builds with `--features test-vrf,test-venue`, boots an isolated validator, deploys, runs the 16
vitest suites in `tests/` (01 to 20, with gaps; 11 covers next-epoch Tickets, 12 `cancel_withdraw`,
17 to 19 the venue switch stub to stub, 20 the snapshot draw). Restores `target/` afterwards.

```sh
tests/run-local.sh                                   # all suites
tests/run-local.sh tests/06-yield.test.ts            # one suite
HEXVAULT_RPC_PORT=8999 tests/run-local.sh            # second run side by side
HEXVAULT_SKIP_BUILD=1 tests/run-local.sh             # reuse the last test build
```

Then the off-chain code:

```sh
pnpm test:unit                                       # backend + web vitest, incl. apps/web/src/ops/*.test.ts
pnpm --filter @hexvault/backend test:db              # Prisma tests, docker postgres on :5433
pnpm --filter @hexvault/web test:e2e                 # playwright, needs a running web + backend (ops.spec.ts needs the localnet stack)
sh apps/backend/scripts/bootstrap-localnet.sh        # bootstrap idempotency, after anchor build with test features
```

What the stub cannot prove: that `klend.rs` matches the deployed Kamino layout, CPI account
ordering, refresh staleness, compute under real reserve sizes. Tier 3 does that.

## Tier 3: Surfpool mainnet fork, real klend

Surfpool forks mainnet lazily (every account a transaction touches is fetched on first use) and
has clock and reset cheatcodes. The suite pins Kamino's mainnet USDC reserve.

```sh
export HEXVAULT_FORK_DATASOURCE='https://mainnet.helius-rpc.com/?api-key=...'   # env only, never a file
tests/fork/run-fork.sh                               # all four suites below
tests/fork/run-fork.sh tests/fork/klend.fork.ts      # one suite
HEXVAULT_SKIP_BUILD=1 tests/fork/run-fork.sh         # reuse target/deploy/hex_vault.so (plain build)
```

The script does a plain `anchor build` (no test features), runs `scripts/check-deployable.sh`,
starts Surfpool on port 9399, deploys, runs the suites in `tests/fork/`, kills Surfpool. The
public RPC works but a keyed one is several times faster. Its output goes through
`scripts/lib/redact.sh`, so a failed fetch prints `<redacted>` in place of the key.

Unlike `surf.sh`, the script does not start `tests/fork/relay.mjs`, and without it Surfpool's dead
pooled datasource connection (surfpool#847) fails whole suites with `Failed to fetch accounts from
remote`. Start the relay by hand and point the script at it:

```sh
node tests/fork/relay.mjs 9402 &                     # reads HEXVAULT_FORK_DATASOURCE
HEXVAULT_FORK_DATASOURCE=http://127.0.0.1:9402 tests/fork/run-fork.sh
kill %1
```

| Suite | Proves |
| --- | --- |
| `klend.fork.ts` | deploy, sync, recall, harvest against Kamino's USDC reserve; pending refund that redeems the gap; `ReserveStale`; deploy caps; wrong pins refused by name |
| `kvault.fork.ts` | spike: the RockawayX RWA USDC vault deposits, values and withdraws |
| `kvault.pool.fork.ts` | a pool pinned to a kVault: bootstrap, pins, deploy, share cap, sync, harvest, recall, refund gap, stale reserves, shutdown recall, liquidity floor, short payout refused |
| `venue-switch.fork.ts` | klend to klend, klend to kVault, emergency park (drain under the deploy pause, no proposal), the 100 USDC dust line leaving interest behind |

Check the output for `CU <label> <units>` lines. Every user transaction must fit the 200,000 CU
default. Compare with the table in `docs/plan/yield-claimer/progress-12.md` and ADR 0023 for the
venue switch.

Fork rules the suites already follow, keep them if you add cases: reset the reserve, its
liquidity vault and the cToken mint back to back before the first deposit (`resetKlend`); move
time only with `surfnet_timeTravel` and `absoluteTimestamp`.

### Long-running fork by hand

`scripts/surf.sh` runs the same fork as a deployment you click through. It deploys the plain
build at `LFk9…`, funds `keys/surf/` roles with forked USDC and SOL, bootstraps Pool 1 on Kamino's
USDC reserve (jackpot, game and buy tickets paused; daily epochs), writes `.env.surf`
and `apps/web/.env.surf`, and stays up until Ctrl-C. `tests/fork/surf.ts` fakes ORAO fulfilment by
rewriting each pending request account, so the daily draw settles with the real binary. Rounds
are not on chain: the backend seeds the Game config on first boot (60 s rounds), runs them on its
own clock, and reads real drand beacons from `api.drand.sh` and `drand.cloudflare.com`, so the
fork host needs internet and `surf.sh warp` does not move them.

The fork reports mainnet's genesis hash, so everything runs with `CLUSTER=mainnet-beta`: no
faucet in the web, fund wallets with `surf.sh fund`. The
web's burner wallet (`VITE_BURNER_WALLET=1`) is a fixed keypair, so fund it once and it stays
funded across reloads.

Walk the list in "What to test" on the fork before devnet. The fork cannot tick: the Squads path,
the Ledger, real ORAO latency and timeouts, `scripts/deploy.sh`, three days of real clock.

```sh
# 1. fork, deploy, bootstrap, fund roles, write envs; stays in the foreground
scripts/surf.sh up                                   # HEXVAULT_FORK_DATASOURCE exported above
scripts/surf.sh up --resume                          # later: keep state and clock across restarts

# 2. backend, operator and postgres against the fork
docker compose -p hexvault-surf --env-file .env.surf -f docker-compose.dev.yml up -d --build
scripts/surf.sh logs backend                         # indexer up, first tick seen
curl -s localhost:8080/healthz; curl -s localhost:8080/status; curl -s localhost:8080/ops/summary

# 3. web with vite --mode surf, on :5173; /ops is the console
scripts/surf.sh web

# 4. launch window first (deposit before start-jackpot), then open the pool
scripts/surf.sh fund <your-wallet-or-burner> 5000 5
scripts/surf.sh admin start-jackpot && scripts/surf.sh admin start-game
scripts/surf.sh admin start-buy-tickets

# 5. time and VRF
scripts/surf.sh warp-epoch 8                         # 8 min before epoch end: harvest window, then draw
scripts/surf.sh warp 3600                            # yield index moves, sync books it
scripts/surf.sh vrf off; scripts/surf.sh vrf on      # VRF timeout, rollover-epoch

# 6. venue switch (runbook "Changing a pool's venue"); the 48 h lock is one warp
scripts/surf.sh admin propose-venue --kind kvault --program ... --market ... --reserve ... --ctoken ...
scripts/surf.sh admin set-venue-params --min-venue-move 10000
scripts/surf.sh warp 172800                          # tick drains, drains again, migrates, deploys
scripts/surf.sh admin cancel-venue                   # the other branch, on a second proposal

# 7. admin and ops paths
scripts/surf.sh admin pause-game | pause-jackpot | pause-deploy | start-deploy | set-params ...
scripts/surf.sh admin grant-tickets --owner <pubkey> --amount N --reason TEXT --keypair keys/surf/admin.json   # off chain; admin pubkey must be in OPS_WALLETS
scripts/surf.sh logs fork|simnet|vrf|relay|backend
```

Admin actions sign with `keys/surf/admin.json`. To click them on `/ops` instead, import that key
into a browser wallet; the Operator pauses come from `keys/surf/operator.json` the same way, and
any other wallet gets the Viewer badge with the cranks.

### Fork run, case by case

The order below runs every fork-tickable line of "What to test" once, in about an afternoon.
Wallets: the web's burner (wallet A, fund it from `surf.sh fund`), `keys/surf/player-b.json`
imported into a browser wallet (wallet B, already funded), `keys/surf/admin.json` and
`keys/surf/operator.json` imported for the Ops console. `admin` below means
`scripts/surf.sh admin`. Read chain state from `curl -s localhost:8080/state`, `/status`,
`/ops/summary` and `/alerts`, and the operator from `scripts/surf.sh logs backend`.

Expect to skip on the fork: venue loss and `cover-deficit` (stub only), `ReserveStale` by hand
(the suite covers it), `payout_timeout` (every wallet here has a token account), the Squads and
Ledger paths, `scripts/deploy.sh`.

**A. Stack up, launch window (section "Launch window")**

1. `scripts/surf.sh up`, compose up, `scripts/surf.sh web`. Open the web, connect the burner, copy
   its address, `scripts/surf.sh fund <burner> 5000 5`.
2. Deposit 1000 from A. Tickets 0, Balance 1000 pending, `/status` has no epoch, no round opens.
3. Deposit 1000 from B. Same.
4. Wait for a tick: idle above the target deploys, `venueValue` > 0, yield index > 0 with no epoch.
5. Skip a grant here. `admin grant-tickets` is not a chain transaction, so the program has nothing
   to refuse, and the backend does not check the jackpot pause either. A pre-launch grant books on
   epoch 0 and the epoch 1 reset takes it back to the Ticket basis, so it proves nothing. Grant
   after step 6. Buy tickets has no UI (hidden in `Vault.tsx` behind `buyTicketsVisible`) and no
   CLI, so its `NoEpochYet` refusal stays covered by `tests/03-epochs.test.ts` only.
6. `admin start-jackpot`. `LAUNCH_AT` is unset on the fork, so `begin_epoch` fires on the next tick. `/state` shows epoch 1
   ending at the next grid point. A and B hold full Tickets with no transaction of their own.
   Add the admin pubkey to `OPS_WALLETS` in `.env.surf` and restart the backend (without it the
   endpoint answers 404). Now `admin grant-tickets --owner <B> --amount 10000000 --reason test
   --keypair keys/surf/admin.json` prints a ledger row id, and B's Tickets in `GET /players/<B>`
   rise by exactly that. One Ticket is one micro-USDC of Principal, so `--amount 10` is 0.00001 USDC
   worth. The row is `grant_admin` with the signer and signature on it, and has no cap.
7. `admin start-game`, `admin start-buy-tickets`. `/state` `gamePaused` and `jackpotPaused` false.

**B. Deposits and balance**

8. Deposit 500 from A during epoch 1. Shows as pending until epoch 2, and the Tickets for it count
   from epoch 2's reset.
9. `scripts/surf.sh warp 3600`. Both balances tick up; after the next sync they match the yield
   index arithmetic to the unit (`/state` vs the screen, within one tick).
10. Buy tickets: skipped on the fork while the UI is hidden (localnet covers credit at full value
    and the pause). `admin pause-buy-tickets` and `admin start-buy-tickets` still flip
    `buyTicketsPaused` in `/state`.
11. `admin set-venue-params --reserve-share-cap-bps 1`. Deposit 2000 from B. The next deploy is
    refused by the cap in the operator log, nothing moves. `admin set-venue-params --reserve-share-cap-bps 500` puts the default back.
12. `admin pause-deploy` (signed by the operator key: set `OPERATOR_KEYPAIR` to the operator and
    run the CLI, or click Pause Deployment on `/ops` as the Operator). Deploys stop,
    `DEPLOY_PAUSED` in `/alerts`. `admin start-deploy` resumes.

**C. Withdrawals and cancel**

13. From A, withdraw 200 of the 500 pending deposit: refunds at once, nothing queued.
14. From A, withdraw 1200: the remaining 300 pending refunds now, 900 queues. The sheet shows both
    amounts; after sending the copy says what happened; account history lists the refund.
15. Pending withdrawal card shows 900 and the epoch it pays. Click Cancel. `/state` shows no
    pending withdrawal, Balance and Tickets unchanged, vault balance unchanged, indexer logged
    `WithdrawCancelled`.
16. Cancel again: refused, nothing queued. From B, try to cancel A's request: refused.
17. From A, request 400, then 500 in the same epoch: one merged request of 900. Cancel once:
    clears all of it.
18. From A, request 900 again. Cancel the withdraw: succeeds. A bet in a Round is a ledger row, not
    an account on chain, so nothing in the program blocks a withdraw or its cancel while a Round is
    open.
19. From B, request more than idle USDC. Operator log shows a recall sized for it; `venueValue`
    drops. Cancel it: the recalled USDC stays idle and the next deploy takes it back out.
20. From B, request 1500 and leave it queued. It stays in the draw (Tickets unchanged) until
    step 28.
21. `admin pause`. Cancel a queued request: succeeds. `admin unpause`.

**D. Rounds and the game**

22. From A, bet on a tile on the board (the first bet opens the Round, and the web signs it with a
    session key after one wallet approval); from B, bet on another. Let the Round close on the
    minute and reveal. The winner's stake comes back whole, the loser's goes to the winner, and the
    House cut books as a `house_credit` ledger row. These are Ticket rows, not token moves, so no
    treasury balance changes. Check it with `node scripts/verify-round.mjs
    http://localhost:8080/rounds/<id>/record`, which prints one `ok` line per step.
23. A void needs a beacon that never arrives, and the fork reads the real drand relays, so skip it
    here. The refund rows are covered by `round-settle.test.ts` and `round-reveal.test.ts`. There is
    no on-chain void to click any more.
24. Forfeit: bet one tile from A and look for a Round whose revealed tile nobody covered. The whole
    pot goes to the House as one `house_credit` row with no cut. The Round's record shows it.
25. `scripts/surf.sh warp-epoch 1`. Try to bet: the backend refuses `RoundOutsideEpoch` when the
    Round's close would fall after the epoch end, and the board says a new round would end after
    the day does. Rounds run on wall time and the epoch end is chain time, so if the warp does not
    trigger it, note that rather than forcing it.
26. `admin pause-game`: board shows "GAME PAUSED", a bet is refused `GamePaused`. `admin start-game`.

**E. Epoch end, harvest, draw**

27. `scripts/surf.sh warp-epoch 8`. Within two ticks: harvest runs once, treasury and jackpot
    vault both receive, `/status` `lastAction` harvest. A second harvest is refused.
28. Warp past the epoch end (`scripts/surf.sh warp 600`). `begin_epoch`, `request_draw`, fake VRF,
    draw, payout, all from the operator. The winner's Principal and Tickets rise at once. A's and
    B's pending deposits from epoch 1 are active. B's queued 1500 from step 20 pays on the first
    `process_withdraw` of epoch 2.
29. `admin set-params --min-jackpot 100000`. Run one more epoch with a warp. Jackpot under the floor
    rolls over, no payout, epoch 3 holds both epochs' yield. Put `--min-jackpot 1` back.
30. `scripts/surf.sh vrf off`, warp to the next epoch end, let `request_draw` fire, warp past the
    draw timeout. `/ops` Advanced shows Roll over epoch lit; click it as a Viewer. `vrf on`.
31. `admin fund-jackpot --amount 50000000` then `/ops` Fund jackpot from wallet B. Both land in the
    jackpot vault.

**F. Operator and alerts**

32. `/healthz` has `operatorSol`. Set `OPERATOR_SOL_WARN=200` in `.env.surf`, restart the backend
    container: `/healthz` degraded, low SOL alert on `/alerts` and red on `/ops`. Put it back.
33. `/status` solvency margin non-negative at every step above.
34. Restart the backend container mid-epoch. Boot guard accepts the pool, indexer catches up, no
    crank sent twice (compare the operator log before and after).
35. Send two chain transactions back to back so they can share a slot (a deposit from A, a
    `request_withdraw` from B). Both are in account history with distinct indexes; a restart
    replays neither.
36. `admin set-params --vrf-timeout 200`, `admin set-venue-params --idle-target-bps ...`,
    `admin set-treasury-accounts --treasury <ta> --buyback-reserve <ta>`: each reads back from the
    Pool and `/ops/summary` on the next poll. Put `--vrf-timeout 180` back. Round length is not a
    Pool field any more; step 41 changes it through the Game config.
37. Priority fee: set `PRIORITY_FEE_MAX_MICROLAMPORTS` low, confirm a tick still lands under it.

**G. Ops console (section "Ops console")**

38. No wallet: page reads, banner colour matches `/alerts`, Details and Advanced collapsed.
39. Admin wallet: badge Admin. Pause and start every switch from the Pause block. Set params and
    Set venue params show the diff before sending.
40. Operator wallet: badge Operator. Pause Pool, Game, Jackpot, Deployment. Bought tickets and
    every start show "Prepare for Squads" with a base58 transaction.
41. Set `OPS_WALLETS=<B>` in `.env.surf`, restart the backend. Wallet B: badge Fast pause signer,
    Fast pause on the four switches signs a message and the pause lands from the operator key.
    Under Advanced, the same wallet can change the Game config (set round seconds to 120; the
    next Round that opens uses it, and `GET /game/config` shows the new row with the signer) and
    Grant Tickets (amount in Tickets, one per micro-USDC; the form shows the stored ledger row).
    Unset it: the page says Fast pause is not enabled on this env, and the backend answers 404 to
    Game config changes and grants too. Put round seconds back to 60.
42. Wallet B otherwise: Viewer. The four routine cranks light only when due (make one due: pause
    deploys from the admin wallet, deposit from A, start deploys, Deploy to venue lights). Click
    each once. Cover deficit says there is none.
43. "Show raw" survives a reload. "Copy JSON" matches `/ops/summary`. Phone width: sections fit,
    the page scrolls.
44. `E2E_BASE_URL=http://127.0.0.1:5173 pnpm --filter @hexvault/web test:e2e e2e/ops.spec.ts`.

**H. Venue switch (section "Venue switch")**

45. Note `venueValue`. Create the pool's shares ATA for the target kVault (runbook step 1).
46. `admin propose-venue --kind kvault ...`. `VenueProposed` in the backend log, `unlocksAt` =
    `proposedAt` + 172800, `venueProposal` on `/ops/summary`, the `/ops` stepper on step 2, Admin
    SOL down by the rent.
47. While proposed: deposit 100 from A, request a withdraw from B, both work; the queued request
    from before is untouched; operator log shows deploys refused `VenueProposalOpen`;
    `venueValue` still grows across a `warp 3600`.
48. `admin migrate-venue`: refused `VenueLockNotElapsed`. `admin propose-venue` again with the same
    pins: lock restarts (new `unlocksAt`). `admin cancel-venue`: `venueProposal` null, rent back,
    next tick deploys.
49. Propose again. `admin set-venue-params --min-venue-move 10000`. `scripts/surf.sh warp 172800`.
    Over three ticks: `VenueDrained` (whole value), `VenueDrained` (accrued), `VenueMigrated` with
    `left_behind` 0, then `VenueDeployed` at the kVault as a v0 transaction. `/ops/summary`
    `venueKind` kvault, `venueValue` rising, the stepper on step 8. The old cToken account holds
    0. Put `--min-venue-move 100000000` back.
50. Hand drain on the new venue: `admin drain-venue --amount 1000000` from the operator key with
    `ADMIN_ADDRESS` unset (a kVault needs v0). `VenueDrained.received` against `asked`,
    `DEPLOY_PAUSED` fires, `admin start-deploy` clears it. With `ADMIN_ADDRESS` set the CLI refuses
    by name.
51. Emergency park: `admin pause-deploy`, drain the whole `venueValue` in steps, USDC idle, no
    proposal. Propose klend (Kamino's USDC reserve pins from bootstrap), warp the lock, migrate from
    the parked state, start deploys.
52. Dust line demo, once: propose, leave `min_venue_move` at the default, warp, migrate. Read
    `left_behind` in `VenueMigrated` and the cToken account's balance. Record the number.

**I. Resume and shutdown drill**

53. Ctrl-C the fork. `scripts/surf.sh up --resume`, compose up. Chain time restored, pool and
    balances intact, the operator picks up at the same epoch.
54. Last, on this pool once everything else is ticked: `admin shutdown --confirm 1`,
    `admin emergency-crank`, `admin sweep-house`. Every depositor's USDC is back in their wallet.
    `cancel_withdraw` on a shut-down pool still succeeds for a request that was queued.

Playwright against the fork is partial. `demo.spec.ts` clicks the faucet, which mainnet-beta hides,
so run only the layout and ops specs with the web already up:

```sh
E2E_BASE_URL=http://127.0.0.1:5173 pnpm --filter @hexvault/web test:e2e e2e/ops.spec.ts e2e/desktop-layout.spec.ts
```

## Tier 4: devnet rehearsal (yield-claimer ticket 17)

This is the first run on a live cluster with real latency, real ORAO VRF and the operator
cranking unattended. One human, three days minimum.

### 4.1 Pick the venue

The live-yield layout rewrite needs a fresh program ID in every environment (see
`docs/ops/environments.md`). Pick one of three venues, in order of preference:

1. **Our own klend market on devnet.** klend is deployed on devnet at the mainnet ID
   `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`. Markets are permissionless; the Kamino Manager
   CLI creates a market and a reserve. We control deposits and borrows, so we control the yield.
   Unverified: the oracle setup for a custom mint. Use Circle's devnet USDC
   `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as the liquidity mint to avoid that question.
2. **An existing devnet USDC reserve.** Four reserves use Circle's devnet USDC. Fastest to pin.
   Unverified: whether anyone borrows there, so whether it pays any yield at all.
3. **Stub venue on devnet.** Build with `--features test-venue` only. Exercises every flow except
   the real CPI. Only acceptable if 1 and 2 both fail, and Tier 3 must be green.

Whichever you pick, the pool's `ACCEPTED_MINT` must equal the reserve's liquidity mint. Options
1 and 2 mean the devnet pool uses Circle USDC, not hexUSDC, so the faucet must mint that or you
fund test wallets from Circle's devnet faucet.

### 4.2 Keys and env

```sh
solana-keygen new -o keys/hex_vault-devnew.json            # fresh program ID (gitignored)
solana-keygen pubkey keys/hex_vault-devnew.json              # paste into declare_id!, Anchor.toml, .env.devnew
solana-keygen new -o keys/operator-devnew.json
solana airdrop 5 <operator-pubkey> --url devnet
cp .env.example .env.devnew                                  # fill RPC_URL, PROGRAM_ID, OPERATOR_KEYPAIR, DATABASE_URL
```

Fill in `.env.devnew`:

```
KLEND_PROGRAM=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
KLEND_MARKET=<market from 4.1>
KLEND_RESERVE=<reserve from 4.1>
KLEND_CTOKEN=<pool PDA's ATA of the reserve's cToken mint>
ACCEPTED_MINT=<reserve liquidity mint>
```

`KLEND_CTOKEN` must exist before the first `deploy_to_venue`. Off mainnet, bootstrap does not
create it. Derive the pool PDA (`["pool", pool_id]` under the new program ID), then:

```sh
spl-token create-account <ctoken-mint> --owner <pool-pda> --fee-payer ~/.config/solana/id.json --url devnet
```

Record the four pins. A second person reads them back from the Pool after bootstrap.

### 4.3 Deploy and bootstrap

```sh
solana program dump <old-program-id> /tmp/rollback.so --url devnet    # rollback for the old ID
scripts/deploy.sh devnew --dry-run                                    # build + check-deployable + keypair assert
scripts/deploy.sh devnew                                              # deploy, sync IDLs
scripts/deploy.sh devnew --idl                                        # publish the on-chain IDL
set -a; . ./.env.devnew; set +a
pnpm --filter @hexvault/backend bootstrap --start \
  --admin <a plain wallet you hold> --operator <operator-pubkey> \
  --epoch-seconds 86400 --min-jackpot 1
```

Bootstrap prints `POOL_ADDRESS`, the vault and Treasury addresses and the four klend pins as the
chain recorded them. Diff the pins against 4.2. Round length is not a bootstrap flag any more. The
backend seeds the Game config (60 s rounds) on first boot, and a wallet on `OPS_WALLETS` changes it
from `/ops`. For a faster rehearsal, bootstrap with `--epoch-seconds 3600` first, run the whole
checklist in hours, then bootstrap a second pool at 86400 for the three-day soak.

### 4.4 Bring up the stack

```sh
docker compose --env-file .env.devnew up -d --build
curl -s localhost:8080/healthz    # rpcOk, operatorSol
curl -s localhost:8080/status     # solvency margin, venue, lastAction
```

Set `VITE_POOL_ID`, `VITE_PROGRAM_ID` on the Vercel preview, redeploy the web app. Set
`OPS_WALLETS` in `.env.devnew` to the team wallets that will use Fast pause, Game config and Grant
Tickets; with it empty the backend answers 404 to all three.

### 4.5 Run the checklist

The full list is in section "What to test" below. Record a progress note at
`docs/plan/yield-claimer/progress-17.md`: program ID, pool ID, slot, date, measured CU and fees
per user transaction, anything that surprised you.

## Tier 5: mainnet smoke

Not before Tier 4 is green for three epochs. Follows the "Mainnet" section of
`docs/plan/mainnet/issues/08-cutover-devnet-rehearsal-then-mainnet.md`, which needs the Squads
signer pubkeys, the mainnet API host and web domain, and the mainnet Helius key.

```sh
scripts/deploy.sh mainnet --dry-run                # solana-verify build, check-deployable, keypair assert
scripts/deploy.sh mainnet                          # hot key stays upgrade authority, typed program ID confirmation
```

Bootstrap Pool 1 next. Its payer is `OPERATOR_KEYPAIR`, which must be the hot key that deployed:
`create_pool` refuses any payer but the upgrade authority (`docs/ops/deploy.md`, "Mainnet launch
order"). Pass `--admin <squads-vault> --operator <hot-key> --treasury <plain token
account> --buyback-reserve <plain token account>`, with `ACCEPTED_MINT=EPjFW...` in the env. On
mainnet, the four klend pins default to Kamino's USDC reserve on the main market and bootstrap
creates the cToken ATA itself. Then hand the upgrade authority to the Ledger and publish the IDL,
which the Ledger signs:

```sh
scripts/deploy.sh mainnet handover                 # Ledger plugged in
scripts/deploy.sh mainnet --idl
scripts/deploy.sh mainnet verify                   # solana-verify, clean tree only
```

Then:

1. Start with ~100 USDC from two wallets we hold. Deposit, wait for the operator to deploy,
   watch `/status` for the venue position and a positive yield index after an hour.
2. Request one withdraw before the epoch ends. Confirm it refunds the pending part now and
   queues the rest. Confirm the queued part pays after the next epoch begins.
3. Let one epoch run end to end: harvest in the last 10 minutes, draw, payout to the winner.
4. Keep the gates on (`VITE_GATE_GAME`, `VITE_GATE_JACKPOT`) until the first draw has paid.
5. Only then open deposits to anyone.

## What to test

Tick every line once on devnet (Tier 4) and the starred ones again on mainnet (Tier 5).

A note in italics says a fork suite already proved the line. The kVault backing lines are ticked
on the suite alone; every other line still needs its devnet tick.

### Deposits and balance

- [ ] * Deposit from wallet A. Balance shows pending.
- [ ] * Deposit from wallet B the same day. Both pending.
- [ ] * After the next epoch begins, both activate. Tickets match the eager model.
- [ ] * After a day, both balances match the yield index arithmetic to the last unit.
- [ ] Deposit on an impaired pool is refused.
- [ ] `buy_tickets` credits tickets at full value and is refused while `pause-buy-tickets` is set.

### Venue (the klend path)

- [ ] * Operator deploys idle USDC above the idle target with no human step. Pool holds cTokens.
- [ ] * `/status` venue value grows between ticks. Yield index rises.
- [ ] * Recall fires when free idle falls under the floor (request a withdraw bigger than idle).
- [ ] * Harvest runs once per epoch in the last 10 minutes. Treasury and jackpot vault both receive.
- [ ] Reserve stale: a crank against an unrefreshed reserve fails with `ReserveStale`, not silently. *(Fork suite green 2026-10-07; still tick on devnet.)*
- [ ] Deploy cap: a deploy that would exceed the reserve's free liquidity is refused. *(Fork suite green 2026-10-07; still tick on devnet.)*
- [ ] Deploy pause: `pause-deploy` from the operator key stops deploys; `start-deploy` from the admin resumes.
- [ ] Venue loss (stub only): drop the rate, pool goes impaired, deposits refuse, `cover-deficit` clears it.
- [ ] Daily withdrawal cap and withdraw queue on the mainnet reserve are not pre-checked by the program. Confirm a recall that hits them fails loudly in the operator log.

### Venue switch (ADR 0023, runbook "Changing a pool's venue")

Fork first: `venue-switch.fork.ts` runs all four by script, then do one by hand through the CLI
and watch the `/ops` Venue switch stepper mark each step.

- [ ] * `propose-venue` with the four pins. `VenueProposed` shows kind, pins, `unlocksAt` exactly 172800 s after `proposedAt`. `/ops/summary` shows `venueProposal`. Rent leaves the admin.
- [ ] * While proposed: deploys refused with `VenueProposalOpen`, the tick takes no action, `venueValue` keeps growing, a deposit and a withdraw request both work, a withdraw queued before the proposal is untouched.
- [ ] A second `propose-venue` replaces the proposal and restarts the lock.
- [ ] `cancel-venue` closes the proposal, rent returns, deploys resume on the next tick, `venueProposal` is null.
- [ ] `migrate-venue` before the lock fails `VenueLockNotElapsed`; with the position above `min_venue_move` fails `VenuePositionNotEmpty`.
- [ ] * `set-venue-params --min-venue-move 10000` before the lock ends. After the lock the tick drains (whole `venueValue`, then what accrued), migrates, deploys, with no manual step. `VenueMigrated.left_behind` is 0 for a klend source.
- [ ] With the default 100 USDC line the migration leaves the interest accrued over the lock untracked at the old venue (known, documented). Confirm the number, do not ship it.
- [ ] `drain-venue --amount N` by hand sets the deploy pause in the same transaction. `DEPLOY_PAUSED` fires, `start-deploy` from the admin clears it.
- [ ] Emergency park: drain under the deploy pause with no proposal, USDC sits idle, then a normal proposal and migration from there. *(Fork suite green 2026-10-07; still tick on devnet.)*
- [ ] klend to kVault: the target's shares ATA for the pool PDA created before the proposal; `propose-venue --kind kvault` checks the pins like `create_pool`. After migration the first deploy is a v0 transaction and `venueValue` is at or under what a redeem returns. *(Fork suite green 2026-10-07; still tick on devnet.)*
- [ ] A kVault source may pay short on a drain. The book falls only by what came back; `left_behind` read before trusting the 10000 line there. *(Fork suite green 2026-10-07; still tick on devnet.)*
- [ ] A drain that klend cannot pay fails `VenueIlliquid` and nothing moves.

### kVault backing (`kvault.pool.fork.ts`, hand check optional)

- [x] Bootstrap pinned to a vault, its shares mint and the pool's shares account. Wrong pins refused by name. *(Fork suite 2026-10-07.)*
- [x] Deploy past the share cap refused before any CPI. Liquidity floor judged on the vault's real liquidity. *(Fork suite 2026-10-07.)*
- [x] Sync, harvest, recall and the refund gap all through the vault. Recall receives at least what was asked. *(Fork suite 2026-10-07.)*
- [x] Shutdown takes the whole position home at no less than the booked value. *(Fork suite 2026-10-07.)*
- [x] Short payout: the caller refuses it by name. *(Fork suite 2026-10-07.)*
- [ ] Operator, backend sends and the Ops console build kVault transactions as v0; the admin CLI refuses `drain-venue` and `migrate-venue` on a kVault pool with `ADMIN_ADDRESS` set or a Ledger loaded.

### Withdrawals

- [ ] * Same-day refund of a pending deposit pays at once.
- [ ] * One withdraw larger than the pending deposit refunds that part now and queues the rest.
- [ ] * The queued part stays in the draw and pays after the next epoch begins.
- [ ] A matured withdraw the vault cannot cover triggers a recall first and lands on the next tick.
- [ ] Haircut exit needs the owner's signature.
- [ ] * `cancel_withdraw` on a queued request clears `pending_withdraw` and the pool's reservation. Principal, Tickets and the vault balance do not move. The indexer decodes `WithdrawCancelled` and `/state` shows no pending withdrawal.
- [ ] `cancel_withdraw` works while paused, shut down and impaired (it moves nothing, so nothing blocks it). It is refused with no request queued, and by anyone but the owner.
- [ ] Two requests in one epoch merge; one cancel clears the merged amount.
- [ ] A request cancelled after a recall was sized for it: the recalled USDC stays idle and the next deploy takes it back out.

### Rounds and the game

Rounds are off chain (ADR 0025), so these are backend checks. The chain sees none of them.

- [ ] A bet through the board opens a Round. At the close, the tile reveals from a drand beacon and the Round settles with a winner. Winner's stake comes back whole.
- [ ] `node scripts/verify-round.mjs <api host>/rounds/<id>/record` passes every step on a settled Round.
- [ ] A voided Round (no beacon within 10 minutes) refunds every bet. Run the verifier with `--relay https://api.drand.sh` on it. *(Not reproducible on the fork; backend tests cover the rows.)*
- [ ] A Round whose tile nobody covered pays the House.
- [ ] A bet whose Round would close after the epoch end is refused `RoundOutsideEpoch`. Board says the round would end after the day.
- [ ] `pause-game` refuses bets (`GamePaused`) and opens no new Round; `start-game` from the admin resumes. A change in the Game config applies from the next Round that opens.

### Epochs and the draw

- [ ] * Draw selects over tickets. `payout` carries the winner's leaf and proof, and the chain checks it against the root `request_draw` committed. Prize pays to the Player whose leaf holds the target.
- [ ] * Winner's Principal and Tickets both rise at once. No registration step anywhere.
- [ ] Epoch under `min_jackpot` rolls over instead of paying dust.
- [ ] `payout` is permissionless: run it from a third wallet.
- [ ] `payout_timeout` path: a winner with no token account is paid after the timeout.
- [ ] `rollover-epoch` takes the ORAO randomness account and succeeds past the timeout.

### Launch window (before epoch 1)

The pool starts jackpot-paused with no Epoch. Deposits are open, the game is not. The first
`begin_epoch` fires at `LAUNCH_AT` once `start-jackpot` has run, and epoch 1 is a stub from then to
the next grid point.

- [ ] * Deposit before `start-jackpot`. Tickets show 0, Balance shows the full amount pending. No round opens, `/status` has no epoch.
- [ ] * Idle above the target deploys to the venue during the window. Yield index rises with no epoch existing.
- [ ] * `buy_tickets` is refused before epoch 1 (`NoEpochYet`). A grant is a ledger row and the chain refuses nothing. One booked before epoch 1 is reset to the Ticket basis at `begin_epoch`, so grant after epoch 1 begins.
- [ ] * `start-jackpot`, then `LAUNCH_AT` passes: `begin_epoch` fires on that tick, not a safety interval later. Epoch 1 ends at the next grid point.
- [ ] * Every pre-launch depositor holds full Tickets in epoch 1 with no transaction of their own (the `begin_epoch` reset books their Principal as Tickets). A deposit made during epoch 1 is pending until epoch 2.
- [ ] * Harvest runs inside epoch 1's last 10 minutes and the window's whole yield lands in the jackpot vault before `request_draw`. Pick `LAUNCH_AT` at least 15 minutes before the grid point, or the stub closes before the harvest window opens and the first prize rolls into epoch 2.
- [ ] * Epoch 1 draws only among pre-launch depositors, pays, and the Prize credits Principal and Tickets at once.
- [ ] If epoch 1's jackpot is under `min_jackpot`, it rolls over and epoch 2 draws with both days' yield. Decide whether to `fund-jackpot` before launch so the first draw pays.
- [ ] No Round opens in the window: the engine waits for epoch 1, and a bet before then is refused.

### Operator and ops

- [ ] * `/healthz` reports `operatorSol` and turns `degraded` under `OPERATOR_SOL_WARN`.
- [ ] * `/status` shows a non-negative solvency margin throughout.
- [ ] * Every alert triggers once on purpose and is seen: stale indexer, failed crank, low SOL, impaired pool.
- [ ] Priority fee cap: a congested tick retries and lands under `PRIORITY_FEE_MAX_MICROLAMPORTS`.
- [ ] Restart the backend mid-epoch. Boot guard accepts the pool, indexer catches up, no double crank.
- [ ] `set-venue-params`, `set-treasury-accounts`, `set-params` from the admin take effect on chain.
- [ ] Squads path: `propose-admin` to a devnet squad, `accept-admin` via base58 import, one `set-params` through Squads. Record the blockhash behaviour.
- [ ] Shutdown drill on a throwaway pool: `shutdown --confirm`, `recall`, `emergency-crank`, `sweep-house`. Every depositor is whole.
- [ ] Indexer keys events on signature and index. Two events in one slot both land; a backend restart replays none twice.
- [ ] Deploy sizing leaves room for the sync's gain: a deploy right after a long sync does not trip the idle floor.

### Ops console (`/ops`, runbook "The Ops console")

- [ ] * Page reads without a wallet. Banner green with nothing due, amber with an action due or a lesser alert, red on any of the nine alerts, grey for a routine crank the Operator will send. Each amber and red line links its playbook and scrolls to its button.
- [ ] * Banner says in amber when the backend could not read the chain.
- [ ] * Badge: Admin, Operator, Fast pause signer (wallet on `OPS_WALLETS`), Viewer. Each sees only its buttons; every disabled button says why.
- [ ] Pause block: Admin signs pause and start; Operator pauses Pool, Game, Jackpot, Deployment and not Bought tickets; Fast pause signs a message and the backend sends with the Operator key; any other wallet gets "Prepare for Squads" with a base58 transaction. Only the Admin restarts, and the confirm box says so.
- [ ] `OPS_WALLETS` unset: the page says Fast pause is not enabled on this env.
- [ ] Routine cranks (Deploy, Recall, Harvest, Process withdraw) lit only when due; each sends and the banner clears on the next poll.
- [ ] Advanced: Set params and Set venue params show each field's change before sending; Game config changes the round length for the next Round and Grant Tickets books a ledger row (both need a wallet on `OPS_WALLETS`); Fund jackpot from the wallet's own USDC; Cover deficit clears Impaired at zero; Roll over epoch says "No stuck epoch" until the timeout.
- [ ] Venue switch stepper marks the current step, shows CLI steps as text, Drain and Migrate as buttons once the chain allows them; a Viewer may Migrate, and Drain while a proposal is open.
- [ ] Headline strip figures match `/ops/summary`; "Show raw" survives reload; "Copy JSON" copies the summary.
- [ ] Phone: operator sections fit, the page scrolls, Details and Advanced collapsed by default.
- [ ] `ops.spec.ts` green against the stack.

### Deploy and upgrade

- [ ] `scripts/deploy.sh <env> --dry-run` passes; `check-deployable.sh` exits 0; `strings hex_vault.so | grep -c test-vrf` prints 0.
- [ ] `scripts/deploy.sh <env> --upgrade` on a pool with live deposits. Accounts still read (`version` and padding).
- [ ] IDL published and `sync-idl` output matches the built IDL.
- [ ] * Upgrade authority is the Ledger (mainnet) or the local key (devnet). No buffers left.

### Web

- [ ] Ticking balance matches `/state` within one tick.
- [ ] Withdraw sheet shows refund-now and queued-until amounts that match the chain, and after sending says what the withdraw did (refunded now, queued, both).
- [ ] Pending withdrawal card shows the queued amount and the epoch it pays; its Cancel button sends `cancel_withdraw` and the card leaves on the next read.
- [ ] Account history lists refunds and cancellations.
- [ ] Feature gates hide the board and prize cards and dim PLAY while set.
- [ ] Referral binding, invite gate, buy tickets preview.
- [ ] Measured CU and fee per user transaction recorded (deposit, withdraw, cancel_withdraw, buy_tickets). A bet is not a chain transaction and has none to record.

### Still open after this run

- Who runs the devnet USDC reserves and whether they pay yield (option 2 in 4.1).
- Oracle setup for a custom mint on our own devnet market (option 1 in 4.1).
- klend's daily withdrawal cap on the mainnet USDC reserve is 90M USDC and the program does not pre-check it.
- `klend-interface` 0.6.0 is one release behind klend's 0.8.0 source. Re-run Tier 3 after any klend upgrade on mainnet.
