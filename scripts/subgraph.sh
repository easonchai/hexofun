#!/bin/sh
set -eu

# The `hexo` subgraph on Solami Index (runbook.md, "Subgraph"). Mainnet only.
#
#   scripts/subgraph.sh build              codegen from the IDL, wasm release build, base64 to subgraph/target/
#   scripts/subgraph.sh deploy [--dry-run] build, render subgraph.yaml, POST manifest + schema + wasm to /index/hexo
#   scripts/subgraph.sh redeploy-wasm      build, POST the wasm alone: mapping-only fixes, no reindex
#   scripts/subgraph.sh status             GET /index/hexo: status and synced_slot
#   scripts/subgraph.sh logs               GET /index/hexo/logs
#
# Env, read from .env.solami (gitignored by the .env.* rule; copy
# .env.solami.example): SOLAMI_API_KEY (every call to Solami),
# SUBGRAPH_PROGRAM_ID (build: the mapping only reads that program's
# instructions; deploy: the manifest), SUBGRAPH_START_SLOT (deploy).
# `deploy --dry-run` writes and checks the request body without the key or a
# network call. The key goes to curl on stdin, never in argv, and every
# response passes through redact.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root/.env.solami"
crate="$root/subgraph"
out="$crate/target"
wasm="$out/wasm32-unknown-unknown/release/hexo_subgraph.wasm"
b64="$out/hexo.wasm.b64"
body="$out/deploy.json"
api=https://api.solami.dev/index/hexo

die() { echo "subgraph: $*" >&2; exit 1; }

. "$root/scripts/lib/redact.sh"

load_env() {
  [ -f "$env_file" ] || die ".env.solami missing; copy .env.solami.example and fill it in"
  set -a
  . "$env_file"
  set +a
}

need() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || die "$name is not set in .env.solami"
  done
}

# Drops the key itself from a response, then anything after a URL's host.
scrub() {
  awk '{
    k = ENVIRON["SOLAMI_API_KEY"]
    while (k != "" && (i = index($0, k)) > 0) $0 = substr($0, 1, i - 1) "<redacted>" substr($0, i + length(k))
    print
  }' | redact
}

# api <method> <path> [body-file]: prints the redacted response, fails on non-2xx.
api() {
  need SOLAMI_API_KEY
  resp="$out/response.txt"
  mkdir -p "$out"
  set -- "$1" "$api$2" "${3:-}"
  if [ -n "$3" ]; then
    code=$(printf 'Authorization: Bearer %s\n' "$SOLAMI_API_KEY" | curl -sS --max-time 120 -X "$1" "$2" \
      -H @- -H 'content-type: application/json' --data-binary "@$3" -o "$resp" -w '%{http_code}')
  else
    code=$(printf 'Authorization: Bearer %s\n' "$SOLAMI_API_KEY" | curl -sS --max-time 30 -X "$1" "$2" \
      -H @- -o "$resp" -w '%{http_code}')
  fi
  case "$code" in
    2??) ;;
    *) echo "subgraph: $1 ${2#https://api.solami.dev} answered $code" >&2; scrub <"$resp" >&2; echo >&2; exit 1 ;;
  esac
}

build() {
  [ -f "$env_file" ] && load_env
  need SUBGRAPH_PROGRAM_ID
  node "$root/scripts/subgraph-codegen.mjs"
  # The program id is compiled in (env! in src/lib.rs), so cargo rebuilds when it changes.
  cargo build --release --target wasm32-unknown-unknown --manifest-path "$crate/Cargo.toml"
  node -e '
const fs = require("node:fs");
const [wasm, b64] = process.argv.slice(1);
fs.writeFileSync(b64, fs.readFileSync(wasm).toString("base64"));
' "$wasm" "$b64"
  echo "subgraph: $(wc -c <"$wasm" | tr -d ' ') byte wasm for $SUBGRAPH_PROGRAM_ID"
}

# write_body full|wasm: the JSON request, built by node so the YAML's newlines
# are escaped (a pasted YAML gets 400 control character found).
write_body() {
  node -e '
const fs = require("node:fs");
const [mode, crate, b64, body] = process.argv.slice(1);
const fail = (m) => { console.error("subgraph: " + m); process.exit(1); };
const wasm = fs.readFileSync(b64, "utf8");
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wasm) || Buffer.from(wasm, "base64").subarray(0, 4).toString("hex") !== "0061736d")
  fail("subgraph/target/hexo.wasm.b64 is not a base64 wasm module");
const out = { wasm_base64: wasm };
if (mode === "full") {
  const { SUBGRAPH_PROGRAM_ID: program, SUBGRAPH_START_SLOT: slot } = process.env;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(program)) fail("SUBGRAPH_PROGRAM_ID is not a base58 pubkey");
  if (!/^[0-9]+$/.test(slot)) fail("SUBGRAPH_START_SLOT is not a slot number");
  out.manifest = fs.readFileSync(crate + "/subgraph.yaml", "utf8")
    .replace("__SUBGRAPH_PROGRAM_ID__", program).replace("__SUBGRAPH_START_SLOT__", slot);
  if (/__SUBGRAPH_\w+__/.test(out.manifest)) fail("subgraph.yaml has a placeholder this script does not fill");
  out.schema = fs.readFileSync(crate + "/schema.graphql", "utf8");
}
fs.writeFileSync(body, JSON.stringify(out));
' "$1" "$crate" "$b64" "$body"
}

command="${1:-}"
[ "$#" -gt 0 ] && shift
case "$command" in
  build) build ;;
  deploy)
    dry=""
    [ "${1:-}" = --dry-run ] && dry=1
    build
    need SUBGRAPH_START_SLOT
    write_body full
    if [ -n "$dry" ]; then
      echo "subgraph: dry run, request body checked at ${body#"$root"/}; nothing sent"
      exit 0
    fi
    api POST "" "$body"
    scrub <"$resp"; echo ;;
  redeploy-wasm)
    build
    write_body wasm
    api POST "" "$body"
    scrub <"$resp"; echo ;;
  status)
    load_env
    api GET ""
    node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
console.log(`status ${r.status} synced_slot ${r.synced_slot} version ${r.current_version}`);
if (r.last_error) console.log(`last_error ${r.last_error}`);
' "$resp" | scrub ;;
  logs)
    load_env
    api GET /logs
    scrub <"$resp"; echo ;;
  *) die "unknown command '$command'; build | deploy [--dry-run] | redeploy-wasm | status | logs" ;;
esac
