# Deploying and upgrading

One script, `scripts/deploy.sh <dev|staging|mainnet> [--upgrade] [--dry-run]`, builds, checks and
deploys or upgrades the `hex_vault` program for one environment. The same script also has two
opt-in actions, `--idl` (publish the on-chain IDL) and `verify` (reproducible-build
verification); see "Publishing the IDL" and "Verifiable build" below. Run it from the repo root,
same as `scripts/check-deployable.sh` and `tests/run-local.sh`. See
[`docs/ops/environments.md`](environments.md) for what each environment is.

## First deploy per environment

```bash
scripts/deploy.sh dev
scripts/deploy.sh staging
scripts/deploy.sh mainnet
```

The script, in order:

1. Maps the environment to a cargo feature, a keypair under `keys/`, and a cluster URL (devnet
   for dev and staging, `.env.mainnet`'s `RPC_URL` for mainnet).
2. Builds: `anchor build -- --features <feature>` for dev and staging, `solana-verify build --
   --features mainnet` for mainnet (see "Verifiable build" below).
3. Runs `scripts/check-deployable.sh`, which refuses a `test-vrf` or `test-venue` artifact.
4. Asserts that the keypair's pubkey matches the built `declare_id!` (read from the built IDL's
   `address` field), so a mismatched keypair fails before anything is written on chain.
5. Writes a buffer, then deploys or upgrades against it. Both calls carry a priority fee
   (`--with-compute-unit-price`, from `DEPLOY_CU_PRICE`, default `100000`) and
   `--max-sign-attempts 50` so a large program lands under congestion; mainnet also adds
   `--use-rpc`, since it only helps when the RPC is stake-weighted (Helius, Triton) and only
   mainnet's RPC is.
6. After the deploy, asserts the on-chain upgrade authority (`solana program show
   <program-id>`) equals the authority expected for the env: the Ledger on mainnet, the locally
   configured keypair (`solana address`) elsewhere. Then checks `solana program show --buffers
   --buffer-authority <that authority>` and fails if any buffer remains.
7. Prints the program's `solana program show` output, then runs both apps' `sync-idl` scripts.

`--dry-run` does steps 1 to 4 (and the ProgramData size read under `--upgrade`) but never calls
`solana program write-buffer`, `extend`, `deploy` or `sync-idl`, and never checks buffers or the
upgrade authority. It touches no network write, so it is safe to run against real keys and a real
cluster to sanity-check a build.

If a step after `write-buffer` fails, the script prints the exact `solana program close <buffer>
--bypass-warning` command for the buffer it just wrote, so nothing is left stranded paying rent to
nobody. The post-deploy buffer check catches the same thing for any other leftover buffer under
the same authority (an interrupted previous run, for example).

Mainnet asks for a typed confirmation of the program ID before writing the buffer, and signs with
`--upgrade-authority usb://ledger`. The fee payer defaults to the locally configured keypair
(`solana config get`); set `FEE_PAYER_KEYPAIR` (a path, or another `usb://ledger[?key=N]`) to pay
fees from somewhere else.

### The cosmetic "Program ID mismatch" warning

`anchor build -- --features staging` (or `mainnet`) prints:

```
Program ID mismatch detected for program 'hex_vault':
Please run 'anchor keys sync' to update the program ID in your source code or use the '--ignore-keys' flag to skip this check.
```

This is Anchor comparing the built `declare_id!` against `Anchor.toml`'s `[programs.localnet]` /
`[programs.devnet]` entries, which always carry the dev program ID (`Anchor.toml`'s `[programs.
mainnet]` entry is the only one that matches a non-dev build, and only for mainnet). Ignore it:
`deploy.sh` never runs `anchor deploy` or `anchor keys sync`, and its own step 4 above is the
real check against the keypair you are about to deploy with.

## Upgrading

```bash
scripts/deploy.sh dev --upgrade
```

Before writing a buffer, the script reads the current ProgramData size (`solana program show`)
and compares it against the new `.so`. If the build is larger, it prints the exact `solana
program extend <program-id> <bytes>` command and, outside `--dry-run`, asks to run it (`y/N`)
before continuing; `solana program deploy` also auto-extends if a required extend was skipped, so
declining here is not a hard stop.

**Never `--upgrade` across the live-yield layout rewrite.** That rewrite (yield-claimer ticket 04)
changed the layout and discriminator of `Pool`, `Player`, `Round` and `Position`, so it deploys to
a fresh program ID per environment with pools bootstrapped anew. See
[`environments.md`](environments.md#the-live-yield-layout-rewrite-needs-one-in-every-environment).

**Deploy an upgrade only when no `Round` is open.** Before the rewrite, `Round` had no reserved
padding, so a `Round` account open at the moment of an upgrade that changed `Round`'s layout
failed to deserialize on the next instruction that touched it. Since the rewrite `Round` carries
64 reserved bytes and `Position` 32, but an open round is still the one account an upgrade can
strand mid-flight, so the rule stays. Check `GET /status` (`openRoundId`) or wait for the current
round to settle before running `--upgrade`.

`Pool`, `Epoch`, `Player`, `Round` and `Position` carry `version` and `_reserved` padding so an
upgrade that only adds a field there needs no such care; see ADR 0013.

### Rollback

Before any upgrade, dump the currently deployed bytes so there is a way back:

```bash
solana program dump <program-id> /tmp/hex_vault-prev.so --url <cluster>
```

To roll back, write a buffer from that dump and deploy it the same way as a forward upgrade:

```bash
solana program write-buffer /tmp/hex_vault-prev.so --url <cluster>
solana program deploy --buffer <buffer> --program-id keys/hex_vault-<env>-keypair.json --url <cluster>
```

A rollback only restores code. It does not undo state a newer version already wrote (for
example, a `version` bump or a field the old code never reads); check whether that matters before
relying on it.

### Closing stray buffers

A failed or abandoned `write-buffer` leaves a buffer account behind, paying rent to nobody in
particular:

```bash
solana program show --buffers --url <cluster>
solana program close <buffer-pubkey> --url <cluster>
```

`target/deploy/hex_vault-keypair.old.json` and `target/deploy/hex_vault-upgrade-buffer.json` in
this repo are exactly that: leftovers from before the per-environment keypairs (`keys/`) and
`deploy.sh` existed. Run `solana program show --buffers` against devnet, close whatever matches,
and delete the two files; they are not read by anything.

`deploy.sh` now catches this itself: it prints the close command if a later step fails right after
`write-buffer`, and it fails the run outright if `solana program show --buffers` still lists a
buffer under the deploy authority once the deploy has finished.

## Publishing the IDL

```bash
scripts/deploy.sh dev --idl
```

Builds (so the IDL reflects the current source), then runs `anchor idl init` the first time and
`anchor idl upgrade` on every run after that, against the env's cluster and program ID, signing
with the same authority as a deploy (`usb://ledger` on mainnet). It does not write a program
buffer or touch the deployed bytecode, so it is safe to run on its own after a deploy that only
changed instructions, accounts or docs on the Rust side without a corresponding binary change, or
any time the on-chain IDL has drifted. `--dry-run` prints which of `init`/`upgrade` it would run
without calling either. Not run automatically by a plain deploy, so a staging deploy stays fast;
run it whenever the IDL actually changed.

Three things bit on devnew on 2026-09-28, all outside this repo:

- `anchor idl` shells out to `npx @solana-program/program-metadata`, whose `@solana/kit` is a
  peer dependency. With `legacy-peer-deps=true` in `~/.npmrc` npx skips it and the CLI dies with
  `Cannot find module '@solana/kit'`. Fix: `npm i --prefix ~/.npm/_npx/<hash> @solana/kit@6`.
- The CLI sends its 15-transaction plan five at a time and the whole plan fails on one HTTP 429,
  on the public devnet RPC and on the free Helius tier alike. Run the CLI directly with a
  `--require` preload that wraps `createTransactionPlanExecutor` to send one at a time (the
  2026-09-28 run kept one under the scratchpad), or use a paid RPC.
- The IDL account created on 2026-09-23 decoded as `seed: "dl", canonical: false` under
  program-metadata 0.5.1, and `update` failed with "instruction requires an initialized
  account". `program-metadata close idl <program>` then `create` fixed it. Failed runs leave
  12.5 KiB buffers behind: `list-buffers <authority>` then `close-buffer <address>` reclaims them.

## Upgrade policy (ADR 0013)

- Append-only. A new field takes bytes from a struct's `_reserved`, never reorders or resizes an
  existing field.
- Its zero value must be a safe default, or the change bumps `version` and migrates the account
  lazily on first touch.
- A new capability is a new instruction (`foo_v2`), not a new required argument on an existing
  one; old clients keep working.
- The live-yield layout rewrite was the one exception, on a fresh program ID per environment
  (ADR 0013's 2026-10-04 amendment). It also gave `Round` and `Position` padding, so they follow
  this policy from then on.

## Admin signing: local key, Ledger or Squads

Three ways an admin-gated instruction gets signed, picked by env vars the admin CLI
(`apps/backend/src/admin`) reads at run time:

- **Local key** (the default): `chain.keypair`, the same key configured for the operator, signs
  and sends directly. Fine for dev and staging.
- **Ledger**: `ADMIN_KEYPAIR=usb://ledger[?key=N]` (`key` defaults to 0, the same derivation path
  the `solana` CLI uses) signs through `@ledgerhq/hw-app-solana`. Plug the Ledger in and unlock
  the Solana app first. If `ADMIN_ADDRESS` is also set, the CLI checks the Ledger's pubkey
  against it before building any transaction and fails closed on a mismatch.
- **Squads** (mainnet today): set `ADMIN_ADDRESS` to the multisig vault's address without loading
  its key anywhere. Every admin-gated command (`set-params`, `shutdown`, `sweep-house`,
  `set-operator`, `propose-admin`, `accept-admin`, and `grant-tickets`'s admin path) then builds the instruction with the vault as signer and fee
  payer and prints one base58 transaction on stdout instead of sending it
  (`apps/backend/src/admin/squads.ts`, `adminMode`); everything else it prints goes to stderr, so
  `admin sweep-house | pbcopy` hands Squads a clean paste. In Squads:
  Transaction Builder, Add instruction, Import base58 encoded tx, paste, simulate, then collect
  approvals and execute. `start-game` and `start-jackpot` are admin-gated too and go through
  the same path. The transaction carries a blockhash that expires in about a minute;
  re-run the command for a fresh one if the paste took too long. `pause`, `pause-game`,
  `pause-jackpot`, `fund-jackpot` and `emergency-crank` never go through Squads: they are
  permissionless or dual-signer by design, so none of them has to wait on multisig approval,
  which matters most for `pause` in an incident.

`scripts/deploy.sh mainnet` always signs the program upgrade itself with a Ledger
(`--upgrade-authority usb://ledger`), independent of whichever of the three modes above the admin
CLI is using for instructions.

## Treasury and Buyback reserve for a mainnet Pool

`bootstrap` refuses to run on mainnet's genesis hash unless `--admin`, `--treasury` and
`--buyback-reserve` are all given explicitly, and refuses an `--admin` equal to the operator hot
key (`apps/backend/src/bootstrap/params.ts`, `assertMainnetSafe`); it never creates a mint on
mainnet either. Treasury and Buyback reserve share (mint, owner), so they cannot both be the
Associated Token Account of the Squads vault and the accepted mint: `create_pool` would accept it,
but the two roles would then be indistinguishable to anyone reading the vault's token accounts.
Create one of them as a plain (non-ATA) token account instead, owned by the vault:

```
spl-token create-account <accepted-mint> --owner <squads-vault> --fee-payer <funding-keypair>
```

run twice with two throwaway account keypairs (`spl-token create-account` without `--owner`
defaults to a fresh random address rather than the deterministic ATA when a keypair is supplied
positionally: `spl-token create-account <accepted-mint> <new-account-keypair.json> --owner
<squads-vault>`). Pass the resulting addresses to bootstrap:

```
bootstrap --admin <squads-vault> --treasury <treasury-address> --buyback-reserve <buyback-address>
```

## The venue a Pool pins

`create_pool` pins four klend addresses on the Pool for good (`klend_program`, `klend_market`,
`klend_reserve`, `klend_ctoken`), and a wrong pin cannot be fixed afterwards. Bootstrap takes them
from `KLEND_PROGRAM`, `KLEND_MARKET`, `KLEND_RESERVE` and `KLEND_CTOKEN`. On mainnet each defaults
to Kamino's USDC reserve on the main market, and `KLEND_CTOKEN` to the pool PDA's ATA of the
reserve's cToken mint, which bootstrap creates before `create_pool`. Overriding `KLEND_RESERVE`
there requires `KLEND_CTOKEN` too. Any other cluster has no default and bootstrap names the
missing variables; on a localnet built with `--features test-vrf,test-venue`, `KLEND_VENUE=test`
pins the stub venue and runs `test_venue_init` (`apps/backend/scripts/bootstrap-localnet.sh` sets
it). Bootstrap prints `WEIGHT_TREE` and the four pins as the chain recorded them, for a second
person to check.

## Moving admin and the upgrade authority to Squads later

Not done yet for this environment split (spec.md "Out of Scope"): a new mainnet pool starts with
the upgrade authority on a Ledger, and the admin CLI can already print for a Squads vault
(`ADMIN_ADDRESS`, see "Admin signing" above) but nothing has actually handed the admin role to
one yet. The path, when it happens:

1. **Upgrade authority**: `solana program set-upgrade-authority <program-id>
   --new-upgrade-authority <squads-vault> --upgrade-authority usb://ledger` moves it from the
   Ledger to the vault.
2. **Admin role**: the current admin runs `admin propose-admin --key <squads-vault>`, then, with
   `ADMIN_ADDRESS=<squads-vault>` exported, `admin accept-admin`; the CLI prints a base58
   transaction with the vault as the proposed admin, and someone with a signer role in Squads
   imports and executes it. The two-step handover means a typo in `propose-admin` never hands the
   pool to an address nobody controls.
3. **Program upgrades under Squads from then on**: write a buffer as usual (`solana program
   write-buffer`), transfer the buffer's authority to the vault (`solana program
   set-buffer-authority <buffer> --new-buffer-authority <squads-vault>`), then propose the
   upgrade in Squads against that buffer and the program ID.
4. **Timelock**: a delay between Squads approval and execution, on top of Squads itself, is a
   later addition; not implemented here.

## Vercel

Two feature gates live only on the Vercel project, never on chain or in a committed env file:
`VITE_GATE_GAME` and `VITE_GATE_JACKPOT` (see `CONTEXT.md`, "Feature gate"). Set to `off`, a gate covers
its feature with a "COMING SOON" card of the same size; unset, or any other value, the feature shows.
Both are Vite build-time variables, so a change only reaches the site on the next build.

Mainnet starts with both set to `off`:

```
VITE_GATE_GAME=off
VITE_GATE_JACKPOT=off
```

Remove each one only after its chain switch is confirmed live in `GET /state`, then redeploy; see
`runbook.md`, "Launch week", for the order.

## Launch checklist

Before a real mainnet deploy:

- [ ] Independent audit of `programs/hex_vault`.
- [ ] A bug bounty (Immunefi or similar) live before or at launch.
- [ ] Verifiable build: repo pushed at the deployed commit, `solana-verify verify-from-repo` and
  `solana-verify remote submit-job` run (see "Verifiable build" below), or the local hash
  published if the repo stays private.
- [ ] Real contacts in `security_txt!` (`programs/hex_vault/src/lib.rs`): `project_url` and
  `contacts` are TODO placeholders today. A placeholder wastes a researcher's report.
- [ ] A paid RPC provider with its own API key for mainnet (never share the devnet key's rate
  limit or bill).
- [ ] `PRIORITY_FEE_MAX_MICROLAMPORTS` set for mainnet congestion, not left at the devnet default
  by accident.
- [ ] An uptime monitor polling `GET /alerts` (200 with an empty list when healthy, 503 with the
  active codes otherwise) as the paged URL, not `/healthz` or `/status`; see
  [`docs/ops/incidents.md`](incidents.md) for what to do when a code fires.
- [ ] The mainnet program keypair backed up offline before its first deploy. After that, only the
  upgrade authority (the Ledger) matters, but losing the keypair before the first deploy loses
  the program ID.

### Verifiable build

It needs a public repo at the deployed commit; whether this repo goes public is still open
(spec.md "Open items the user owns"). After a real deploy, from a machine with `solana-verify`
installed (`cargo install solana-verify`, needs Docker) and the repo pushed at the deployed
commit:

```bash
scripts/deploy.sh mainnet verify
```

This refuses on a dirty working tree, then runs, against the current commit:

```bash
solana-verify verify-from-repo \
  --url <cluster for the env> --program-id <program id for the env> \
  <repo-url> --commit-hash <deployed sha> -- --features mainnet

solana-verify remote submit-job \
  --program-id <program id for the env> [--uploader <key>] -- --features mainnet
```

`<repo-url>` is `git remote get-url origin`, converted from SSH to HTTPS if needed; set
`VERIFY_REPO_URL` to override it. `--uploader` is only added when `VERIFY_UPLOADER_KEYPAIR` is
set; left unset, `solana-verify` falls back to its own default (the locally configured keypair).
`verify` works for any env, not only mainnet, but only mainnet is built with `solana-verify build`
(dev and staging use a plain `anchor build`), so it is the one whose deployed bytecode is actually
reproducible this way.

If the repo stays private, run `solana-verify build -- --features mainnet` (`deploy.sh` already
does this for a mainnet build) plus `solana-verify get-executable-hash` locally, and publish the
hash instead of the OtterSec job.
