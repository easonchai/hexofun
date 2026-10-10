# Ops standards

Read when the diff touches `scripts/`, `runbook.md`, `docs/ops/`, `.husky/` or compose files. Cross-layer rules are in `CODING_STANDARDS.md`.

## Rehearsed before mainnet

- A script or runbook step that touches mainnet runs end to end on the fork (`scripts/surf.sh` block or `--dry-run`) in the same PR, and the PR says how many human actions it needs. [mainnet 10-07 B4: `deploy.sh` needed about 1,070 Ledger presses; M7: `deploy.sh verify` always failed]
- `deploy.sh` checks the `.so` it deploys, not the IDL. The three IDL copies match the build in the same commit. [mainnet 09-28 3, 10-07]
- A runbook command exists in the CLI `--help` at the commit that names it. [mainnet 09-28 2]
- Human prerequisites (keys, hostnames, Vercel env, Helius key rotation) live once, in `docs/ops/` as a checklist, not re-listed in each review report.

## Secrets

- No script echoes, logs or prints a variable that can carry a key (`*RPC*`, `*_URL`, `*DATASOURCE*`). Output passes through `redact.sh`. [beta 09-27, mainnet 10-07, fork-run-fixes 07]
- Error reporting walks the `cause` chain. A test serialises every RPC wrapper error and asserts no `://` host and no `api-key`. [audit-2026-10-09, 2026-10-10]
- `.gitignore` covers `id.json`, `*-keypair.json`, `.env.*`, `.surf/`; a `.dockerignore` and `.vercelignore` exist. Adding a key-shaped file type adds its ignore line in the same diff. [mainnet 10-07]
- The bundle key check runs where the bundle is built, including the Vercel build command. [mainnet 09-28]

## Fork and local env

- Backend containers for the fork start through `scripts/surf.sh`, which unsets `POSTGRES_*`, `ENV_FILE` and `DATABASE_URL` first. A raw `docker compose` line in a doc or script for the fork is a finding. [fork run 10-08 and 10-09: the shell env shadowed `.env.surf` twice]
- A keypair path passed to `surf.sh admin` is absolute; the CLI runs from `apps/backend`.
- A fork helper worth running twice lives in `tests/fork/` or `scripts/`, not in the gitignored `.surf/`. [fork run 10-09: `drive.ts`, `payout-tx.ts`, `check-snapshot.ts` uncommitted]

## Pre-push

- A DB suite that cannot reach Postgres fails the push instead of skipping. [beta 09-27, mainnet 09-28: unfixed twice]
- `--no-verify` is never the proposed fix for a red hook. The hook's output is kept in a log file the fix can read.
