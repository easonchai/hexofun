# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs are local markdown under `docs/plan/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Where things live

- Web reads: `apps/web/src/api.ts` (backend client), `read.ts` (the one direct chain read). Sends: `actions.ts` (`sendMany`). Error copy: `playerErrors.ts`.
- Ops console: `apps/web/src/ops/` (`tx.ts` signs, `instructions.ts` builds).
- Backend read model: `apps/backend/src/api/api.service.ts`. Operator: `apps/backend/src/operator/` (`tick.ts`, `instructions.ts`). Admin CLI: `apps/backend/src/admin/`.
- Program: `programs/hex_vault/`. Deploys and env layout: `runbook.md`.

## Testing

- DB-backed suites: `pnpm --filter @hexvault/backend test:db` first; it starts the 5433 test Postgres itself.
- Mainnet fork by hand: `scripts/surf.sh` (subcommands in its header: `up`, `fund`, `admin`, `web`, `logs`). Read logs with `scripts/surf.sh logs`, which redacts the RPC key.
- Wait on a long-running process with `run_in_background` or Monitor, not `sleep` loops.

## Committing

Stage by explicit path and read `git diff --cached --stat` first; the index may hold changes staged by someone else.
