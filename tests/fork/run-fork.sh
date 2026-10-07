#!/bin/sh
set -eu

# klend fork suite (yield-claimer ticket 12). Starts a Surfpool mainnet fork,
# deploys the deployable build (anchor build with no features: no test-vrf, no
# test-venue, so the real klend backing) and runs tests/fork/klend.fork.ts
# against it. Not part of tests/run-local.sh.
#
# Needs: surfpool (brew install txtx/taps/surfpool), the Solana CLI, anchor,
# pnpm install, and network access to a mainnet RPC. The fork fetches each
# mainnet account lazily, so the public endpoint is enough for the suite. A
# keyed endpoint is faster; put it in the environment, never in a file:
#
#   HEXVAULT_FORK_DATASOURCE=https://<your mainnet rpc> tests/fork/run-fork.sh
#
# HEXVAULT_FORK_PORT (default 9399) is the Surfpool RPC port; the websocket
# port is one above. Keep it far from a localnet suite's 8899/8999.
# HEXVAULT_SKIP_BUILD=1 reuses target/deploy/hex_vault.so, which must be a
# plain build (tests/fork refuses a test-vrf or test-venue one).
#
# Usage:  tests/fork/run-fork.sh [vitest args...]

port="${HEXVAULT_FORK_PORT:-9399}"
datasource="${HEXVAULT_FORK_DATASOURCE:-https://api.mainnet-beta.solana.com}"
rpc="http://127.0.0.1:$port"
workdir="$(mktemp -d "${TMPDIR:-/tmp}/hexvault-fork-$port-XXXXXX")"
target_backup="$workdir/target-backup"
repo="$(pwd)"

export ANCHOR_PROVIDER_URL="$rpc"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

cleanup() {
  # Surfpool ignores SIGTERM.
  kill -9 "${surfpool_pid:-}" 2>/dev/null || true
  wait "${surfpool_pid:-}" 2>/dev/null || true
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
  rm -rf "$workdir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "${HEXVAULT_SKIP_BUILD:-}" != "1" ]; then
  mkdir -p "$target_backup"
  if [ -d target/idl ]; then mv target/idl "$target_backup/idl"; fi
  if [ -d target/types ]; then mv target/types "$target_backup/types"; fi
  if [ -f target/deploy/hex_vault.so ]; then mv target/deploy/hex_vault.so "$target_backup/hex_vault.so"; fi
  anchor build
fi

sh scripts/check-deployable.sh target/deploy/hex_vault.so
if strings target/deploy/hex_vault.so | grep -q test-venue; then
  echo "run-fork: target/deploy/hex_vault.so is a test-venue build; rebuild with a plain anchor build" >&2
  exit 1
fi

# Surfpool writes a .surfpool directory into its working directory, so run it
# from the scratch one.
(
  cd "$workdir"
  # The datasource goes in by environment so a keyed URL never shows in `ps`.
  SURFPOOL_DATASOURCE_RPC_URL="$datasource" exec surfpool start \
    --port "$port" --ws-port $((port + 1)) --studio-port $((port + 2)) \
    --no-tui --no-deploy --no-studio -y
) >"$workdir/surfpool.log" 2>&1 &
surfpool_pid=$!

for _ in $(seq 1 60); do
  if solana --url "$rpc" cluster-version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Surfpool airdrops the default keypair, which pays for the deploy.
solana --url "$rpc" program deploy \
  target/deploy/hex_vault.so \
  --program-id target/deploy/hex_vault-keypair.json \
  --upgrade-authority "$ANCHOR_WALLET" \
  --use-rpc >/dev/null
echo "deployed to $rpc (forking $(echo "$datasource" | sed 's|//.*@|//|' | cut -d/ -f1-3))"

export HEXVAULT_IDL_PATH="$repo/target/idl/hex_vault.json"
# A failed account fetch makes Surfpool put the full datasource URL (api key
# included) in the transaction error, so vitest's output goes through redact.
# sh has no pipefail: the group writes vitest's exit code to a file instead.
. scripts/lib/redact.sh
status="$workdir/vitest.status"
{
  rc=0
  pnpm exec vitest run --config tests/fork/vitest.config.ts "${@:-tests/fork}" || rc=$?
  echo "$rc" >"$status"
} 2>&1 | redact
read -r rc <"$status" || rc=1
exit "$rc"
