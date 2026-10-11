#!/usr/bin/env bash
# Builds, checks and deploys or upgrades the hex_vault program for one
# environment. See docs/plan/ops-and-envs/spec.md ("Deploy tooling") and
# docs/plan/production-hardening/spec.md ("Deploy tooling"), issues 12 and
# 11. Run from the repo root, same as scripts/check-deployable.sh and
# tests/run-local.sh:
#
#   scripts/deploy.sh <dev|staging|mainnet> [--upgrade] [--dry-run]
#   scripts/deploy.sh <dev|staging|mainnet> --idl [--dry-run]
#   scripts/deploy.sh <dev|staging|mainnet> verify
#   scripts/deploy.sh mainnet handover
#
# --dry-run builds, runs check-deployable.sh, asserts the keypair against the
# built declare_id!, and (with --upgrade) reads the current ProgramData size,
# but never calls solana program write-buffer/extend/deploy and never runs
# sync-idl. It touches no network write and nothing outside target/, so it is
# safe to run against real keys and a real cluster.
#
# write-buffer and deploy always carry a priority fee
# (--with-compute-unit-price, env DEPLOY_CU_PRICE, default 100000) and
# --max-sign-attempts 50, and mainnet also adds --use-rpc (only mainnet's RPC
# is staked). After a deploy or upgrade the script fails if any buffer is
# left under the deploy authority, or if the on-chain upgrade authority is
# not the one expected for the env.
#
# Mainnet launch order (mainnet-readiness-fixes 06, 13): create_pool is
# refused unless the payer is the program's upgrade authority, so
#   1. `deploy.sh mainnet` deploys with the deployer key (DEPLOY_KEYPAIR in
#      .env.mainnet, written by scripts/mainnet-keys.sh) as upgrade authority,
#   2. bootstrap creates the pool with that same deployer as payer and names
#      the operator hot key, which never holds upgrade rights,
#   3. optionally, `deploy.sh mainnet handover` moves the upgrade authority to
#      the Ledger after a confirmation prompt.
# Later upgrades (`--upgrade`) write the buffer with the deployer. If the
# deployer still holds the upgrade authority it signs the deploy too, no
# Ledger involved. Once the Ledger holds it (after handover), the buffer is
# handed to the Ledger with set-buffer-authority and the Ledger signs only the
# final deploy (one confirmation) instead of every ~1 KB write.
# The script prints the cluster name, never the RPC URL: the URL carries the
# provider key (.env.mainnet, DEPLOY_RPC_URL).
#
# --idl runs `anchor idl init` the first time and `anchor idl upgrade` after,
# from the freshly built target/idl/hex_vault.json, signing with the same
# authority as a deploy. `verify` runs `solana-verify verify-from-repo` then
# `solana-verify remote submit-job` against the current commit and refuses on
# a dirty working tree (VERIFY_REPO_URL overrides the repo URL, VERIFY_UPLOADER
# the uploader address; it defaults to the program's on-chain upgrade
# authority). Both are opt-in so a plain deploy stays fast.
#
# If the Ledger is the upgrade authority (usb://ledger), plug it in before an
# `--upgrade` or `--idl`. The fee payer defaults to the locally
# configured keypair (`solana config get`); set FEE_PAYER_KEYPAIR (a path or
# another usb://ledger[?key=N]) to pay the final deploy's fees from somewhere
# else.
#
# If the repo stays private (so `verify` cannot run), run `solana-verify
# build -- --features mainnet` (this script already does) plus `solana-verify
# get-executable-hash` locally and publish the hash instead of the OtterSec
# job.
set -euo pipefail

. "$(dirname "$0")/lib/redact.sh"

usage() {
  echo "usage: $0 <dev|devnew|staging|mainnet> [--upgrade] [--dry-run] [--idl]" >&2
  echo "       $0 <dev|devnew|staging|mainnet> verify" >&2
  echo "       $0 mainnet handover" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
env_name="$1"
shift

upgrade=0
dry_run=0
action="deploy"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upgrade) upgrade=1 ;;
    --dry-run) dry_run=1 ;;
    --idl) action="idl" ;;
    verify) action="verify" ;;
    handover) action="handover" ;;
    *) usage ;;
  esac
  shift
done

case "$env_name" in
  dev | devnew | staging | mainnet) ;;
  *) usage ;;
esac
if [ "$action" = "handover" ] && [ "$env_name" != "mainnet" ]; then
  usage
fi

# --- 1. env -> feature, keypair, cluster --------------------------------
feature=""
keypair="keys/hex_vault-$env_name-keypair.json"
# The public devnet endpoint drops buffer writes under load ("Blockhash
# expired", "N write transactions failed"); DEPLOY_RPC_URL points devnet
# deploys at a keyed RPC instead. Mainnet reads RPC_URL from .env.mainnet.
cluster="${DEPLOY_RPC_URL:-devnet}"
# What gets printed. The URL itself carries the provider key, so it is never
# echoed; these are also valid --url monikers for a copy-pasted recovery command.
cluster_name="devnet"

if [ "$env_name" = "staging" ] || [ "$env_name" = "devnew" ]; then
  feature="$env_name"
elif [ "$env_name" = "mainnet" ]; then
  feature="mainnet"
  cluster_name="mainnet-beta"
  mainnet_env=".env.mainnet"
  if [ ! -f "$mainnet_env" ]; then
    echo "deploy: $mainnet_env is missing; copy .env.mainnet.example and fill in RPC_URL" >&2
    exit 1
  fi
  cluster=$(grep -E '^RPC_URL=' "$mainnet_env" | tail -1 | cut -d= -f2-)
  if [ -z "$cluster" ]; then
    echo "deploy: RPC_URL is empty in $mainnet_env" >&2
    exit 1
  fi
  # DEPLOY_KEYPAIR (written by scripts/mainnet-keys.sh) is the deployer file.
  # The solana CLI has no env var for its keypair, so point its config at the
  # file once; every solana call below then signs with it.
  deploy_keypair=$(grep -E '^DEPLOY_KEYPAIR=' "$mainnet_env" | tail -1 | cut -d= -f2-)
  if [ -n "$deploy_keypair" ]; then
    if [ ! -f "$deploy_keypair" ]; then
      echo "deploy: DEPLOY_KEYPAIR=$deploy_keypair in $mainnet_env does not exist" >&2
      exit 1
    fi
    solana config set --keypair "$deploy_keypair" >/dev/null
    echo "==> signing as $(solana address) (DEPLOY_KEYPAIR from $mainnet_env)"
  fi
fi

if [ ! -f "$keypair" ]; then
  echo "deploy: $keypair is missing" >&2
  exit 1
fi
keypair_pubkey=$(solana-keygen pubkey "$keypair")

# --- verify: solana-verify against the current commit, no local build ------
if [ "$action" = "verify" ]; then
  if ! command -v solana-verify >/dev/null 2>&1; then
    echo "deploy: solana-verify is required for verify (cargo install solana-verify)" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "deploy: working tree is dirty; commit or stash before verify" >&2
    exit 1
  fi
  commit_sha=$(git rev-parse HEAD)
  repo_url="${VERIFY_REPO_URL:-$(git config --get remote.origin.url)}"
  case "$repo_url" in
    git@*) repo_url=$(printf '%s' "$repo_url" | sed -E 's#^git@([^:]+):(.+)\.git$#https://\1/\2#') ;;
  esac
  echo "==> verifying $keypair_pubkey against $repo_url @ $commit_sha"
  if [ -n "$feature" ]; then
    set -- -- --features "$feature"
  else
    set --
  fi
  solana-verify verify-from-repo --url "$cluster" --program-id "$keypair_pubkey" \
    "$repo_url" --commit-hash "$commit_sha" "$@"
  # remote submit-job takes only --program-id and --uploader (no cargo args, no
  # cluster: the OtterSec job runs against mainnet). The uploader is the
  # address of the authority that uploaded the program.
  if [ "$env_name" != "mainnet" ]; then
    echo "==> skipping remote submit-job: OtterSec verifies mainnet programs only"
  else
    uploader="${VERIFY_UPLOADER:-}"
    if [ -z "$uploader" ]; then
      uploader=$(solana program show "$keypair_pubkey" --url "$cluster" --output json \
        | grep -m1 '"authority"' | sed -E 's/.*"authority": *"?([^",}]+)"?.*/\1/')
    fi
    if [ -z "$uploader" ] || [ "$uploader" = "none" ]; then
      echo "deploy: no uploader: set VERIFY_UPLOADER to the upgrade authority address" >&2
      exit 1
    fi
    solana-verify remote submit-job --program-id "$keypair_pubkey" --uploader "$uploader"
  fi
  exit 0
fi

# The program's on-chain upgrade authority; empty when not deployed yet.
current_authority() {
  solana program show "$keypair_pubkey" --url "$cluster" --output json 2>/dev/null \
    | grep -m1 '"authority"' | sed -E 's/.*"authority": *"?([^",}]+)"?.*/\1/'
}
# Mainnet: the Ledger signs the deploy/IDL only once it holds the upgrade
# authority (after `handover`). While the configured keypair still holds it,
# that key signs alone and no Ledger is needed.
ledger_holds_authority() {
  [ "$env_name" = "mainnet" ] && [ "$(current_authority)" != "$(solana address)" ]
}

# --- handover: hot key -> Ledger upgrade authority (mainnet, after bootstrap) ---
if [ "$action" = "handover" ]; then
  hot_key=$(solana address)
  current_authority=$(current_authority)
  if [ "$current_authority" != "$hot_key" ]; then
    echo "deploy: upgrade authority is $current_authority, not the hot key $hot_key; nothing to hand over" >&2
    exit 1
  fi
  ledger_pubkey=$(solana-keygen pubkey usb://ledger)
  echo "Program $keypair_pubkey ($cluster_name): upgrade authority $hot_key -> Ledger $ledger_pubkey"
  echo "Only do this once bootstrap has created the pool: create_pool needs the hot key as authority."
  printf 'Type the Ledger pubkey to confirm: '
  read -r confirm
  if [ "$confirm" != "$ledger_pubkey" ]; then
    echo "deploy: confirmation did not match; aborting" >&2
    exit 1
  fi
  # The Ledger signs as the new authority too, which proves it is reachable
  # before the hot key lets go of the program.
  solana program set-upgrade-authority "$keypair_pubkey" --url "$cluster" \
    --new-upgrade-authority usb://ledger
  after=$(current_authority)
  if [ "$after" != "$ledger_pubkey" ]; then
    echo "deploy: upgrade authority is $after, expected $ledger_pubkey" >&2
    exit 1
  fi
  echo "==> upgrade authority is now the Ledger $ledger_pubkey"
  exit 0
fi

# --- 2. build -------------------------------------------------------------
echo "==> building $env_name"
if [ "$env_name" = "mainnet" ] && command -v solana-verify >/dev/null 2>&1; then
  solana-verify build -- --features mainnet
  # solana-verify builds only the .so; target/idl keeps whatever the last
  # `anchor build` wrote, usually the dev id. Regenerate it under the same
  # feature so step 4's id check and --idl publish read this build, not that
  # one (mainnet readiness 2026-09-28, blocker 3).
  anchor idl build -o target/idl/hex_vault.json -t target/types/hex_vault.ts -- --features mainnet
elif [ -n "$feature" ]; then
  # Without solana-verify a mainnet build is a plain anchor build: deployable,
  # but not reproducible, so `verify` and a published hash mean little.
  [ "$env_name" = "mainnet" ] && echo "==> solana-verify not installed, plain anchor build (not reproducible)"
  anchor build -- --features "$feature"
else
  anchor build
fi

so_path="target/deploy/hex_vault.so"
idl_path="target/idl/hex_vault.json"

# --- 3. refuse a test-vrf or test-venue artifact ---------------------------
sh scripts/check-deployable.sh "$so_path"

# --- 4. keypair must match this build's declare_id! ------------------------
idl_address=$(grep -m1 '"address"' "$idl_path" | sed -E 's/.*"address": *"([^"]+)".*/\1/')
if [ "$idl_address" != "$keypair_pubkey" ]; then
  echo "deploy: $keypair ($keypair_pubkey) does not match this build's declare_id! ($idl_address)" >&2
  exit 1
fi
# The IDL can be stale (solana-verify builds only the .so), so also look for
# the program id's 32 bytes in the binary itself. declare_id! compiles into it.
id_hex=$(tr -d '[:space:][]' <"$keypair" | tr ',' '\n' | tail -n 32 | awk '{printf "%02x", $1}')
if [ "${#id_hex}" -ne 64 ]; then
  echo "deploy: could not read the 32 byte public key out of $keypair" >&2
  exit 1
fi
# Read whole, not piped into grep -q: under pipefail, grep exiting at the match
# can SIGPIPE od and read as "not found".
so_hex=$(od -An -v -tx1 "$so_path" | tr -d ' \n')
case "$so_hex" in
  *"$id_hex"*) ;;
  *)
    echo "deploy: $so_path does not contain program id $keypair_pubkey; it was built for another id" >&2
    exit 1
    ;;
esac
echo "==> $env_name program id $keypair_pubkey matches the build (IDL and binary)"

# --- --idl: publish the freshly built IDL on chain, no deploy --------------
if [ "$action" = "idl" ]; then
  # Anchor otherwise reads Anchor.toml's wallet (~/.config/solana/id.json),
  # which is not the upgrade authority; the solana CLI keypair is (the
  # mainnet branch above points it at DEPLOY_KEYPAIR).
  idl_wallet=$(solana config get keypair | awk '{print $NF}')
  if ledger_holds_authority; then
    idl_wallet="usb://ledger"
  fi

  idl_tmp=$(mktemp)
  idl_exists=0
  if anchor idl fetch "$keypair_pubkey" --provider.cluster "$cluster" -o "$idl_tmp" >/dev/null 2>&1; then
    idl_exists=1
  fi
  rm -f "$idl_tmp"

  if [ "$idl_exists" -eq 1 ]; then
    idl_verb="upgrade"
  else
    idl_verb="init"
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "[dry-run] would run: anchor idl $idl_verb -f $idl_path --provider.cluster $cluster_name${idl_wallet:+ --provider.wallet $idl_wallet} $keypair_pubkey"
    exit 0
  fi

  if [ -n "$idl_wallet" ]; then
    set -- --provider.wallet "$idl_wallet"
  else
    set --
  fi
  echo "==> anchor idl $idl_verb for $keypair_pubkey"
  anchor idl "$idl_verb" -f "$idl_path" --provider.cluster "$cluster" "$@" "$keypair_pubkey"
  echo "==> syncing IDL"
  pnpm --filter @hexvault/web sync-idl
  pnpm --filter @hexvault/backend sync-idl
  exit 0
fi

# --- 5. on upgrade, check ProgramData has room for the new build -----------
if [ "$upgrade" -eq 1 ]; then
  echo "==> checking ProgramData size for $keypair_pubkey on $cluster_name"
  current_len=""
  if show_json=$(solana program show "$keypair_pubkey" --url "$cluster" --output json 2>/dev/null); then
    current_len=$(printf '%s' "$show_json" | grep -m1 '"dataLen"' | sed -E 's/[^0-9]*([0-9]+).*/\1/')
  fi
  so_size=$(wc -c <"$so_path" | tr -d ' ')
  # UpgradeableLoaderState::ProgramData header: 4-byte enum tag + 8-byte slot
  # + 1-byte Option tag + 32-byte upgrade authority pubkey = 45 bytes.
  required_len=$((so_size + 45))
  if [ -z "$current_len" ]; then
    echo "deploy: could not read ProgramData size for $keypair_pubkey on $cluster_name (not deployed yet?)" >&2
  elif [ "$required_len" -gt "$current_len" ]; then
    extend_by=$((required_len - current_len))
    echo "ProgramData is $current_len bytes; the new build needs $required_len bytes."
    echo "  solana program extend $keypair_pubkey $extend_by --url $cluster_name"
    if [ "$dry_run" -eq 1 ]; then
      echo "[dry-run] not prompting; not running the extend"
    else
      printf 'Run this extend now? [y/N] '
      read -r reply
      case "$reply" in
        y | Y) solana program extend "$keypair_pubkey" "$extend_by" --url "$cluster" ;;
        *) echo "deploy: skipped the extend; deploy still auto-extends if it is short" ;;
      esac
    fi
  else
    echo "ProgramData is $current_len bytes; the new build needs $required_len bytes. No extend needed."
  fi
fi

# --- 6. write-buffer, then deploy (deploy also covers upgrades) -----------
cu_price="${DEPLOY_CU_PRICE:-100000}"
hot_key=$(solana address)
# Mainnet: the deployer writes the buffer (the Ledger would sign each ~1 KB
# chunk) and stays upgrade authority so bootstrap's create_pool works. Only an
# upgrade after `handover` hands the buffer to the Ledger, which then signs
# the one deploy.
ledger_deploy=0
if [ "$upgrade" -eq 1 ] && ledger_holds_authority; then
  ledger_deploy=1
fi

if [ "$dry_run" -eq 1 ]; then
  echo "[dry-run] would run:"
  if [ "$env_name" = "mainnet" ]; then
    echo "  solana program write-buffer $so_path --url $cluster_name --with-compute-unit-price $cu_price --max-sign-attempts 50 --use-rpc"
    if [ "$ledger_deploy" -eq 1 ]; then
      echo "  solana program set-buffer-authority <buffer> --new-buffer-authority <ledger pubkey> --url $cluster_name"
      echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster_name --with-compute-unit-price $cu_price --max-sign-attempts 50 --use-rpc --upgrade-authority usb://ledger${FEE_PAYER_KEYPAIR:+ --fee-payer $FEE_PAYER_KEYPAIR}"
    else
      echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster_name --with-compute-unit-price $cu_price --max-sign-attempts 50 --use-rpc   (hot key stays upgrade authority until: $0 mainnet handover)"
    fi
  else
    echo "  solana program write-buffer $so_path --url $cluster_name --with-compute-unit-price $cu_price --max-sign-attempts 50"
    echo "  solana program deploy --buffer <buffer> --program-id $keypair --url $cluster_name --with-compute-unit-price $cu_price --max-sign-attempts 50"
  fi
  echo "[dry-run] would then check for stray buffers, assert the upgrade authority, and run: pnpm --filter @hexvault/web sync-idl && pnpm --filter @hexvault/backend sync-idl"
  exit 0
fi

if [ "$env_name" = "mainnet" ]; then
  printf 'Type the mainnet program id to confirm (%s): ' "$keypair_pubkey"
  read -r confirm
  if [ "$confirm" != "$keypair_pubkey" ]; then
    echo "deploy: confirmation did not match; aborting" >&2
    exit 1
  fi
  if [ "$ledger_deploy" -eq 1 ]; then
    ledger_pubkey=$(solana-keygen pubkey usb://ledger)
    expected_authority="$ledger_pubkey"
  else
    expected_authority="$hot_key"
  fi
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50 --use-rpc
else
  expected_authority="$hot_key"
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50
fi

echo "==> writing buffer"
buffer_output=$(solana program write-buffer "$so_path" --url "$cluster" "$@")
printf '%s\n' "$buffer_output" | redact
buffer_pubkey=$(printf '%s\n' "$buffer_output" | sed -n 's/^Buffer: //p' | head -1)
if [ -z "$buffer_pubkey" ]; then
  echo "deploy: could not parse the buffer pubkey from write-buffer output" >&2
  exit 1
fi

# A stranded buffer still pays rent to nobody in particular. If anything from
# here to the end of the deploy fails, print exactly how to reclaim it.
buffer_authority_flag=""
buffer_trap() {
  echo "deploy: a later step failed; recover the buffer with:" >&2
  echo "  solana program close $buffer_pubkey --bypass-warning --url $cluster_name${buffer_authority_flag}" >&2
  echo "  (recipient defaults to whichever keypair runs that command; pass --recipient <address> to send the rent elsewhere)" >&2
}
trap buffer_trap ERR

if [ "$ledger_deploy" -eq 1 ]; then
  echo "==> handing the buffer to the Ledger $ledger_pubkey"
  solana program set-buffer-authority "$buffer_pubkey" --url "$cluster" \
    --new-buffer-authority "$ledger_pubkey"
  buffer_authority_flag=" --buffer-authority usb://ledger"
  set -- --with-compute-unit-price "$cu_price" --max-sign-attempts 50 --use-rpc --upgrade-authority usb://ledger
  if [ -n "${FEE_PAYER_KEYPAIR:-}" ]; then
    set -- "$@" --fee-payer "$FEE_PAYER_KEYPAIR"
  fi
fi

echo "==> deploying (buffer $buffer_pubkey)"
solana program deploy --buffer "$buffer_pubkey" --program-id "$keypair" --url "$cluster" "$@"

trap - ERR

# --- 7. buffer and authority checks, then report and sync both apps' IDL ---
show_json=$(solana program show "$keypair_pubkey" --url "$cluster" --output json)
printf '%s\n' "$show_json" | redact

actual_authority=$(printf '%s' "$show_json" | grep -m1 '"authority"' | sed -E 's/.*"authority": *"?([^",}]+)"?.*/\1/')
if [ "$actual_authority" != "$expected_authority" ]; then
  echo "deploy: upgrade authority is $actual_authority, expected $expected_authority for $env_name" >&2
  exit 1
fi
echo "==> upgrade authority $actual_authority matches $env_name"

# The RPC's account index lags the deploy by a few seconds, so the buffer the
# deploy just consumed can still show up. Re-check before calling it stray.
for attempt in 1 2 3 4 5 6; do
  buffers_json=$(solana program show --buffers --buffer-authority "$expected_authority" --url "$cluster" --output json)
  [ "$(printf '%s' "$buffers_json" | tr -d '[:space:]')" = '{"buffers":[]}' ] && break
  [ "$attempt" -lt 6 ] && sleep 5
done
if [ "$(printf '%s' "$buffers_json" | tr -d '[:space:]')" != '{"buffers":[]}' ]; then
  echo "$buffers_json" >&2
  echo "deploy: buffer(s) left under $expected_authority; close them:" >&2
  echo "  solana program close <buffer> --bypass-warning --url $cluster_name" >&2
  exit 1
fi
echo "==> no stray buffers under $expected_authority"

echo "==> syncing IDL"
pnpm --filter @hexvault/web sync-idl
pnpm --filter @hexvault/backend sync-idl
