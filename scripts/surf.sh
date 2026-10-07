#!/bin/sh
set -eu

# Long-running Surfpool mainnet fork you poke at by hand. Deploys the plain
# (mainnet-shaped) build, bootstraps Pool 1 on Kamino's real USDC reserve,
# funds the roles with forked USDC and SOL, writes .env.surf (backend compose)
# and apps/web/.env.surf, then stays in the foreground until Ctrl-C.
# tests/fork/surf.ts fakes ORAO fulfilment so rounds and draws settle.
#
#   scripts/surf.sh up                     fresh fork: wipes .surf/ state and the hexvault-surf compose volume
#   scripts/surf.sh up --resume            reuse .surf/state.sqlite, skip build, deploy and bootstrap
#   scripts/surf.sh fund <pubkey> [usdc] [sol]
#   scripts/surf.sh warp <seconds>
#   scripts/surf.sh warp-epoch [minutes-before-end]   default 8, inside the harvest window
#   scripts/surf.sh vrf on|off             pause the fake fulfiller to test timeouts
#   scripts/surf.sh admin <cmd> [flags]    admin CLI, signed by keys/surf/admin.json
#   scripts/surf.sh web [vite flags]       web dev server against the fork (vite --mode surf)
#   scripts/surf.sh logs [fork|simnet|vrf|relay|backend] [lines]   default fork 100; backend drops Nest boot noise
#
# Env: HEXVAULT_FORK_DATASOURCE (keyed mainnet RPC; Surfpool only sees the
# local relay in front of it, tests/fork/relay.mjs),
# SURF_PORT (default 9499, websocket +1, studio +2, relay +3), HEXVAULT_SKIP_BUILD=1,
# HEXVAULT_FORK_OFFLINE=1 (up --resume only: no datasource, so a hung remote
# fetch can never freeze the fork for its 30s timeout),
# HEXVAULT_FORK_LOG_LEVEL (Surfpool's simnet log level, default info; debug
# logs each datasource request; read it with `logs simnet`).
# Keys live in keys/surf/ and survive every mode. The fork reports mainnet's
# genesis hash, so bootstrap, the backend and the web all treat it as mainnet.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
port="${SURF_PORT:-9499}"
rpc="http://127.0.0.1:$port"
relay_port=$((port + 3))
relay_url="http://127.0.0.1:$relay_port"
surf_dir="$root/.surf"
keys="$root/keys/surf"
wallet="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
env_file="$root/.env.surf"
web_env="$root/apps/web/.env.surf"
idl="$surf_dir/hex_vault.json"
usdc=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
token_program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
# Kamino main market USDC reserve, its liquidity supply and cToken mint
# (tests/fork/klend.fork.ts). Reset together so the fork holds one snapshot.
klend_accounts="D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59 Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6 B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"

die() { echo "surf: $*" >&2; exit 1; }

. "$root/scripts/lib/redact.sh"

rpc_call() {
  out=$(curl -sS --max-time 30 "$rpc" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}")
  case "$out" in *'"error"'*) die "$1: $out" ;; esac
}

fork_up() { solana --url "$rpc" cluster-version >/dev/null 2>&1; }

# Any HTTP answer, even the relay's 405 to a GET, means it is listening.
relay_up() { curl -s -o /dev/null --max-time 1 "$relay_url"; }

keypair() {
  [ -f "$keys/$1.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$keys/$1.json" >/dev/null
  solana-keygen pubkey "$keys/$1.json"
}

base58_secret() {
  (cd "$root" && node -e "
const { utils } = require('@anchor-lang/core');
const secret = JSON.parse(require('node:fs').readFileSync('$1', 'utf8'));
process.stdout.write(utils.bytes.bs58.encode(Uint8Array.from(secret)));
")
}

fund() {
  pk="$1"; amount_usdc="${2:-10000}"; sol="${3:-10}"
  [ "$sol" = 0 ] || solana --url "$rpc" airdrop "$sol" "$pk" --keypair "$wallet" >/dev/null
  rpc_call surfnet_setTokenAccount \
    "[\"$pk\",\"$usdc\",{\"amount\":$((amount_usdc * 1000000))},\"$token_program\"]"
  echo "funded $pk: $amount_usdc USDC, +$sol SOL"
}

surf_ts() {
  (cd "$root" && SURF_RPC="$rpc" SURF_DIR="$surf_dir" HEXVAULT_IDL_PATH="$idl" \
    exec "$root/node_modules/.bin/tsx" tests/fork/surf.ts "$@")
}

compose() {
  docker compose -p hexvault-surf --env-file "$env_file" -f "$root/docker-compose.dev.yml" "$@"
}

start_surfpool() {
  datasource="${HEXVAULT_FORK_DATASOURCE:-}"
  # Offline only on resume: bootstrap needs remote accounts a fresh fork lacks.
  offline=""
  if [ "${HEXVAULT_FORK_OFFLINE:-}" = 1 ]; then
    [ "$1" = resume ] || die "HEXVAULT_FORK_OFFLINE=1 needs up --resume; a fresh fork must fetch mainnet accounts"
    offline=--offline
    datasource=""
    echo "surf: offline, no datasource; a transaction touching an account the fork never fetched fails" >&2
  elif [ -z "$datasource" ]; then
    echo "surf: HEXVAULT_FORK_DATASOURCE unset, forking through the public mainnet RPC (slow, rate-limited)" >&2
    datasource=https://api.mainnet-beta.solana.com
  fi
  # Surfpool talks to the datasource through tests/fork/relay.mjs, which never
  # reuses a connection the network may have dropped (a 30s fork freeze).
  if [ -n "$datasource" ]; then
    relay_up && die "something already answers on $relay_url; stop it or set SURF_PORT"
    HEXVAULT_FORK_DATASOURCE="$datasource" node "$root/tests/fork/relay.mjs" "$relay_port" \
      >>"$surf_dir/relay.log" 2>&1 &
    relay_pid=$!
    until relay_up; do
      kill -0 "$relay_pid" 2>/dev/null || die "relay exited; see .surf/relay.log"
      sleep 0.2
    done
    datasource="$relay_url"
  fi
  # Surfpool writes .surfpool/ into its working directory, so run it in .surf/.
  # The datasource goes in by environment so a keyed URL never shows in `ps`.
  # Surfpool prints the full datasource URL in fetch errors, so its output goes
  # through redact on a FIFO; a plain pipe would make $! the filter's pid.
  fifo="$surf_dir/surfpool.fifo"
  rm -f "$fifo" && mkfifo "$fifo"
  redact <"$fifo" >>"$surf_dir/surfpool.log" &
  (
    cd "$surf_dir"
    if [ -n "$datasource" ]; then
      export SURFPOOL_DATASOURCE_RPC_URL="$datasource"
    else
      unset SURFPOOL_DATASOURCE_RPC_URL
    fi
    # $offline is unquoted on purpose: empty means no flag at all.
    # shellcheck disable=SC2086
    exec surfpool start $offline --log-level "${HEXVAULT_FORK_LOG_LEVEL:-info}" \
      --port "$port" --ws-port $((port + 1)) --studio-port $((port + 2)) \
      --db "$surf_dir/state.sqlite" --no-tui --no-deploy -y
  ) >"$fifo" 2>&1 &
  surfpool_pid=$!
  for _ in $(seq 1 90); do
    fork_up && return 0
    kill -0 "$surfpool_pid" 2>/dev/null || die "surfpool exited; see .surf/surfpool.log"
    sleep 1
  done
  die "surfpool did not answer on $rpc within 90s; see .surf/surfpool.log"
}

cleanup() {
  # Surfpool ignores SIGTERM.
  kill -9 "${surfpool_pid:-}" 2>/dev/null || true
  kill "${vrf_pid:-}" "${relay_pid:-}" 2>/dev/null || true
  wait "${surfpool_pid:-}" "${vrf_pid:-}" "${relay_pid:-}" 2>/dev/null || true
  rm -f "$surf_dir/surfpool.fifo"
  # Surfpool's own simnet logs carry the keyed URL too and cannot be piped, so
  # they are scrubbed once it stops; `logs simnet` redacts them while it runs.
  for log in "$surf_dir"/.surfpool/logs/*.log; do
    [ -f "$log" ] && redact <"$log" >"$log.tmp" && mv "$log.tmp" "$log"
  done
}

build() {
  if [ "${HEXVAULT_SKIP_BUILD:-}" != "1" ]; then
    (cd "$root" && anchor build)
  fi
  sh "$root/scripts/check-deployable.sh" "$root/target/deploy/hex_vault.so"
  program_id=$(node -e "process.stdout.write(require('$root/target/idl/hex_vault.json').address)")
  [ "$(solana-keygen pubkey "$root/target/deploy/hex_vault-keypair.json")" = "$program_id" ] \
    || die "target/deploy/hex_vault-keypair.json does not match the IDL address $program_id"
  cp "$root/target/idl/hex_vault.json" "$idl"
}

write_env() {
  out="$surf_dir/bootstrap.out"
  value() { sed -n "s/^$1=//p" "$out"; }
  password=$(openssl rand -hex 16)
  umask 077
  cat >"$env_file" <<EOF
# Generated by scripts/surf.sh up on $(date -u +%Y-%m-%dT%H:%M:%SZ). Holds the operator secret.
# docker compose -p hexvault-surf --env-file .env.surf -f docker-compose.dev.yml up -d --build
ENV_FILE=.env.surf
CLUSTER=mainnet-beta
RPC_URL=http://host.docker.internal:$port
PROGRAM_ID=$program_id
POOL_ID=1
ACCEPTED_MINT=$usdc
KLEND_PROGRAM=$(value KLEND_PROGRAM)
KLEND_MARKET=$(value KLEND_MARKET)
KLEND_RESERVE=$(value KLEND_RESERVE)
KLEND_CTOKEN=$(value KLEND_CTOKEN)
OPERATOR_KEYPAIR=$(base58_secret "$keys/operator.json")
ADMIN_ADDRESS=$admin
POSTGRES_USER=hexvault
POSTGRES_PASSWORD=$password
POSTGRES_DB=hexvault_surf
# The host-side URL, for surf.sh admin. Compose overrides it inside the container.
DATABASE_URL=postgresql://hexvault:$password@127.0.0.1:5432/hexvault_surf
CORS_ORIGIN=http://localhost:4173,http://localhost:5173,http://127.0.0.1:4173,http://127.0.0.1:5173
INVITE_ADMIN_KEY=$(openssl rand -hex 24)
PORT=8080
EOF

  privy=$(sed -n 's/^VITE_PRIVY_APP_ID=//p' "$root/apps/web/.env.devnew" 2>/dev/null || true)
  # Set every key .env/.env.local carry, so none of them leaks into --mode surf.
  cat >"$web_env" <<EOF
# Generated by scripts/surf.sh up. vite build --mode surf && vite preview
VITE_CLUSTER=mainnet-beta
VITE_PUBLIC_RPC_URL=$rpc
VITE_API_URL=http://127.0.0.1:8080
VITE_PROGRAM_ID=$program_id
VITE_POOL_ID=1
VITE_ACCEPTED_MINT=$usdc
VITE_BURNER_WALLET=1
VITE_PRIVY_APP_ID=${privy:-off}
VITE_POSTHOG_KEY=
VITE_GATE_GAME=
VITE_GATE_JACKPOT=
EOF
  umask 022
}

up_fresh() {
  build
  if [ -f "$env_file" ]; then
    compose down -v >/dev/null 2>&1 || echo "surf: docker compose down -v failed (docker not running?); stale DB may remain" >&2
  fi
  rm -f "$surf_dir"/state.sqlite* "$surf_dir/vrf-off" "$surf_dir/bootstrap.out" "$surf_dir/chain-time"
  start_surfpool fresh

  solana --url "$rpc" program deploy "$root/target/deploy/hex_vault.so" \
    --program-id "$root/target/deploy/hex_vault-keypair.json" \
    --keypair "$wallet" --upgrade-authority "$wallet" --use-rpc >/dev/null
  echo "deployed $program_id"

  admin=$(keypair admin)
  operator=$(keypair operator)
  player_a=$(keypair player-a)
  player_b=$(keypair player-b)
  treasury=$(keypair treasury-ta)
  buyback=$(keypair buyback-ta)
  fund "$(solana-keygen pubkey "$wallet")" 1000000 0
  fund "$admin" 1000000 100
  fund "$operator" 0 100
  fund "$player_a" 10000 10
  fund "$player_b" 10000 10
  for ta in treasury-ta buyback-ta; do
    spl-token create-account "$usdc" "$keys/$ta.json" --owner "$admin" \
      --fee-payer "$wallet" --url "$rpc" >/dev/null
  done

  # Admin signs (the mainnet guard wants admin != operator); no --start, so the
  # pool comes up jackpot- and game-paused with buy_tickets paused.
  (cd "$root/apps/backend" && \
    OPERATOR_KEYPAIR=$(base58_secret "$keys/admin.json") RPC_URL="$rpc" \
    PROGRAM_ID="$program_id" POOL_ID=1 ACCEPTED_MINT="$usdc" HEXVAULT_IDL_PATH="$idl" \
    pnpm exec tsx src/bootstrap.ts --admin "$admin" --operator "$operator" \
      --treasury "$treasury" --buyback-reserve "$buyback") >"$surf_dir/bootstrap.out"

  for account in $klend_accounts; do
    rpc_call surfnet_resetAccount "[\"$account\"]"
  done

  write_env
  echo
  cat "$surf_dir/bootstrap.out"
}

up_resume() {
  [ -f "$surf_dir/state.sqlite" ] || die "no .surf/state.sqlite to resume; run scripts/surf.sh up"
  [ -f "$env_file" ] && [ -f "$idl" ] || die ".env.surf or .surf/hex_vault.json missing; run scripts/surf.sh up"
  program_id=$(sed -n 's/^PROGRAM_ID=//p' "$env_file")
  start_surfpool resume
  solana --url "$rpc" program show "$program_id" >/dev/null 2>&1 \
    || die "program $program_id is not on the resumed fork; run scripts/surf.sh up"
  # Surfpool restores accounts but restarts the clock at wall time.
  surf_ts restore-clock
  echo "resumed $program_id"
}

up() {
  mkdir -p "$surf_dir" "$keys"
  fork_up && die "something already answers on $rpc; stop it or set SURF_PORT"
  trap cleanup EXIT INT TERM
  if [ "${1:-}" = "--resume" ]; then up_resume; else up_fresh; fi

  # Not through surf_ts: a backgrounded function is its own subshell, and the
  # pid cleanup kills must be tsx itself (tsx relays the signal to its node).
  (cd "$root" && SURF_RPC="$rpc" SURF_DIR="$surf_dir" HEXVAULT_IDL_PATH="$idl" \
    exec "$root/node_modules/.bin/tsx" tests/fork/surf.ts vrf) >>"$surf_dir/vrf.log" 2>&1 &
  vrf_pid=$!

  cat <<EOF

Fork up on $rpc (studio http://127.0.0.1:$((port + 2))). Ctrl-C stops it.
Logs: .surf/surfpool.log, .surf/vrf.log, .surf/relay.log. Keys: keys/surf/.

Backend:  docker compose -p hexvault-surf --env-file .env.surf -f docker-compose.dev.yml up -d --build
Web:      scripts/surf.sh web
Launch:   scripts/surf.sh admin start-jackpot && scripts/surf.sh admin start-game
Logs:     scripts/surf.sh logs fork|simnet|vrf|relay|backend
EOF
  wait "$surfpool_pid"
}

admin_cli() {
  [ -f "$env_file" ] || die ".env.surf missing; run scripts/surf.sh up"
  set -a; . "$env_file"; set +a
  # Swap the admin key in as signer: with ADMIN_ADDRESS equal to the signer the
  # CLI sends instead of printing a multisig transaction.
  OPERATOR_KEYPAIR=$(base58_secret "$keys/admin.json")
  RPC_URL="$rpc" HEXVAULT_IDL_PATH="$idl"
  export OPERATOR_KEYPAIR RPC_URL HEXVAULT_IDL_PATH
  cd "$root/apps/backend" && exec pnpm exec tsx src/admin/main.ts "$@"
}

command="${1:-up}"
[ $# -gt 0 ] && shift
case "$command" in
  up) up "$@" ;;
  fund) [ $# -ge 1 ] || die "usage: fund <pubkey> [usdc] [sol]"; fund "$@" ;;
  warp) surf_ts warp "$@" ;;
  warp-epoch) surf_ts warp-epoch "$@" ;;
  vrf)
    case "${1:-}" in
      off) touch "$surf_dir/vrf-off"; echo "fake VRF paused" ;;
      on) rm -f "$surf_dir/vrf-off"; echo "fake VRF running" ;;
      *) die "usage: vrf on|off" ;;
    esac ;;
  admin) admin_cli "$@" ;;
  web) cd "$root/apps/web" && exec pnpm exec vite --mode surf "$@" ;;
  logs)
    lines="${2:-100}"
    case "${1:-fork}" in
      fork) tail -n "$lines" "$surf_dir/surfpool.log" | redact ;;
      vrf) tail -n "$lines" "$surf_dir/vrf.log" | redact ;;
      relay) tail -n "$lines" "$surf_dir/relay.log" | redact ;;
      simnet) tail -n "$lines" "$(ls -t "$surf_dir"/.surfpool/logs/*.log | head -1)" | redact ;;
      backend) compose logs --no-color --tail "$lines" backend 2>&1 \
        | grep -vE 'RouterExplorer|RoutesResolver|InstanceLoader' | redact ;;
      *) die "usage: logs [fork|simnet|vrf|relay|backend] [lines]" ;;
    esac ;;
  *) die "unknown command $command; up | fund | warp | warp-epoch | vrf | admin | web | logs" ;;
esac
