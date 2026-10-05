# HEXO

A no-loss savings app on Solana with a game bolted on. Deposit USDC, keep your principal, and
earn a fixed Base yield on it. Your Tickets, which a deposit earns from the next day on and which
buying extra with USDC or a referral bonus top up at once, are your odds in the daily draw for the
pool's prize. Between
draws, put Tickets on a 36-tile hex board. When your tile is drawn, the House takes a
configurable cut, 6% by default, and the rest of the pot splits among whoever covered it.
Nothing in the game or the draw can take your principal. The worst round you can have costs
Tickets.

Principal does move, though. The admin lends the vault out during the epoch and brings it
back with the yield that becomes the prize, so withdrawing is a request that pays out after
the epoch it was made in ends. The [Mainnet](#mainnet) section says what that means if you
deposit.

HEXO is the product name. `hex_vault` is the on-chain program, and `@hexvault/*` are the
package names; both stay as they are. The screens say **Tickets**; the code, the API and the
program say **entries**. Same thing. [`CONTEXT.md`](CONTEXT.md) is the arbiter.

![HEXO home screen](docs/images/home.png)

## Try it on devnet

> Devnet prototype. Test assets only. No audit, no legal review, do not deposit real assets.

- App: <https://app.hexofun.lol>
- API: <https://api-hexo.elvtd.io> (`/status` shows whether the operator is cranking)
- Program: `LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6` on devnet

Three steps to a position on the board:

1. **Connect.** Privy is the primary path, so an email or social login gets you an embedded
   wallet with sponsored gas. An external wallet (Phantom, Solflare) works too, but set it to
   devnet and fund it with SOL yourself: `solana airdrop 2 <address> --url devnet`.
2. **Get hexUSDC.** Open the wallet pill in the top right and hit **Get USDC**. The backend
   mints 1000 hexUSDC straight to your associated token account. One grant per wallet per
   hour; the button counts the cooldown down in place. hexUSDC is a test mint the bootstrap
   created, worth nothing.
3. **Deposit, then play.** EARN → Deposit credits equal Principal and Entries, minimum
   1 hexUSDC. PLAY puts those Entries on the board.

### Faucet

![The wallet dropdown with the Get USDC button](docs/images/faucet.png)

That dropdown button is the only faucet UI, but the route behind it is plain HTTP:

```
curl -X POST https://api-hexo.elvtd.io/faucet \
  -H 'content-type: application/json' \
  -d '{"owner":"<your wallet address>"}'
```

It answers `429` with a `retryAfterSeconds` while the wallet is still in cooldown. Grant size
and cooldown are `FAUCET_AMOUNT` and `FAUCET_INTERVAL_SECONDS` on the backend. This is the one
write route in the API, and it runs only where the operator key is also the mint authority of
the accepted mint. On mainnet it answers `404`.

Devnet SOL for gas is a separate problem. The faucet mints hexUSDC only.

## Mainnet

A private beta on real USDC, same binary and same program id as devnet, under a separate
backend stack and a separate Vercel project. There is no audit and no legal review. The
invite list is the only thing standing between the code and someone's money.

What that means if you deposit:

- Your principal is not in the vault for most of the epoch. The admin, a Squads multisig,
  moves it to a lending venue and brings it back before the draw. A venue that fails or a
  return that arrives late is a real way to lose or delay your USDC, and the program cannot
  prevent either.
- Withdrawing takes two transactions. `request_withdraw` deducts your Principal and Entries
  straight away and records a pending amount; the USDC lands after that epoch ends. Anyone
  can push that second transaction, including you from the vault screen, so a stalled
  operator delays nobody.
- The prize is the daily draw's jackpot: yield the admin harvested above the Base yield rate,
  whatever depositors spent on bought tickets, and any sponsor top-up, all funded into the
  jackpot vault by hand. Every depositor also earns a fixed Base yield on their time-weighted
  principal, credited daily out of a separately funded budget; it stops rather than runs a debt
  once that budget is empty. An epoch that closes with less than the pool's `min_jackpot` rolls
  over rather than paying out dust.
- The hot key on the VPS opens rounds, draws and pays out, and does nothing else. It cannot
  change parameters, move principal, or unpause. Either key can pause; only the admin can
  lift it. The game and the jackpot also pause on their own, and a new pool starts with both
  paused until the admin starts them.
- Inviting a friend who deposits and keeps at least 50 USDC in for 7 straight days earns you a
  daily Entries bonus; see [`CONTEXT.md`](CONTEXT.md) for exact tiers. The invite code your
  friend redeems, and every referral tie, is tracked in the app, not the program.
- The admin can shut the pool down for good: deposits, tickets and the game stop, and a
  withdrawal completes in one step instead of two, with no epoch wait. See
  [`docs/ops/funds.md`](docs/ops/funds.md) for what that means operationally.

## Pages

Every screen is one tab of a single-page app, reachable by URL hash. Only EARN and PLAY show
in the navbar; the rest are routable and linked from inside the app.

| Tab | Link | What it is |
| --- | --- | --- |
| HOME | [`/`](https://app.hexofun.lol/) | The landing frame. Today's prize as a whole-dollar hero, a countdown to the draw, one button into the vault. |
| EARN | [`/#earn`](https://app.hexofun.lol/#earn) | The dashboard. Your principal, this epoch's prize and draw clock, your odds, past winners, your own history. Where EARN lands. |
| VAULT | [`/#deposit`](https://app.hexofun.lol/#deposit) | The deposit widget, one hop in from the dashboard's Deposit / Withdraw buttons. A withdrawal is requested here and pays out after the day's draw. |
| PLAY | [`/#play`](https://app.hexofun.lol/#play) | The 36-tile hex board plus the control panel. Stake Entries on tiles (ODD / EVEN / 1-36 cover the board in one click), the round closes, ORAO's VRF picks the tile, and whoever covered it splits the pot after the House takes a configurable cut (6% by default). Auto-rounds repeats the same bet. |
| DAILY DRAW | [`/#draw`](https://app.hexofun.lol/#draw) | The epoch draw: prize, your Weight and odds, past winners. Sends `register` as the permissionless fallback if the operator has not cranked it. |
| LEADERBOARD | [`/#ranks`](https://app.hexofun.lol/#ranks) | Top ten players by Weight in the current epoch, straight from `GET /leaderboard`. Read-only. |
| ABOUT | [`/#about`](https://app.hexofun.lol/#about) | What this is and what can go wrong, stated plainly. |

### EARN

Your principal and Entries on the left, the epoch prize and its countdown on the right, then
your odds, past winners and your own account history.

![The EARN dashboard](docs/images/earn.png)

### VAULT

![The deposit widget](docs/images/vault.png)

### PLAY

Stakes go on tiles while the round is open. At `close_buffer` seconds before the end,
positions close, the operator requests randomness and the stage reads DRAWING until ORAO
answers, so a slow draw shows as a longer DRAWING rather than a timer stuck at zero.

![The hex board mid-draw](docs/images/play.png)

## Read first

- [`CONTEXT.md`](CONTEXT.md): the vocabulary. Use these words and no others.
- [`docs/architecture.md`](docs/architecture.md): components, accounts and PDAs, roles, fund
  flow, the epoch and round lifecycle, and the backend's jobs and read model.
- [`runbook.md`](runbook.md): running it locally day to day.
- [`docs/ops/`](docs/ops/): deploying and upgrading, fund operations, and the dev/staging/mainnet
  environments.
- [`docs/archive/product-requirements.md`](docs/archive/product-requirements.md): what the
  product does (superseded in part; see `docs/adr/`).
- [`docs/plan/rebuild/spec.md`](docs/plan/rebuild/spec.md): program, backend, frontend, infra.
- [`docs/plan/rebuild/issues/`](docs/plan/rebuild/issues/): the ordered build tickets.
- [`docs/plan/mainnet/spec.md`](docs/plan/mainnet/spec.md): the private beta, the withdrawal
  lock, and the admin and operator split.
- [`docs/adr/`](docs/adr/): why the surprising choices were made.

## Run it locally

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres + backend
pnpm --filter @hexvault/web dev                                          # frontend
```

Then <http://localhost:5173>, wallet on devnet. [`runbook.md`](runbook.md) covers the rest:
what to rebuild after each kind of change, the `close_buffer` draw window, and the gotchas
that have already bitten (never build with `--features test-vrf` before a devnet deploy).

## Layout

```
programs/hex_vault/   Anchor program
apps/web/             Vite React frontend (Vercel)
apps/backend/         NestJS + Prisma: indexer, operator, read API (Contabo, docker compose)
tests/                Anchor localnet suite (test-vrf feature)
```

## Agent conventions

See [`AGENTS.md`](AGENTS.md) and `docs/agents/`.
