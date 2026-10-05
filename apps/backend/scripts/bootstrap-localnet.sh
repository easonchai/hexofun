#!/bin/sh
set -eu

# Ticket 09 acceptance item 1: boot an isolated validator, deploy the
# already-built program, run `bootstrap` twice and diff the two KEY=value
# blocks. Not part of any test suite; run it by hand after `anchor build`.
# Both runs pass --start (game-jackpot-pause ticket 02), so the pool comes
# up running; run 2 finds both switches already off and sends nothing.
#
# Usage:  sh apps/backend/scripts/bootstrap-localnet.sh [--round-seconds 20 ...]
#         HEXVAULT_RPC_PORT=9399 sh apps/backend/scripts/bootstrap-localnet.sh
#
# Every port is derived from HEXVAULT_RPC_PORT, same as tests/run-local.sh, so
# two agents can run this side by side.

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backend=$(dirname "$here")
root=$(dirname "$(dirname "$backend")")

port="${HEXVAULT_RPC_PORT:-9399}"
rpc="http://127.0.0.1:$port"
work="${TMPDIR:-/tmp}/hexvault-bootstrap-$port-$$"
mkdir -p "$work"
wallet="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

cleanup() {
  kill "$validator_pid" 2>/dev/null || true
  wait "$validator_pid" 2>/dev/null || true
  # Holds the throwaway authority's secret key.
  rm -rf "$work" 2>/dev/null || true
}

solana-test-validator \
  --ledger "$work/ledger" --reset --quiet \
  --rpc-port "$port" \
  --faucet-port $((port + 2)) \
  --gossip-port $((port + 3)) \
  --dynamic-port-range $((port + 4))-$((port + 44)) \
  >"$work/validator.log" 2>&1 &
validator_pid=$!
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if solana --url "$rpc" cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

program_id=$(node -e "process.stdout.write(require('$root/target/idl/hex_vault.json').address)")
solana --url "$rpc" program deploy \
  "$root/target/deploy/hex_vault.so" \
  --program-id "$root/target/deploy/hex_vault-keypair.json" \
  --keypair "$wallet" \
  --upgrade-authority "$wallet" \
  --use-rpc >/dev/null
echo "deployed $program_id at $rpc"

# A throwaway authority, funded from the validator faucet. Its secret key
# lives in $work and goes with it on cleanup; only the pubkey is printed.
solana-keygen new --no-bip39-passphrase --silent --outfile "$work/authority.json"
authority=$(solana-keygen pubkey "$work/authority.json")
solana --url "$rpc" airdrop 10 "$authority" --keypair "$wallet" >/dev/null
echo "authority $authority"

cd "$backend"
OPERATOR_KEYPAIR=$(node -e "
const bs58 = require('bs58');
const secret = JSON.parse(require('node:fs').readFileSync('$work/authority.json', 'utf8'));
process.stdout.write((bs58.default ?? bs58).encode(Uint8Array.from(secret)));
")
export OPERATOR_KEYPAIR
export RPC_URL="$rpc"
export PROGRAM_ID="$program_id"
export POOL_ID="${POOL_ID:-1}"
# Needs a program built with `--features test-vrf,test-venue` (what
# tests/run-local.sh builds): the stub venue is what create_pool pins here, and
# the committed IDL snapshot has no test_venue_init, so read the built one.
export KLEND_VENUE=test
export HEXVAULT_IDL_PATH="$root/target/idl/hex_vault.json"

echo
echo "=== run 1 (fresh cluster) ==="
pnpm exec tsx src/bootstrap.ts --start "$@" >"$work/run1.out"

# The mint keypair is not persisted anywhere, so run 1's mint is run 2's
# input. That is the same handoff a human makes by pasting it into .env.
ACCEPTED_MINT=$(sed -n 's/^ACCEPTED_MINT=//p' "$work/run1.out")
export ACCEPTED_MINT

echo
echo "=== run 2 (same cluster, ACCEPTED_MINT from run 1) ==="
pnpm exec tsx src/bootstrap.ts --start "$@" >"$work/run2.out"

echo
echo "=== KEY=value block ==="
cat "$work/run1.out"

if diff -u "$work/run1.out" "$work/run2.out"; then
  echo "OK: the second run created nothing and printed the same block"
else
  echo "FAIL: the two runs printed different values"
  exit 1
fi
