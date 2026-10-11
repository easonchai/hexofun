# Mainnet launch, step by step

One page, in order, copy-paste. Every command runs from the repo root on the laptop that holds the
keys unless a step says "on the box". The long version of each step is in
[`deploy.md`](deploy.md), [`environments.md`](environments.md), [`funds.md`](funds.md) and
`runbook.md` ("Mainnet stack", "Launch week"); `docs/plan/mainnet/issues/08-...md` is the
checklist this page was condensed from.

Three keys matter. Keep them straight:

| Key | What it does | Where it lives |
| --- | --- | --- |
| Deployer / Operator hot key | Deploys the program, creates the pool, then cranks it every day | `solana config` keypair on the laptop, base58 secret in `.env.mainnet` on the box |
| Program keypair | Fixes the program ID `EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH` | `keys/hex_vault-mainnet-keypair.json` (gitignored) and an offline backup |
| Ledger | Upgrade authority after launch | the hardware wallet |

The Admin is the Squads vault, never a key on disk. Nobody holds a mainnet secret in git.

## 0. Have these before you start

- A Squads multisig on mainnet with the agreed signers and threshold. Its vault address is
  `ADMIN_ADDRESS`. Send the vault 0.1 SOL (it pays proposal rent).
- A Ledger with the Solana app, and a second person to read addresses back.
- A Helius mainnet key of its own, plus a second provider for `RPC_FALLBACK_URL`.
- DNS: an A record for the API host pointing at the VPS. The Vercel Production project exists.
- About 5 SOL for the deployer. Rent for the 820 KB binary is 4.25 SOL (`solana rent 837328 -u
  mainnet-beta`) and stays locked in the program; the deploy instruction refunds the buffer to the
  payer before it creates ProgramData, so that rent is paid once, not twice. The rest covers
  pool creation (0.01), two token accounts (0.004), fees, and the operator's running costs.
- `solana-verify` installed (`cargo install solana-verify`, needs Docker).
- The mainnet build comes from `main`. Merge first.

## 1. Pick the deployer

The deployer and the operator are the same key on launch day: `create_pool` only accepts the
program's upgrade authority as payer, and bootstrap pays with `OPERATOR_KEYPAIR`. One script
makes a fresh key (never a devnet one), writes it into `.env.mainnet` as `OPERATOR_KEYPAIR`
(base58, for the backend) and `DEPLOY_KEYPAIR` (the file, for `deploy.sh`), and points the solana
CLI at it:

```bash
scripts/mainnet-keys.sh             # prints the pubkey and the transfer command to fund it
solana transfer <that pubkey> 5 --from <your funded wallet> --allow-unfunded-recipient
```

To deploy from a wallet you already have (Phantom, Backpack, Solflare) instead: export its private
key from the wallet's settings, then `scripts/mainnet-keys.sh import` and paste it at the prompt.
Everything after that is the same. Two things to know first: that key becomes the operator hot key
and lives in `.env.mainnet` on the VPS, so use a wallet that holds nothing but this project's SOL,
and it cannot be the Admin (`ADMIN_ADDRESS`), which bootstrap enforces. A Ledger cannot be the
deployer; `deploy.sh` writes the 820 KB buffer in about 800 signed chunks, and it only asks the
Ledger to sign after the handover.

Put `keys/hexvault-mainnet-operator.json` and `keys/hex_vault-mainnet-keypair.json` in the team
password manager now. The program keypair is the only way to get this program ID; after step 5 it
is never needed again.

## 2. What to change before the build

- `programs/hex_vault/src/lib.rs`, `security_txt!`: `contacts` still says `email:TODO@hexvault.example`.
  Put a monitored address there. It ships inside the binary, so fixing it later is an upgrade.
- `.env.mainnet` (step 1 created it from the example): fill in `API_HOST`, `POSTGRES_PASSWORD`,
  `RPC_URL`, `RPC_FALLBACK_URL`, `ADMIN_ADDRESS` (the vault), `OPS_WALLETS` (team wallets for Fast
  pause and Game config), `CORS_ORIGIN`, `INVITE_ADMIN_KEY`. Leave `TREASURY` and `BUYBACK_RESERVE`
  empty for now (bootstrap creates them in step 4) and `SPARRING_KEYPAIR` empty. `PROGRAM_ID`,
  `CLUSTER`, `POOL_ID=1`, `ACCEPTED_MINT` are already right.
- Pick the venue. `create_pool` pins it for good; changing it later is a proposal, a 48 hour lock,
  a drain and a migration (`runbook.md`, "Changing a pool's venue"). Two choices:
  - Kamino's USDC lending reserve on the main market: leave `VENUE_KIND` and `KLEND_*` empty.
    Bootstrap pins it and creates the pool's cToken account. Low yield on a small pool.
  - A Kamino Earn vault of your choice (the fork rehearsals used
    `DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP`, about 5.2% on 2026-10-09). Find the vault's
    state account on Kamino's site and set:
    ```
    VENUE_KIND=kvault
    KVAULT_ADDRESS=<vault state account>
    ```
    Bootstrap derives the shares mint and creates the pool's share account. A different klend
    reserve instead takes `KLEND_RESERVE` plus `KLEND_CTOKEN` (the pool PDA's ATA of that
    reserve's cToken mint).

Nothing else switches by hand: the `mainnet` cargo feature picks `declare_id!`, `Anchor.toml`
already lists the mainnet ID, and `deploy.sh mainnet` reads `RPC_URL` from `.env.mainnet`.

## 3. Deploy the program

```bash
scripts/deploy.sh mainnet --dry-run     # build, check-deployable, program id check; writes nothing
scripts/deploy.sh mainnet               # type the program id at the prompt
solana program show EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH   # Authority = solana address
```

The hot key stays upgrade authority on purpose. Do not run `handover` yet.

## 4. Create pool 1

```bash
set -a; . ./.env.mainnet; set +a
pnpm --filter @hexvault/backend bootstrap \
  --epoch-anchor <next Sunday 16:00 UTC, ISO 8601> --epoch-seconds 86400 --min-jackpot 1 > mainnet-pool.env
```

Open a fresh shell for this (a previous `set -a` on another env file leaks values). The admin
comes from `ADMIN_ADDRESS`; do not pass `--operator` or `--start`. Bootstrap creates the Treasury
and Buyback reserve itself, two plain USDC accounts owned by the Admin, then the pool, which
starts with game, jackpot and bought tickets paused. To use one account for both roles (no
token buyback planned, the same-address guard is commented out), pass the same address twice:
`--treasury <addr> --buyback-reserve <addr>`, where `<addr>` is any USDC token account owned by
the Admin. `mainnet-pool.env` holds `POOL_ADDRESS`, the
vaults, `TREASURY`, `BUYBACK_RESERVE` and the four `KLEND_*` pins as the chain recorded them.
Paste `TREASURY`, `BUYBACK_RESERVE` and the venue lines it prints (`VENUE_KIND`, `KLEND_*`,
`KVAULT_ADDRESS` if used) into `.env.mainnet`: the backend compares all of them with the Pool at
boot and refuses on any difference. The second person checks the pins against Kamino.

## 5. Hand the program to the Ledger, publish the IDL

Ledger plugged in, unlocked, Solana app open.

```bash
scripts/deploy.sh mainnet handover      # type the Ledger pubkey at the prompt
scripts/deploy.sh mainnet --idl         # signs with the Ledger
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
| `runbook.md`, "Admin actions through Squads" | Whether Squads re-signs an expired blockhash at import or at simulation (first paste tells you). |

Commit `mainnet-pool.env`'s public lines into `environments.md`, not the file itself. Never commit
`.env.mainnet`, `keys/`, or the operator keypair: the `.gitignore` already blocks all three.

## 7. Bring up the stack and the site

On the box, with `.env.mainnet` copied over (`scp`, never git):

```bash
docker compose --env-file .env.mainnet config | head -1      # must print name: hexvault-mainnet
docker compose --env-file .env.mainnet up -d --build
curl -s https://<API_HOST>/status | jq '{rpcOk, lastAction}'
curl -s https://<API_HOST>/healthz | jq .operatorSol        # about 2
curl -s https://<API_HOST>/alerts                            # 200, []
```

Every mainnet compose command carries `--env-file .env.mainnet`, or it hits the devnet stack.

Vercel Production project, from `apps/web/.env.mainnet.example`: `VITE_CLUSTER=mainnet-beta`,
`VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID=1`, `VITE_PRIVY_APP_ID`, plus `VITE_GATE_GAME=off`
and `VITE_GATE_JACKPOT=off`. Redeploy (a Vercel var only reaches the bundle on the next build). Then
the leaked-key check from `runbook.md`, "Frontend RPC endpoint and checking for a leaked key".

## 8. Open it up

Deposit-only first: connect a wallet, deposit 1 USDC, see it pending, refund, deposit again. Then,
one at a time, each as a Squads paste (`ADMIN_ADDRESS` set, command prints base58, import within
a minute):

```bash
set -a; . ./.env.mainnet; set +a
DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin start-jackpot | pbcopy
# /state shows pool.jackpotPaused false -> remove VITE_GATE_JACKPOT on Vercel, redeploy
DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin start-game | pbcopy
# /state shows pool.gamePaused false -> remove VITE_GATE_GAME on Vercel, redeploy
```

Game config (round seconds, house cut, tiers) is set from `/ops` with a wallet in `OPS_WALLETS`
before `start-game`. `start-buy-tickets` waits until the first draw has paid (ADR 0019).

## 9. Spare operator wallet

Make it on launch day so a rotation is a paste, not a scramble. The operator holds no user funds,
only fee SOL, so a spare is cheap.

```bash
scripts/mainnet-keys.sh spare       # creates keys/hexvault-mainnet-operator-spare.json, prints the funding and ATA commands and the base58 secret
```

Run the two commands it prints. The USDC ATA must exist before the rotation: `set_operator`
repoints the House Player at the new key, and a House prize pays into that ATA. Store the printed
base58 secret in the password manager next to the first one; the script writes nothing to
`.env.mainnet` in spare mode.

To rotate (leaked key, lost laptop, or a planned handoff):

```bash
DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-operator --key <operator-2 pubkey> | pbcopy
```

Execute in Squads, then on the box set `OPERATOR_KEYPAIR` in `.env.mainnet` to the spare's secret
and `docker compose --env-file .env.mainnet up -d --force-recreate backend`. Keep the old key's
USDC ATA open: an already-won House prize still pays there. Sweep its leftover SOL to the new key
when you are sure it is retired.

## Later: upgrades

```bash
solana program dump EwqRKGqnH7dGwL5ERMGQc2tsLKwT3duzKWPcCDphyPCH /tmp/hex_vault-prev.so --url mainnet-beta   # rollback copy
scripts/deploy.sh mainnet --upgrade     # hot key writes the buffer, Ledger signs once
scripts/deploy.sh mainnet --idl         # if the IDL changed
```

Never between a `request_draw` and its `draw`, and never across a layout rewrite
([`environments.md`](environments.md#when-a-new-program-id-is-warranted)). Moving the upgrade
authority from the Ledger to Squads is a separate, later decision; the commands are in
[`deploy.md`](deploy.md#moving-admin-and-the-upgrade-authority-to-squads-later).
