# 13 Demo smoke test and runbook

Status: superseded: CLI and runbook parts done, the demo run replaced by the staging and mainnet tickets
Type: task
Blocked by: 12

## Goal

Prove the deployed demo does the PRD §9 loop and leave instructions for keeping it alive.

## Scope

- Playwright script `apps/web/e2e/demo.spec.ts` against the Vercel URL with `VITE_BURNER_WALLET` style burner or Privy test mode: faucet → deposit 100 → buy a position on 3 tiles → wait for settle → assert Entries changed and withdrawable shows `min(principal, entries)` → withdraw the matched amount.
- Runbook additions: what to check when the status pill is amber (RPC key exhausted, ORAO stalled → rounds voiding, authority out of SOL, Postgres disk), how to change epoch length for a live demo (`set_params` via a tiny `pnpm --filter backend admin set-params` command), how to top up the authority with SOL and hexUSDC.
- A one-off `admin` command group in the backend for `set-params`, `pause`, `unpause`, `fund-jackpot`, all thin wrappers over `ChainModule`.

## Acceptance

- The Playwright run passes against the live URL.
- A teammate who has not seen the code can follow the runbook to reset the demo pool in under 10 minutes.

## Comments

The admin CLI and the runbook additions are done and verified against a real
localnet pool. The Playwright spec compiles and lists but has never run: ticket
12 has not deployed anything, so there is no live URL, and standing up a full
local stack (validator + program + indexer + operator + api + frontend, all
pointed at each other) was out of scope for this pass. `Status` stays
`blocked` on 12 rather than `resolved`.

Written:

- `apps/backend/src/admin/args.ts` + `args.test.ts`: argument parsing for
  `set-params` (any combination of `--epoch-seconds`, `--round-seconds`,
  `--close-buffer`, `--vrf-timeout`, `--min-deposit`, at least one required),
  `pause`/`unpause` (no flags), `fund-jackpot --amount` (raw atomic hexUSDC).
  Split out of `index.ts` for the same reason `bootstrap/params.ts` is split
  from `bootstrap.ts`: a unit test can import it without a chain call running
  on import.
- `apps/backend/src/admin/index.ts`: the CLI itself. Plain tsx script, no
  command framework, `new ChainService(connection, new ConfigService(env))`
  built directly rather than through a Nest application context, same
  "thin wrapper" shape as `bootstrap.ts`. `import "reflect-metadata"` is
  required at the top; `ChainService`'s `@Injectable()`/`@Inject()`
  decorators need it and there is no `NestFactory` here to pull it in
  implicitly (same reason `operator/localnet.test.ts` has that import).
  Unlike `bootstrap.ts`, this reuses the full validated `.env` (`DATABASE_URL`
  and `CORS_ORIGIN` included, even though this script touches neither) rather
  than duplicating a narrower check: real usage is always against the same
  `.env` the backend itself runs on.
- `apps/backend/package.json`: `"admin": "tsx src/admin/index.ts"`.
- `apps/web/e2e/demo.spec.ts` + `playwright.config.ts`: the PRD §9 loop
  (faucet, deposit 100, buy a position on 3 tiles, wait for settle, assert
  Entries changed and withdrawable is `min(Principal, Entries)`, withdraw the
  matched amount) against real `data-testid`s already landed by ticket 11
  (`deposit-input`, `tile-0..35`, `deploy`, `reward-hint`,
  `settle-position`, `withdraw-input`, and the rest). `E2E_BASE_URL` picks the
  target, defaulting to a local Vite dev server that `webServer` boots only
  when the URL is local; pointing it at Vercel skips that instead of trying
  to launch a dev server against a live site.
- `apps/web/package.json`: `playwright` as a devDependency (pinned to
  `1.62.1`, the version already resolved at the workspace root for the
  root-level scripts) and `"test:e2e": "playwright test"`. The `playwright`
  package itself carries the `playwright/test` runner submodule, so no
  separate `@playwright/test` package was needed.
- `apps/web/vitest.config.ts`: new file, not in the original file-ownership
  list, added because it was needed to keep `pnpm --filter @hexvault/web test`
  passing. Without it vitest's default `include` glob picks up
  `e2e/demo.spec.ts` (matches `**/*.spec.ts`) and crashes trying to run
  Playwright's `test()` under vitest's runner. Merges `vite.config.ts` via
  `mergeConfig` rather than replacing it, so the React plugin and buffer
  alias still apply to `src/**/*.test.ts`; only adds `exclude: [...,
  "e2e/**"]`.
- `docs/plan/rebuild/runbook.md`: four new sections after "Reset the demo",
  in this order: "Admin commands" (the CLI, and the Dockerfile pnpm caveat
  that already applies to `bootstrap` applies here too), "Changing epoch
  length for a live demo", "Topping up the authority with SOL and hexUSDC"
  (SOL via `solana airdrop`, hexUSDC via `spl-token mint` into the
  `AUTHORITY_ATA` bootstrap already prints, including the reverse of ticket
  12's base58-to-JSON keypair one-liner for when only `.env`'s
  `AUTHORITY_KEYPAIR` is on hand), and "Troubleshooting an amber status pill"
  (RPC key exhausted, ORAO stalled/rounds voiding, authority out of SOL,
  Postgres disk, each naming the `/status` field or log line that shows it,
  and the fix).
- This ticket file: `Status` to `blocked`, this section.

Verified:

- `pnpm --filter @hexvault/backend check`: clean.
- `pnpm --filter @hexvault/backend test`: 105 passed, 4 skipped (the two
  localnet files, unchanged from before this ticket, each runs standalone).
  The 8 new tests are `admin/args.test.ts`.
- `pnpm --filter @hexvault/backend build`: `prisma generate && nest build`
  succeeds; `dist/admin/index.js` and `dist/admin/args.js` exist.
- Admin CLI argument handling, without a chain: no subcommand, an unknown
  subcommand, `set-params` with no flags, and `fund-jackpot` with no
  `--amount` all fail fast with the usage string and exit 1, no env or
  network touched. With env set but `RPC_URL` pointed at nothing listening,
  `pause` fails cleanly with `admin: failed to get recent blockhash:
  TypeError: fetch failed` (caught, printed, exit 1) rather than an unhandled
  crash.
- Admin CLI against a real pool: built the program (`test-vrf` build already
  in `target/deploy` from an earlier ticket), started an isolated
  `solana-test-validator` on port 9499, deployed, ran `bootstrap.ts` to
  create pool 1, then ran all four commands for real. `pause`, `unpause` and
  `set-params --epoch-seconds 3600 --round-seconds 30` each returned a
  confirmed signature. Minted 1000 hexUSDC into the authority's ATA with
  `spl-token mint` (this is where the runbook's exact recipe came from: the
  first attempt, with no recipient argument, failed with "Account ... not
  found"; passing the ATA address explicitly is what worked), then
  `fund-jackpot --amount 50000000` returned a confirmed signature and
  `spl-token balance` on the jackpot vault read back exactly `50`. Validator
  torn down after.
- `apps/web`: `npx playwright test --list` and `pnpm --filter @hexvault/web
  test:e2e -- --list` both find the one spec. A standalone `tsc --noEmit`
  over `playwright.config.ts` and `e2e/demo.spec.ts` (apps/web's own
  `tsconfig.json` doesn't include `e2e/`, so this isn't wired into `pnpm
  check`) reports no errors. `pnpm --filter @hexvault/web test` (vitest):
  41 passed, confirming the new `vitest.config.ts` exclude actually fixed the
  collision instead of just hiding it.
- Not run, and not claimed: the demo spec itself, against anything. No
  live URL exists (12), and no local validator + full backend + frontend
  stack was assembled in this pass to run it against localnet either.

Decisions:

- Reused `decodePool` from `../operator/chain-state.ts` in `admin/index.ts`
  rather than writing a second decoder. Did not reuse `OperatorInstructions`
  from `operator/instructions.ts`: its `fundAndClose` bundles minting a
  shortfall, funding, and closing registration into one atomic step for the
  epoch-close flow, not the plain, ad-hoc `fund_jackpot` an admin CLI wants,
  and it has no `set_pause`/`set_params` at all (out of its scope). Copied its
  five-line `method()` cast helper instead of extracting a shared one.
  That module belongs to ticket 07, and factoring out five lines to avoid
  touching it is not a trade worth making.
- `fund-jackpot` does not mint a shortfall the way the operator's automatic
  flow does. `ponytail:` an admin topping up the jackpot by hand is expected
  to already hold hexUSDC (see the runbook's minting recipe); auto-minting
  would silently hide a genuinely-out-of-funds authority. Upgrade path: add a
  `--mint-shortfall` flag if that friction turns out to matter.
- The e2e spec drives the dev burner wallet (`VITE_BURNER_WALLET=1`,
  `src/dev-burner.ts`), not Privy, even though the ticket allows either.
  `ponytail:` the burner is the only path that is actually unattended; a
  Privy run needs Privy's own test-mode login, which is a product decision
  nobody has made yet. Upgrade path: once 12 lands and that decision exists,
  add a `connectPrivyTestWallet()` branch alongside
  `connectBurnerWallet()`.
- The same fixed burner keypair on every run means a second run against the
  same backend can hit the faucet's per-owner rate limit. `ponytail:` the
  spec treats a rate-limited faucet response as non-fatal (any `vault-note`
  text is enough to proceed) rather than fixing repeatability properly.
  Upgrade path: a fresh keypair per run, or a backend reset endpoint, whichever
  ticket ends up owning CI for this spec.

Still blocked on 12, unchanged from that ticket's own comments: no devnet
program deploy, no VPS backend, no Vercel URL. The Playwright acceptance
criterion cannot be met until that lands; when it does, set `E2E_BASE_URL` to
the Vercel URL (or leave it default for a local stack) and run
`pnpm --filter @hexvault/web test:e2e`.
