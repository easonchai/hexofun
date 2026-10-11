# Mainnet launch, step by step

One page, in order, copy-paste. Every command runs from the repo root on the laptop that holds the
keys unless a step says "on the box". The long version of each step is in
[`deploy.md`](deploy.md), [`environments.md`](environments.md), [`funds.md`](funds.md) and
`runbook.md` ("Mainnet stack", "Launch week"). Hardware wallets and multisigs are out of scope
here; `deploy.md` ("Admin signing", "Moving admin and the upgrade authority to Squads later")
covers moving to them once there is real money in the pool.

## The wallets

Three wallets plus the program keypair you already have.

| Wallet | Job | SOL | Where |
| --- | --- | --- | --- |
| A, deployer | Deploys the program, keeps upgrade rights, pays the pool's creation | 5 | `keys/hexvault-mainnet-deployer.json` on the laptop (`DEPLOY_KEYPAIR`). Never on the box |
| B, operator | Cranks the pool every day | 2 | Base58 secret in `.env.mainnet` on the box (`OPERATOR_KEYPAIR`). The only secret that leaves the laptop |
| C, admin | Owns the Treasury and Buyback accounts, starts and pauses the game, jackpot and bought tickets | 0.1 | Your Phantom (or Backpack, Solflare). Only its address is typed anywhere (`ADMIN_ADDRESS`) |
| Program keypair | Fixes the program ID `EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH` | 0 | `keys/hex_vault-mainnet-keypair.json` (gitignored) and an offline backup |

Team wallets that set the Game config and fast-pause go in `OPS_WALLETS`; C can be one of them.
A and C must differ (bootstrap refuses an admin equal to the signer), and C must differ from B.
Nobody holds a mainnet secret in git, and B never holds upgrade rights.

## 0. Have these before you start

- A Helius mainnet key of its own, plus a second provider for `RPC_FALLBACK_URL`.
- DNS: an A record for the API host pointing at the VPS. The Vercel Production project exists.
- A funded wallet with about 7 SOL. Rent for the 820 KB binary is 4.25 SOL (`solana rent 837328
  -u mainnet-beta`) and stays locked in the program; the deploy instruction refunds the buffer to
  the payer before it creates ProgramData, so that rent is paid once, not twice. The rest of A's 5
  covers pool creation (0.01), three token accounts (0.006) and fees. B's 2 SOL pays crank fees.
- Optional: `solana-verify` installed (`cargo install solana-verify`, needs Docker) for a
  reproducible build. Without it `deploy.sh mainnet` falls back to a plain `anchor build`.
- The mainnet build comes from `main`. Merge first.

## 1. Make A and B, fund A, B and C

`create_pool` only accepts the program's upgrade authority as payer, so A both deploys and creates
the pool; B is only named in that transaction and never signs. One script makes both keys (never a
devnet one), writes A's file into `.env.mainnet` as `DEPLOY_KEYPAIR` (for `deploy.sh` and
bootstrap) and B's base58 secret as `OPERATOR_KEYPAIR` (for the backend), and points the solana
CLI at A:

```bash
scripts/mainnet-keys.sh             # prints both pubkeys and the two transfer commands
solana transfer <A pubkey> 5 --from <your funded wallet> --allow-unfunded-recipient
solana transfer <B pubkey> 2 --from <your funded wallet> --allow-unfunded-recipient
```

Send C 0.1 SOL from any wallet; it pays the fee on each Start and Pause.

To make a wallet you already have A instead: export its private key from the wallet's settings,
then `scripts/mainnet-keys.sh import` and paste it at the prompt. B is still generated fresh. Use
a wallet that holds nothing but this project's SOL, and not C.

Put `keys/hexvault-mainnet-deployer.json`, `keys/hexvault-mainnet-operator.json` and
`keys/hex_vault-mainnet-keypair.json` in the team password manager now. The program keypair is
the only way to get this program ID; after step 5 it is never needed again. A's file is needed for
every later upgrade.

## 2. What to change before the build

- `.env.mainnet` (step 1 created it from the example): fill in `API_HOST`, `POSTGRES_PASSWORD`,
  `RPC_URL`, `RPC_FALLBACK_URL`, `ADMIN_ADDRESS` (C), `OPS_WALLETS` (C and the teammates who will
  use Fast pause and Game config, comma separated), `CORS_ORIGIN`, `INVITE_ADMIN_KEY`
  (`openssl rand -hex 32`). Leave `TREASURY` and `BUYBACK_RESERVE` empty for now (bootstrap
  creates them in step 4) and `SPARRING_KEYPAIR` empty. `PROGRAM_ID`, `CLUSTER`, `POOL_ID=1`,
  `ACCEPTED_MINT` are already right.
- Pick the venue. `create_pool` pins it for good; changing it later is a proposal, a 48 hour lock,
  a drain and a migration (`runbook.md`, "Changing a pool's venue"). Each choice takes one input
  at most; bootstrap derives every other pin (`apps/backend/src/bootstrap/params.ts`,
  `venuePinsFor`) and prints the four `KLEND_*` read-backs at the end:
  - Kamino's USDC lending reserve on the main market: set nothing. On mainnet the program, market,
    reserve and cToken mint are hardcoded, and bootstrap creates the pool's cToken account. Low
    yield on a small pool.
  - A Kamino Earn vault of your choice (the fork rehearsals used
    `DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP`, about 5.2% on 2026-10-09). Find the vault's
    state account on Kamino's site and set:
    ```
    VENUE_KIND=kvault
    KVAULT_ADDRESS=<vault state account>
    ```
    The shares mint is a PDA of the vault and the pool's share account is its ATA of that mint;
    bootstrap creates it. The `KLEND_*` keys are not read for this kind. Rehearse the exact vault
    on the fork first (`KVAULT_ADDRESS=<vault> scripts/surf.sh up`): vaults differ in withdrawal
    penalty, deposit cap and on-chain liquidity. Kamino's Institutional Commodity Yield vault
    (`B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6`, about 7.5% on 2026-10-11) keeps 1 bps plus 1
    unit of every withdraw, which the program books as a deficit at deploy and repays from yield,
    and holds about 2% of its USDC on chain, so a withdrawal beyond the pool's idle plus that
    waits for loan repayments.
  - A different klend reserve: set `KLEND_RESERVE` plus `KLEND_CTOKEN` (the pool PDA's ATA of that
    reserve's cToken mint). Program and market still default.

  Whatever you set here stays in `.env.mainnet` on the box: the backend rebuilds the expected
  pins from the same keys at boot and compares them with the Pool.

Nothing else switches by hand: the `mainnet` cargo feature picks `declare_id!`, `Anchor.toml`
already lists the mainnet ID, and `deploy.sh mainnet` reads `RPC_URL` from `.env.mainnet`.

## 3. Deploy the program

```bash
scripts/deploy.sh mainnet --dry-run     # build, check-deployable, program id check; writes nothing
scripts/deploy.sh mainnet               # type the program id at the prompt
solana program show EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH   # Authority = A
```

A stays upgrade authority.

## 4. Create pool 1

```bash
set -a; . ./.env.mainnet; set +a
pnpm --filter @hexvault/backend bootstrap \
  --epoch-anchor <next Sunday 16:00 UTC, ISO 8601> --epoch-seconds 86400 --min-jackpot 1 > mainnet-pool.env
```

Open a fresh shell for this (a previous `set -a` on another env file leaks values). Bootstrap
signs and pays with A (`DEPLOY_KEYPAIR`), takes the admin from `ADMIN_ADDRESS` (C) and the
operator from `OPERATOR_KEYPAIR` (B); do not pass `--operator` or `--start`. Its log must read
`signer A`, `admin C, operator B`. Bootstrap creates the Treasury and Buyback reserve itself, two
plain USDC accounts owned by C, B's USDC account (a House prize pays into it), then the pool,
which starts with game, jackpot and bought tickets paused. To use one account for both roles (no
token buyback planned, the same-address guard is commented out), pass the same address twice:
`--treasury <addr> --buyback-reserve <addr>`, where `<addr>` is any USDC token account owned by C.

`mainnet-pool.env` holds `POOL_ADDRESS`, the vaults, `TREASURY`, `BUYBACK_RESERVE` and the four
`KLEND_*` pins as the chain recorded them. Paste `TREASURY` and `BUYBACK_RESERVE` into
`.env.mainnet`; the venue keys from step 2 are already there. The backend compares all of them
with the Pool at boot and refuses on any difference. A second person checks the four `KLEND_*`
read-backs against Kamino.

## 5. Publish the IDL, tag

```bash
scripts/deploy.sh mainnet --idl         # signs with A
git tag mainnet-v1 && git push origin mainnet-v1
```

If the repo is public at that commit, `scripts/deploy.sh mainnet verify`. If it stays private,
run `solana-verify get-executable-hash target/deploy/hex_vault.so` and publish the hash.

## 6. Commit what other devs need

Everything public goes in git, every secret stays out. After step 5, one commit on `main`:

| File | What to put |
| --- | --- |
| `apps/web/src/idl/hex_vault.json`, `apps/backend/src/idl/hex_vault.json` | Already rewritten by `deploy.sh` (`sync-idl`). Commit them. Dev and staging builds override the address with `VITE_PROGRAM_ID` / `PROGRAM_ID`, so a mainnet address in the IDL breaks nothing. |
| `docs/ops/environments.md` | Mainnet column: `POOL_ID=1`, `POOL_ADDRESS`, Vercel host. |
| `.env.mainnet.example` | `TREASURY`, `BUYBACK_RESERVE`, `ADMIN_ADDRESS` (all public addresses). |
| `apps/web/.env.mainnet.example` | `VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID=1`. |

Commit `mainnet-pool.env`'s public lines into `environments.md`, not the file itself. Never commit
`.env.mainnet`, `keys/`, or the operator keypair: the `.gitignore` already blocks all three.

## 7. Bring up the stack and the site

Copy the env file over, never through git:

```bash
scp .env.mainnet <user>@<vps>:~/HexVault/.env.mainnet
```

On the box:

```bash
docker compose --env-file .env.mainnet config | head -1      # must print name: hexvault-mainnet
docker compose --env-file .env.mainnet up -d --build
curl -s https://<API_HOST>/status | jq '{rpcOk, lastAction}'
curl -s https://<API_HOST>/healthz | jq .operatorSol        # about 2
curl -s https://<API_HOST>/alerts                            # 200, []
```

Every mainnet compose command carries `--env-file .env.mainnet`, or it hits the devnet stack.

Vercel Production project, Environment Variables, then redeploy (a Vercel var only reaches the
bundle on the next build):

```
VITE_CLUSTER=mainnet-beta
VITE_API_URL=https://<API_HOST>
VITE_PROGRAM_ID=EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH
VITE_POOL_ID=1
VITE_PRIVY_APP_ID=<id>
VITE_GATE_GAME=off
VITE_GATE_JACKPOT=off
```

Then the leaked-key check from `runbook.md`, "Frontend RPC endpoint and checking for a leaked key".

## 8. Open it up

Everything here is a click on the live site's `/ops` page with C connected. The badge in the
header must read `Admin`; C signs each Start itself.

1. Deposit-only first: from any wallet, deposit 1 USDC on the main page, see it pending, refund,
   deposit again.
2. Pause block, Start on Jackpot. When `https://<API_HOST>/state` shows
   `pool.jackpotPaused: false`, remove `VITE_GATE_JACKPOT` on Vercel and redeploy.
3. Advanced, Game config: round seconds, house cut, tiers. A change applies from the next Round.
4. Pause block, Start on Game. When `pool.gamePaused: false`, remove `VITE_GATE_GAME`, redeploy.
5. After the first draw has paid (ADR 0019): Pause block, Start on Bought tickets.

The CLI can do the same (`pnpm --filter @hexvault/backend admin start-jackpot` and friends,
`runbook.md` "Admin actions through Squads"), but with `ADMIN_ADDRESS` set it prints a transaction for a
multisig to import rather than sending, so on this setup the page is the simpler path.

## 9. Spare operator wallet

Make it on launch day so a rotation is a click, not a scramble. The operator holds no user funds,
only fee SOL, so a spare is cheap.

```bash
scripts/mainnet-keys.sh spare       # creates keys/hexvault-mainnet-operator-spare.json, prints the funding and ATA commands and the base58 secret
```

Run the two commands it prints. The USDC ATA must exist before the rotation: `set_operator`
repoints the House Player at the new key, and a House prize pays into that ATA. Store the printed
base58 secret in the password manager next to B's; the script writes nothing to `.env.mainnet` in
spare mode.

To rotate (leaked key, lost laptop, or a planned handoff), `set-operator` is admin-gated and lives
in the CLI, so run it with C's exported secret as the signer, in a fresh shell, and unset
`ADMIN_ADDRESS` so the CLI sends instead of printing:

```bash
set -a; . ./.env.mainnet; set +a
ADMIN_ADDRESS= OPERATOR_KEYPAIR=<C's base58 secret> DATABASE_URL=postgresql://x \
  pnpm --filter @hexvault/backend admin set-operator --key <spare pubkey>
```

Then on the box set `OPERATOR_KEYPAIR` in `.env.mainnet` to the spare's secret and
`docker compose --env-file .env.mainnet up -d --force-recreate backend`. Keep the old key's USDC
ATA open: an already-won House prize still pays there. Sweep its leftover SOL to the new key when
you are sure it is retired.

## Later: upgrades

```bash
solana program dump EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH /tmp/hex_vault-prev.so --url mainnet-beta   # rollback copy
scripts/deploy.sh mainnet --upgrade     # A writes the buffer and signs the deploy
scripts/deploy.sh mainnet --idl         # if the IDL changed
```

Never between a `request_draw` and its `draw`, and never across a layout rewrite
([`environments.md`](environments.md#when-a-new-program-id-is-warranted)). Moving the upgrade
authority to a hardware wallet (`scripts/deploy.sh mainnet handover`) or the admin role to a
multisig are separate, later decisions; the commands are in
[`deploy.md`](deploy.md#moving-admin-and-the-upgrade-authority-to-squads-later).
