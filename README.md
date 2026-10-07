# HEXO

A no-loss savings app on Solana with a game bolted on. Deposit USDC, keep your principal, and
earn a share of what the venue pays on it. Your Tickets, which a deposit earns from the next day on and which
buying extra with USDC or a referral bonus top up at once, are your odds in the daily draw for the
pool's prize. Between
draws, put Tickets on a 36-tile hex board. When your tile is drawn, the House takes a
configurable cut, 6% by default, and the rest of the pot splits among whoever covered it.
Nothing in the game or the draw can take your principal. The worst round you can have costs
Tickets.

Principal does move, though. The program keeps about 10% of the pool idle and lends the rest
to a Kamino klend reserve. Part of a withdrawal, the amount you deposited today, comes back at
once. The rest queues and pays after the next epoch starts. The [Mainnet](#mainnet) section
says what that means if you deposit.

HEXO is the product name. `hex_vault` is the on-chain program, and `@hexvault/*` are the
package names; both stay as they are. The screens say **Tickets**; the code, the API and the
program say **entries**. Same thing. [`GLOSSARY.md`](GLOSSARY.md) is the arbiter.

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
3. **Deposit, then play.** EARN → Deposit credits equal Principal at once, minimum 1 hexUSDC.
   The matching Tickets start with the next epoch, so Bought tickets are the way onto the board
   on day one. PLAY puts your Tickets on the board.

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

- Most of your principal is not in the vault. The program lends everything above a 10% idle
  band to a Kamino klend reserve, and nobody can send pool USDC anywhere else, the admin
  included. A venue loss puts the pool in an Impaired state. Exits then pay a Haircut, deposits
  stop, and a queued withdrawal pays only when you sign for it, so you choose whether to leave
  at the reduced value or wait for a recovery. If klend stops responding, every instruction that
  syncs the venue fails, withdrawals included, until it answers. There is no bypass before a
  program upgrade.
- The venue can change. A pool holds one venue at a time, either a klend reserve or a Kamino Earn
  vault (kVault), and the admin can propose another. The proposal is public on chain and starts a
  48 hour lock that the program enforces, so you have two days to withdraw if you dislike the target.
  Deposits and withdrawals keep working, and the pool keeps earning at the old venue until the lock
  ends. Then anyone can drain the old position into the pool's own vault and run the migration,
  which moves no money. The admin or the operator can also drain to idle at any time to leave a
  venue that is going bad, but moving the money somewhere new always waits out the lock. A vault
  adds a curator who can change its fees without notice, and the team accepts that (ADR 0023).
- Withdrawing is one call, `request_withdraw`. The part up to what you deposited today is
  refunded at once. The rest queues, stays in the draw and the game and keeps earning, and pays
  after the next epoch starts. Anyone can push that payment, including you from the vault
  screen, as long as you have no Position open on the board.
- Yield works as a ceiling and a split. The venue's gain pays the Yield fee first, 10% by
  default. Depositors then get the rest up to `base_rate_bps` as an APR on total principal, credited
  through the Yield index to whoever acts next. Anything above the ceiling is the prize share.
  The Operator harvests the fee and the prize share once per epoch. The prize is the daily
  draw's jackpot, made of that prize share, whatever depositors spent on bought tickets and any
  sponsor top-up. An epoch that closes with less than the pool's `min_jackpot` rolls over
  rather than paying out dust.
- The hot key on the VPS opens rounds, draws and pays out, and does nothing else. It cannot
  change parameters, move principal, or unpause. Either key can pause; only the admin can
  lift it. The game and the jackpot also pause on their own, and a new pool starts with both
  paused until the admin starts them.
- Inviting a friend who deposits and keeps at least 50 USDC in for 7 straight days earns you a
  daily Tickets bonus; see [`GLOSSARY.md`](GLOSSARY.md) for exact tiers. The invite code your
  friend redeems, and every referral tie, is tracked in the app, not the program.
- The admin can shut the pool down for good: deposits, tickets and the game stop, and a
  withdrawal completes in one step, `emergency_withdraw`, with no epoch wait. See
  [`docs/ops/funds.md`](docs/ops/funds.md) for what that means operationally.

## Pages

Every screen is one tab of a single-page app, reachable by URL hash. Only EARN and PLAY show
in the navbar; the rest are routable and linked from inside the app.

| Tab | Link | What it is |
| --- | --- | --- |
| HOME | [`/`](https://app.hexofun.lol/) | The landing frame. Today's prize as a whole-dollar hero, a countdown to the draw, one button into the vault. |
| EARN | [`/#earn`](https://app.hexofun.lol/#earn) | The dashboard. Your principal, this epoch's prize and draw clock, your odds, past winners, your own history. Where EARN lands. |
| VAULT | [`/#deposit`](https://app.hexofun.lol/#deposit) | The deposit widget, one hop in from the dashboard's Deposit / Withdraw buttons. A withdrawal is requested here. Today's deposit refunds at once and the rest pays after the next epoch starts. |
| PLAY | [`/#play`](https://app.hexofun.lol/#play) | The 36-tile hex board plus the control panel. Stake Tickets on tiles (ODD / EVEN / 1-36 cover the board in one click), the round closes, ORAO's VRF picks the tile, and whoever covered it splits the pot after the House takes a configurable cut (6% by default). Auto-rounds repeats the same bet. |
| DAILY DRAW | [`/#draw`](https://app.hexofun.lol/#draw) | The epoch draw: prize, your Tickets and odds, past winners. There is no registration step. The draw selects over the Tickets each Player holds when the epoch ends. |
| LEADERBOARD | [`/#ranks`](https://app.hexofun.lol/#ranks) | Top ten players by Tickets in the current epoch, straight from `GET /leaderboard`. Read-only. |
| ABOUT | [`/#about`](https://app.hexofun.lol/#about) | What this is and what can go wrong, stated plainly. |

### EARN

Your principal and Tickets on the left, the epoch prize and its countdown on the right, then
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

- [`GLOSSARY.md`](GLOSSARY.md): the vocabulary. Use these words and no others.
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
