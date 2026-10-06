# Test run before mainnet

Five tiers, cheapest first. Each tier gates the next. Written 2026-10-05 at `879bb67` on
`feature/mainnet-contracts`. Sources: `tests/run-local.sh`, `tests/fork/run-fork.sh`,
`scripts/deploy.sh`, `docs/ops/deploy.md`, `docs/plan/yield-claimer/issues/17-devnet-rehearsal.md`,
`docs/plan/mainnet/issues/08-cutover-devnet-rehearsal-then-mainnet.md`.

| Tier | Chain | Venue | Money | Time |
| --- | --- | --- | --- | --- |
| 1 Rust unit | none | pure functions | none | 1 min |
| 2 Localnet suites | `solana-test-validator` | stub (`test-venue`) | mock hexUSDC | 15 min |
| 3 Mainnet fork | Surfpool | real klend, forked state | forked USDC | 5 min + build |
| 4 Devnet rehearsal | devnet | real klend on devnet, or stub | devnet USDC | 3 days (3 epochs) |
| 5 Mainnet smoke | mainnet-beta | real klend | ~100 USDC of ours | 2 days |

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

Expect all green (66 passed on 2026-10-05, 7 of them in `venue::klend::tests`). Covers the
yield index arithmetic, Fenwick weight tree, `check_fresh`, solvency formula.

## Tier 2: localnet suites, stub venue

Builds with `--features test-vrf,test-venue`, boots an isolated validator, deploys, runs the 12
vitest suites in `tests/`. Restores `target/` afterwards.

```sh
tests/run-local.sh                                   # all suites
tests/run-local.sh tests/06-yield.test.ts            # one suite
HEXVAULT_RPC_PORT=8999 tests/run-local.sh            # second run side by side
HEXVAULT_SKIP_BUILD=1 tests/run-local.sh             # reuse the last test build
```

Then the off-chain code:

```sh
pnpm test:unit                                       # backend + web vitest
pnpm --filter @hexvault/backend test:db              # Prisma tests, docker postgres on :5433
pnpm --filter @hexvault/web test:e2e                 # playwright, needs a running web + backend
sh apps/backend/scripts/bootstrap-localnet.sh        # bootstrap idempotency, after anchor build with test features
```

What the stub cannot prove: that `klend.rs` matches the deployed Kamino layout, CPI account
ordering, refresh staleness, compute under real reserve sizes. Tier 3 does that.

## Tier 3: Surfpool mainnet fork, real klend

Surfpool forks mainnet lazily (every account a transaction touches is fetched on first use) and
has clock and reset cheatcodes. The suite pins Kamino's mainnet USDC reserve.

```sh
tests/fork/run-fork.sh
# faster, keyed RPC by env only, never in a file:
HEXVAULT_FORK_DATASOURCE=https://mainnet.helius-rpc.com/?api-key=... tests/fork/run-fork.sh
HEXVAULT_SKIP_BUILD=1 tests/fork/run-fork.sh         # reuse target/deploy/hex_vault.so (plain build)
```

The script does a plain `anchor build` (no test features), runs `scripts/check-deployable.sh`,
starts Surfpool on port 9399, deploys, runs `tests/fork/klend.fork.ts`, kills Surfpool. About
25 s after the build.

Check the output for `CU <label> <units>` lines. Every user transaction must fit the 200,000 CU
default. Compare with the table in `docs/plan/yield-claimer/progress-12.md`.

Fork rules the suite already follows, keep them if you add cases: reset the reserve, its
liquidity vault and the cToken mint back to back before the first deposit (`resetKlend`); move
time only with `surfnet_timeTravel` and `absoluteTimestamp`.

### Long-running fork by hand

`scripts/surf.sh` runs the same fork as a deployment you click through. It deploys the plain
build at `LFk9…`, funds `keys/surf/` roles with forked USDC and SOL, bootstraps Pool 1 on Kamino's
USDC reserve (paused, buy tickets off), writes `.env.surf` and `apps/web/.env.surf`, and stays up
until Ctrl-C. `tests/fork/surf.ts` fakes ORAO fulfilment by rewriting each pending request
account, so rounds and draws settle with the real binary.

```sh
HEXVAULT_FORK_DATASOURCE='https://mainnet.helius-rpc.com/?api-key=...' scripts/surf.sh up
docker compose -p hexvault-surf --env-file .env.surf -f docker-compose.dev.yml up -d --build
scripts/surf.sh admin start-jackpot && scripts/surf.sh admin start-game
scripts/surf.sh fund <your-wallet> 5000 5
scripts/surf.sh warp-epoch 8            # land in the harvest window
scripts/surf.sh up --resume             # keep state across restarts, clock included
```

The fork reports mainnet's genesis hash, so everything runs with `CLUSTER=mainnet-beta`. A warp
across a live round voids it.

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
  --epoch-seconds 86400 --round-seconds 90 --min-jackpot 1
```

Bootstrap prints `WEIGHT_TREE` and the four klend pins as the chain recorded them. Diff them
against 4.2. For a faster rehearsal, bootstrap with `--epoch-seconds 3600` first, run the whole
checklist in hours, then bootstrap a second pool at 86400 for the three-day soak.

### 4.4 Bring up the stack

```sh
docker compose --env-file .env.devnew up -d --build
curl -s localhost:8080/healthz    # rpcOk, operatorSol
curl -s localhost:8080/status     # solvency margin, venue, lastAction
```

Set `VITE_POOL_ID`, `VITE_PROGRAM_ID` on the Vercel preview, redeploy the web app.

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
scripts/deploy.sh mainnet                          # Ledger plugged in, typed program ID confirmation
scripts/deploy.sh mainnet --idl
scripts/deploy.sh mainnet verify                   # solana-verify, clean tree only
```

Bootstrap Pool 1 with `--admin <squads-vault> --operator <hot-key> --treasury <plain token
account> --buyback-reserve <plain token account> --accepted-mint EPjFW...`. On mainnet, the four
klend pins default to Kamino's USDC reserve on the main market and bootstrap creates the cToken
ATA itself. Then:

1. Start with ~100 USDC from two wallets we hold. Deposit, wait for the operator to deploy,
   watch `/status` for the venue position and a positive yield index after an hour.
2. Request one withdraw before the epoch ends. Confirm it refunds the pending part now and
   queues the rest. Confirm the queued part pays after the next epoch begins.
3. Let one epoch run end to end: harvest in the last 10 minutes, draw, payout to the winner.
4. Keep the gates on (`VITE_GATE_GAME`, `VITE_GATE_JACKPOT`) until the first draw has paid.
5. Only then open deposits to anyone.

## What to test

Tick every line once on devnet (Tier 4) and the starred ones again on mainnet (Tier 5).

### Deposits and balance

- [ ] * Deposit from wallet A. Weight tree grows by one node. Balance shows pending.
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
- [ ] Reserve stale: a crank against an unrefreshed reserve fails with `ReserveStale`, not silently.
- [ ] Deploy cap: a deploy that would exceed the reserve's free liquidity is refused.
- [ ] Deploy pause: `pause-deploy` from the operator key stops deploys; `start-deploy` from the admin resumes.
- [ ] Venue loss (stub only): drop the rate, pool goes impaired, deposits refuse, `cover-deficit` clears it.
- [ ] Daily withdrawal cap and withdraw queue on the mainnet reserve are not pre-checked by the program. Confirm a recall that hits them fails loudly in the operator log.

### Withdrawals

- [ ] * Same-day refund of a pending deposit pays at once.
- [ ] * One withdraw larger than the pending deposit refunds that part now and queues the rest.
- [ ] * The queued part stays in the draw and pays after the next epoch begins.
- [ ] A matured withdraw the vault cannot cover triggers a recall first and lands on the next tick.
- [ ] Open positions block the queued payout.
- [ ] Haircut exit needs the owner's signature.

### Rounds and the game

- [ ] A round settles with a winner. Winner's stake comes back whole.
- [ ] A voided round refunds.
- [ ] A forfeited round pays the House.
- [ ] `buy_position` that would end after the epoch end is refused. Board says the round is closed.
- [ ] `pause-game` and `start-game` from the admin.

### Epochs and the draw

- [ ] * Draw selects over tickets. Prize pays to the Player whose leaf holds the target.
- [ ] * Winner's Principal and Tickets both rise at once. No registration step anywhere.
- [ ] Epoch under `min_jackpot` rolls over instead of paying dust.
- [ ] `payout` is permissionless: run it from a third wallet.
- [ ] `payout_timeout` path: a winner with no token account is paid after the timeout.
- [ ] `rollover-epoch` and `void-round` take the ORAO randomness account and succeed.

### Launch window (before epoch 1)

The pool starts jackpot-paused with no Epoch. Deposits are open, the game is not. The first
`begin_epoch` fires at `LAUNCH_AT` once `start-jackpot` has run, and epoch 1 is a stub from then to
the next grid point.

- [ ] * Deposit before `start-jackpot`. Tickets show 0, Balance shows the full amount pending. No round opens, `/status` has no epoch.
- [ ] * Idle above the target deploys to the venue during the window. Yield index rises with no epoch existing.
- [ ] * `buy_tickets` and an operator grant are refused before epoch 1 (`NoEpochYet`). An admin grant succeeds.
- [ ] * `start-jackpot`, then `LAUNCH_AT` passes: `begin_epoch` fires on that tick, not a safety interval later. Epoch 1 ends at the next grid point.
- [ ] * Every pre-launch depositor holds full Tickets in epoch 1 with no transaction of their own (the tree reads live Principal). A deposit made during epoch 1 is pending until epoch 2.
- [ ] * Harvest runs inside epoch 1's last 10 minutes and the window's whole yield lands in the jackpot vault before `request_draw`. Pick `LAUNCH_AT` at least 15 minutes before the grid point, or the stub closes before the harvest window opens and the first prize rolls into epoch 2.
- [ ] * Epoch 1 draws only among pre-launch depositors, pays, and the Prize credits Principal and Tickets at once.
- [ ] If epoch 1's jackpot is under `min_jackpot`, it rolls over and epoch 2 draws with both days' yield. Decide whether to `fund-jackpot` before launch so the first draw pays.
- [ ] A round opened in the window (only possible until audit-fixes ticket 08 lands) takes no stake after `begin_epoch` and leaves through `void-round`.

### Operator and ops

- [ ] * `/healthz` reports `operatorSol` and turns `degraded` under `OPERATOR_SOL_WARN`.
- [ ] * `/status` shows a non-negative solvency margin throughout.
- [ ] * Every alert triggers once on purpose and is seen: stale indexer, failed crank, low SOL, impaired pool.
- [ ] Priority fee cap: a congested tick retries and lands under `PRIORITY_FEE_MAX_MICROLAMPORTS`.
- [ ] Restart the backend mid-epoch. Boot guard accepts the pool, indexer catches up, no double crank.
- [ ] `set-venue-params`, `set-treasury-accounts`, `set-params` from the admin take effect on chain.
- [ ] Squads path: `propose-admin` to a devnet squad, `accept-admin` via base58 import, one `set-params` through Squads. Record the blockhash behaviour.
- [ ] Shutdown drill on a throwaway pool: `shutdown --confirm`, `recall`, `emergency-crank`, `sweep-house`. Every depositor is whole.
- [ ] After the drill, `close-weight-tree` (audit-fixes ticket 07) returns the tree's rent to the named account and fails before `total_principal` and `jackpot_reserved` are both zero.

### Deploy and upgrade

- [ ] `scripts/deploy.sh <env> --dry-run` passes; `check-deployable.sh` exits 0; `strings hex_vault.so | grep -c test-vrf` prints 0.
- [ ] `scripts/deploy.sh <env> --upgrade` on a pool with live deposits. Accounts still read (`version` and padding).
- [ ] IDL published and `sync-idl` output matches the built IDL.
- [ ] * Upgrade authority is the Ledger (mainnet) or the local key (devnet). No buffers left.

### Web

- [ ] Ticking balance matches `/state` within one tick.
- [ ] Withdraw sheet shows refund-now and queued-until amounts that match the chain.
- [ ] Feature gates hide the board and prize cards and dim PLAY while set.
- [ ] Referral binding, invite gate, buy tickets preview.
- [ ] Measured CU and fee per user transaction recorded (deposit, withdraw, buy_tickets, buy_position).

### Still open after this run

- Who runs the devnet USDC reserves and whether they pay yield (option 2 in 4.1).
- Oracle setup for a custom mint on our own devnet market (option 1 in 4.1).
- klend's daily withdrawal cap on the mainnet USDC reserve is 90M USDC and the program does not pre-check it.
- `klend-interface` 0.6.0 is one release behind klend's 0.8.0 source. Re-run Tier 3 after any klend upgrade on mainnet.
