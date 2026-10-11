# Fund operations

All commands run through the admin CLI: `pnpm --filter @hexvault/backend admin <command>`, with
the target environment's `.env` exported first (`set -a; . ./.env; set +a`). `DATABASE_URL` must
be set even though these commands touch no database; the CLI validates the backend's full env.
See `apps/backend/src/admin/args.ts` for exact flags, and
[`docs/ops/deploy.md`](deploy.md#admin-signing-local-key-ledger-or-squads) for signing through a
Ledger or a Squads vault (`ADMIN_KEYPAIR` / `ADMIN_ADDRESS`).

## Principal and the venue

Nobody moves principal by hand. The operator deploys idle USDC above the idle target into the
venue, recalls it when free idle falls under the floor, and harvests the Yield fee and the prize
share once per epoch, all through permissionless instructions (`deploy_to_venue`, `recall`,
`harvest`). `admin_withdraw` and `fund_yield` are gone from the program, and so is the Yield
budget. See [`runbook.md`](../../runbook.md), "Venue cranks", for the schedule.

## Funding the prize

The prize is the prize share harvested into the jackpot vault. `fund-jackpot` is still there for
sponsor money; any wallet holding the accepted mint can run it.

```bash
admin fund-jackpot --amount 42069000000   # raw atomic units, 6 decimals
```

`request_draw` snapshots whatever the jackpot vault holds into an epoch's prize (an epoch closing
under `min_jackpot` rolls over instead of paying dust). No daily top-up is needed.

On a `SNAPSHOT_MISMATCH` alert, open the console's Epoch snapshot view first: it hashes the served leaves and shows the root beside the Epoch account's `snapshot_root`, red when they differ.

## A lost snapshot strands the proof

`payout` needs the winner's leaf and a proof, and the only way to build one is the `EpochSnapshot`
rows (plus the Epoch row's root) in Postgres. If the database is lost or rolled back past an
`EpochBegan`, a Drawn epoch cannot be paid until the rows are back. Restore them from the daily
snapshot export (`runbook.md`, "Epoch snapshot export") or from the published
`GET /epochs/<id>/snapshot` pages, check that the rebuilt root equals the Epoch account's
`snapshot_root`, then `payout` (permissionless) with the proof from `GET /epochs/<id>/draw`.
Past `payout_timeout` the epoch rolls over instead and the prize stays in the jackpot vault for the
next draw, so a restore that takes longer than that costs the winner this draw, not the money.

## Operator SOL

The operator's hot key pays every crank transaction's fee. Top it up with a plain transfer:

```bash
solana transfer <operator-pubkey> 1 --url <cluster>
```

`GET /healthz` reports `operatorSol` and turns `degraded` below `OPERATOR_SOL_WARN` (default
0.5 SOL); alert on that field rather than waiting for cranks to start failing.

With Beam on (`BEAM_KEYPAIR`, runbook "Beam"), every operator send also pays a `BEAM_TIP_LAMPORTS` tip, 0.0001 SOL by default, from this wallet.

## SOL costs

Measured 2026-10-09 on a surf fork at `20ba7f1` (program 830,696 B, `opt-level = "s"`). The fork
charges the old 6,960 lamports/byte rent, so rent here is rescaled to mainnet's 5,080 (×0.7299).
Priority fees are not included; the fork charges none.

```
# Deployment
  Deploy program      4.225 SOL  (4.221 is a refundable deposit, ~0.004 in tx fees)
                      the deploy instruction drains the buffer to the payer before it
                      creates ProgramData, so the wallet needs rent once, not twice
                      (checked 2026-10-11 on localnet: 1.3x rent in, deploy landed)
  Create pool         0.009 SOL
  Upgrade (same size) 0.009 SOL  (needs 4.22 SOL on hand, returned after; scaled, not measured)
  Bigger program      +0.05 SOL per extra 10 KB
  Close program       returns 4.221 SOL

# Game
  Per round   0 SOL
    Rounds run in the backend and bets are signed off-chain by the session key (ADR 0025).
    Randomness comes from drand, not ORAO.

# Jackpot  (1 draw/day)
  Per draw    0.0036 SOL
    VRF         0.0018462  (0.0005 ORAO fee + 0.0013462 locked forever)
    Epoch acct  0.00174    (never refunded)
    Tx fees     0.000025   (5 txs: begin_epoch, request_draw, draw, payout, harvest)
  Empty epoch 0.00175 SOL  (no Tickets: request_draw rolls it over without VRF)
  Per 30 days 0.11 SOL

# Players  (paid by the player)
  First deposit     0.00154 SOL  (Player account, never refunded)
  Bet               0 SOL
  Deposit/withdraw  0.000005 SOL tx fee
```

To re-measure, run a fork (`scripts/surf.sh up`), drive it, then group the rows of
`.surf/state.sqlite` table `transactions` by their `Program log: Instruction:` lines and read the
fee payer's balance change. Rescale rent by 5,080 / 6,960.

## Shutdown and the emergency exits

`shutdown` is admin-only and irreversible: it stops every inflow, the game and the draw, and lets
withdrawals skip the epoch lock (`Pool.shutdown = true`, modelled on Marginfi/Kamino
`ReduceOnly`). Run it only when the pool is being wound down for good.

```bash
admin shutdown --confirm <pool-id>          # pool-id must equal the configured pool, or nothing sends
admin emergency-crank --batch 5             # permissionless; pays every Player still owed a balance
admin sweep-house                           # admin-only; jackpot surplus to treasury
```

Run these in this order, and only after every winner who can still be paid has been:

1. **Let any already-drawn epoch pay out first.** `payout` of an epoch already in `Drawn` status
   is still allowed after shutdown (an epoch that has not drawn yet can never reach `Drawn`
   post-shutdown, since `draw` is refused). `sweep_house` only ever sweeps the jackpot vault's
   balance above `pool.jackpot_reserved`, precisely so it cannot stall a winner who has not
   claimed yet, but running `payout` before you sweep is still the safer order.
2. **`shutdown --confirm <pool-id>`.**
3. **Recall the venue position.** After shutdown `recall` has no limit and is permissionless; the
   operator sends it, and anyone can. Anything still deployed is money `emergency-crank` and
   `sweep-house` cannot reach, so recall it first. The venue keeps a little of every move
   (a kVault keeps about 0.001 USDC per withdraw). The program books that as deficit and
   `shutdown` makes exits pro rata, so the last depositor is paid a hair under par and no
   principal-vault top-up is needed.
4. **`emergency-crank [--batch N]`.** Permissionless: lists every Player (House excluded) with
   `principal > 0` (a queued withdrawal is inside Principal) read straight off the chain (not the indexer, so it works
   even if Postgres is behind), creates each owner's associated token account if missing, and
   pays `emergency_withdraw` in batches of `N` (default 5). Stops at the first `InsufficientVault`
   and reports paid, skipped and the shortfall; safe to re-run.
5. **`sweep-house`.** Moves the jackpot vault's balance above `jackpot_reserved` to
   `pool.treasury`. Never touches principal; safe to run more than once (a later `fund_jackpot`
   can be swept again).

The House never receives an `emergency_withdraw`; its principal is protocol money and only ever
leaves through `sweep_house`.
