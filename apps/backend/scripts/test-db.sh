#!/bin/sh
set -eu

# Ticket 01 acceptance: "skipped" must never pass for "passed" on a laptop.
# Creates (if missing) and migrates the per-suite databases the
# DB-backed vitest suites expect on the shared 5433 test Postgres (see
# src/test-utils/db-probe.ts and docker-compose.dev.yml's postgres service).
#
# Usage: pnpm --filter @hexvault/backend test:db

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backend=$(dirname "$here")

host="${PGHOST:-127.0.0.1}"
port="${PGPORT:-5433}"
user="${PGUSER:-hexvault}"
export PGPASSWORD="${PGPASSWORD:-hexvault}"

for db in hexvault_api hexvault_access hexvault_referrals hexvault_indexer hexvault_operator hexvault_error_reports hexvault_ops; do
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
