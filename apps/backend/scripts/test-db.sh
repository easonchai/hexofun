#!/bin/sh
set -eu

# Ticket 01 acceptance: "skipped" must never pass for "passed" on a laptop.
# Creates (if missing) and migrates the per-suite databases the
# DB-backed vitest suites expect on the shared 5433 test Postgres (see
# src/test-utils/db-probe.ts). When nothing answers on the default
# 127.0.0.1:5433 it starts the `hexvault-test-pg` container, creating it on
# first use. docker-compose.dev.yml's postgres is the dev DB on 5432, not this.
# A new DB-backed suite adds its database to the list below.
#
# Usage: pnpm --filter @hexvault/backend test:db

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backend=$(dirname "$here")

host="${PGHOST:-127.0.0.1}"
port="${PGPORT:-5433}"
user="${PGUSER:-hexvault}"
export PGPASSWORD="${PGPASSWORD:-hexvault}"

if ! pg_isready -q -h "$host" -p "$port" && [ "$host:$port" = "127.0.0.1:5433" ]; then
  docker start hexvault-test-pg >/dev/null 2>&1 \
    || docker run -d --name hexvault-test-pg -p 5433:5432 \
      -e POSTGRES_USER="$user" -e POSTGRES_PASSWORD="$PGPASSWORD" postgres:16-alpine >/dev/null
  for _ in $(seq 1 30); do pg_isready -q -h "$host" -p "$port" && break; sleep 1; done
  pg_isready -q -h "$host" -p "$port" || { echo "test-db: no Postgres on $host:$port after 30s" >&2; exit 1; }
  echo "test-db: started hexvault-test-pg"
fi

for db in hexvault_api hexvault_access hexvault_referrals hexvault_indexer hexvault_operator hexvault_error_reports hexvault_ops hexvault_sessions hexvault_referral_grants; do
  exists=$(psql -h "$host" -p "$port" -U "$user" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$db'")
  if [ "$exists" != "1" ]; then
    createdb -h "$host" -p "$port" -U "$user" "$db"
    echo "test-db: created $db"
  fi
  DATABASE_URL="postgresql://$user:$PGPASSWORD@$host:$port/$db" \
    pnpm --dir "$backend" exec prisma migrate deploy --schema "$backend/prisma/schema.prisma"
  echo "test-db: migrated $db"
done
