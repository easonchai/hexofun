#!/bin/sh
set -eu

# Program integration tests against an isolated solana-test-validator with the
# freshly built program deployed as upgradeable (built with test-vrf and
# test-venue).
#
# Set HEXVAULT_RPC_PORT to run several validators side by side (parallel
# agents, or a second suite while one is already running). Every port the
# validator binds is derived from it, so two runs never collide.
#
# Usage:  tests/run-local.sh [vitest args...]
#         HEXVAULT_RPC_PORT=8999 tests/run-local.sh tests/03-epochs.test.ts

port="${HEXVAULT_RPC_PORT:-8899}"
ledger="${TMPDIR:-/tmp}/hexvault-validator-$port-$$"
rpc="http://127.0.0.1:$port"
export ANCHOR_PROVIDER_URL="$rpc"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

# Ticket 01 acceptance: target/deploy, target/idl and target/types are left
# as they were before this run, and check-deployable.sh (which greps
# hex_vault.so for test-vrf symbols) must still pass against whatever was
# there before. target/idl and target/types are backed up and restored
# wholesale: `anchor build` fully regenerates both every time, features or
# not. target/deploy keeps its program keypair(s) untouched instead of
# moving the directory away: the keypair's address is what every existing
# Pool and every client default (DEFAULT_PROGRAM_ID) already assumes, and
# `anchor build` only *generates* one when the file is missing, so leaving
# it in place is what keeps a repeat local run deploying at the same id. Only
# the built artifact (hex_vault.so) is swapped out and restored.
target_backup="${TMPDIR:-/tmp}/hexvault-target-backup-$port-$$"

cleanup() {
  kill "${validator_pid:-}" 2>/dev/null || true
  wait "${validator_pid:-}" 2>/dev/null || true
  rm -r "$ledger" 2>/dev/null || true
  # HEXVAULT_SKIP_BUILD=1 never touched target/ below, so leave it alone here
  # too: restoring/removing it in that mode would delete artifacts this run
  # never modified.
  if [ "${HEXVAULT_SKIP_BUILD:-}" != "1" ]; then
    rm -rf target/idl target/types
    if [ -d "$target_backup/idl" ]; then mv "$target_backup/idl" target/idl; fi
    if [ -d "$target_backup/types" ]; then mv "$target_backup/types" target/types; fi
    if [ -f "$target_backup/hex_vault.so" ]; then
      mv "$target_backup/hex_vault.so" target/deploy/hex_vault.so
    else
      rm -f target/deploy/hex_vault.so
    fi
  fi
  rm -rf "$target_backup" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# `test-vrf` compiles in `test_fulfill`, which fabricates a fulfilled ORAO
# randomness account. The round and epoch suites cannot settle without it.
# `test-venue` compiles in the stub venue (a rate-driven reserve and USDC vault
# plus `test_venue_init`, `test_set_venue_rate` and `test_sync`), which every
# suite's pool fixture needs. The devnet build is a separate explicit
# `anchor build` with no feature flag.
#
# HEXVAULT_SKIP_BUILD=1 reuses whatever is already in target/deploy. Several
# runs in parallel would otherwise each fight for the same cargo target lock
# to produce the identical artifact.
if [ "${HEXVAULT_SKIP_BUILD:-}" != "1" ]; then
  mkdir -p "$target_backup"
  if [ -d target/idl ]; then mv target/idl "$target_backup/idl"; fi
  if [ -d target/types ]; then mv target/types "$target_backup/types"; fi
  if [ -f target/deploy/hex_vault.so ]; then mv target/deploy/hex_vault.so "$target_backup/hex_vault.so"; fi
  anchor build -- --features test-vrf,test-venue
fi

solana-test-validator \
  --ledger "$ledger" --reset --quiet \
  --rpc-port "$port" \
  --faucet-port $((port + 2)) \
  --gossip-port $((port + 3)) \
  --dynamic-port-range $((port + 4))-$((port + 44)) \
  >"$ledger.log" 2>&1 &
validator_pid=$!

for _ in $(seq 1 60); do
  if solana --url "$rpc" cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

program_id=$(node -e "process.stdout.write(require('./target/idl/hex_vault.json').address)")
solana --url "$rpc" program deploy \
  target/deploy/hex_vault.so \
  --program-id target/deploy/hex_vault-keypair.json \
  --upgrade-authority "$ANCHOR_WALLET" \
  --use-rpc >/dev/null
echo "deployed $program_id at $rpc"

# Ticket 01 acceptance: the backend suites must not fall back to the
# committed apps/backend/src/idl/hex_vault.json (it can be a snapshot of a
# different environment, e.g. devnew's, wrong id and missing `testFulfill`),
# so `loadIdl()` reads the id and shape just built above instead, without
# touching that committed file.
export HEXVAULT_IDL_PATH="$(pwd)/target/idl/hex_vault.json"

# Agent worktrees under .claude/ carry their own copies of tests/; skip them.
pnpm exec vitest run --exclude '**/.claude/**' "${@:-tests}"
