# 12 Deploy: devnet program, Contabo compose, Vercel

Status: done (devnet VPS and Vercel live, see docs/ops/environments.md)
Type: task
Blocked by: 07, 08, 09, 11

## Goal

The demo is live at a public URL.

## Steps

1. **Program to devnet** (human, needs the deploy key and ~5 SOL of devnet airdrop): `anchor build && anchor deploy --provider.cluster devnet`. Confirm `declare_id!` matches. Commit the IDL.
2. **VPS** (human): clone repo, create `.env` from spec §3.1 with the Helius devnet URL and the authority key (`solana-keygen new`, airdrop 5 SOL). `docker compose up -d postgres`, then `docker compose run backend pnpm bootstrap` and paste its output into `.env`, then `docker compose up -d backend`. Traefik labels in `docker-compose.yml` route `Host(api.<domain>)` to port 8080 on the existing Traefik network; TLS is Traefik's job.
3. **Vercel** (human): import repo, root `apps/web`, build `pnpm --filter web build`, env `VITE_RPC_URL` (second Helius key with the Vercel domain allowlisted), `VITE_API_URL=https://api.<domain>`, `VITE_PROGRAM_ID`, `VITE_POOL_ID=1`, `VITE_PRIVY_APP_ID`. Set `CORS_ORIGIN` on the VPS to the Vercel URL and restart backend.
4. **Agent-prepared parts**: `docker-compose.yml` rewritten for postgres + backend with Traefik labels and an `.env.example` listing every variable with a comment; a `docs/plan/rebuild/runbook.md` with the exact commands above and the "how to reset the demo" recipe (bump `POOL_ID`, re-run bootstrap).

## Acceptance

- `https://api.<domain>/status` is green.
- The Vercel URL completes PRD §9 with a fresh Privy wallet.
- `docker compose logs backend` shows rounds opening and settling every ~65 s.

## Comments

Step 4 done. Steps 1, 2 and 3 stay human work and are untouched; `Status` stays
`ready-for-human`.

Written:

- `docker-compose.yml`: `postgres:16-alpine` with a named volume, a `pg_isready`
  healthcheck and no published port, plus `backend` built from
  `apps/backend/Dockerfile` with the repo root as context. `depends_on` waits on
  `service_healthy`, `restart: unless-stopped`, `env_file: .env`. `DATABASE_URL`
  and `PORT` are set in `environment:` so they override the file: the database
  host inside compose is the service name, and `PORT` is pinned to 8080 to match
  the Traefik service label. The Traefik network is declared `external: true`
  under `${TRAEFIK_NETWORK}`; no Traefik service is defined. Router labels cover
  `Host(\`api.${DOMAIN}\`)`, `websecure`, `${CERT_RESOLVER}` and
  `loadbalancer.server.port=8080`.
- Root `.env.example`: every variable in spec §3.1 and
  `apps/backend/src/config/env.ts`, plus `DOMAIN`, `TRAEFIK_NETWORK`,
  `CERT_RESOLVER` and the `POSTGRES_*` credentials compose needs. Grouped by who
  supplies the value: human, bootstrap (ticket 09), or a spec §7 default.
  Placeholders only.
- `docs/plan/rebuild/runbook.md`: steps 1 to 3 as commands, the reset recipe
  (bump `POOL_ID`, re-run bootstrap, recreate the backend), and the acceptance
  checks. Ticket 13's triage content is deliberately not in it.

Verified: `docker compose config -q` parses clean against a throwaway `.env`
copied from `.env.example`, and the resolved output shows the intended
`DATABASE_URL`, labels and external network. The throwaway `.env` was deleted.

Two things the repo could not settle:

- The step 2 command `docker compose run backend pnpm bootstrap` fails as
  written. The Dockerfile's runtime stage never runs `corepack enable`, and
  `node:22-alpine` ships no `pnpm` shim (checked in the image). The runbook keeps
  the intended command and gives the working equivalent,
  `docker compose run --rm backend node_modules/.bin/tsx src/bootstrap.ts`.
  A one-line `RUN corepack enable` in the runtime stage would fix it, but the
  Dockerfile belongs to ticket 05.
- Nothing in the repo converts `solana-keygen`'s JSON array to the base58
  `AUTHORITY_KEYPAIR` that `ChainService` decodes. The runbook carries a `node -e`
  one-liner using the workspace's own `bs58`.
