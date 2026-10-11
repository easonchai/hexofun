#!/usr/bin/env bash
# Makes the two mainnet launch keys once and wires them into .env.mainnet, so
# `scripts/deploy.sh mainnet` and bootstrap sign with the right one without
# anyone converting keypairs by hand. Run from the repo root:
#
#   scripts/mainnet-keys.sh            # deployer and operator, both freshly generated
#   scripts/mainnet-keys.sh import     # deployer from a wallet's exported base58 secret (Phantom etc.), operator generated
#   scripts/mainnet-keys.sh spare      # a spare operator for a later set-operator
#   scripts/mainnet-keys.sh admin      # a generated admin (C); writes ADMIN_ADDRESS, prints the base58 for a Phantom import
#
# The deployer (keys/hexvault-mainnet-deployer.json) deploys the program, stays
# its upgrade authority and pays the pool's creation; it goes into .env.mainnet
# as DEPLOY_KEYPAIR (the file, what deploy.sh and bootstrap read) and becomes
# the solana CLI's configured keypair. Its secret never leaves the laptop. The
# operator (keys/hexvault-mainnet-operator.json) cranks the pool from the VPS
# and goes in as OPERATOR_KEYPAIR (base58, what the backend reads). The spare
# is only created; its base58 is printed for the password manager, nothing is
# written to the env file. Keypair files live under keys/, which is gitignored.
set -euo pipefail

env_file=.env.mainnet
mode="${1:-launch}"
case "$mode" in
  launch | import | spare | admin) ;;
  *) echo "usage: $0 [launch|import|spare|admin]" >&2; exit 1 ;;
esac
mkdir -p keys

# ensure_key <file> [import]: reuse, import from a pasted base58 secret, or generate.
ensure_key() {
  if [ -f "$1" ]; then
    echo "==> reusing $1"
  elif [ "${2:-}" = "import" ]; then
    # Wallets export the secret as base58; the solana CLI wants the JSON byte
    # array. Read it without echo and never print it.
    printf 'Paste the wallet'"'"'s exported private key (base58, not shown): '
    read -rs secret; echo
    # Over stdin, not argv, so the secret never shows in `ps`.
    key_abs="$PWD/$1"
    printf '%s' "$secret" | (cd apps/backend && node -e '
const bs58 = require("bs58");
const bytes = bs58.default.decode(require("fs").readFileSync(0, "utf8").trim());
if (bytes.length !== 64) throw new Error(`expected a 64 byte secret key, got ${bytes.length} bytes`);
require("fs").writeFileSync(process.argv[1], JSON.stringify(Array.from(bytes)));
' "$key_abs")
    chmod 600 "$1"
    echo "==> imported into $1"
  else
    solana-keygen new --no-bip39-passphrase -s -o "$1"
    echo "==> created $1"
  fi
}
# The backend wants the base58 secret; solana-keygen only writes the JSON
# byte array. bs58 is a backend dependency, so run node from there.
base58_of() {
  key_abs="$PWD/$1"
  (cd apps/backend && node -e '
const bs58 = require("bs58");
const bytes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(bs58.default.encode(Buffer.from(bytes)));
' "$key_abs")
}

if [ "$mode" = "spare" ]; then
  key="keys/hexvault-mainnet-operator-spare.json"
  ensure_key "$key"
  pubkey=$(solana-keygen pubkey "$key")
  echo "spare operator: $pubkey"
  echo "Fund it with 2 SOL and create its USDC account before any set-operator:"
  echo "  solana transfer $pubkey 2 --allow-unfunded-recipient"
  echo "  spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner $pubkey"
  echo "Store this base58 secret in the password manager (it is OPERATOR_KEYPAIR after a rotation):"
  echo "  $(base58_of "$key")"
  exit 0
fi

[ -f "$env_file" ] || cp .env.mainnet.example "$env_file"
set_kv() {
  if grep -q "^$1=" "$env_file"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$env_file" && rm -f "$env_file.bak"
  else
    printf '%s=%s\n' "$1" "$2" >>"$env_file"
  fi
}

if [ "$mode" = "admin" ]; then
  key="keys/hexvault-mainnet-admin.json"
  ensure_key "$key"
  pubkey=$(solana-keygen pubkey "$key")
  set_kv ADMIN_ADDRESS "$pubkey"
  echo "admin: $pubkey   (ADMIN_ADDRESS written; owns Treasury and Buyback, signs Start and Pause on /ops)"
  echo "It needs no SOL until the first Start; send it 0.1 SOL then. To use /ops, import this base58"
  echo "secret into Phantom (Add account, Import private key) and keep it in the password manager:"
  echo "  $(base58_of "$key")"
  exit 0
fi

deployer="keys/hexvault-mainnet-deployer.json"
operator="keys/hexvault-mainnet-operator.json"
ensure_key "$deployer" "$mode"
ensure_key "$operator"
deployer_pubkey=$(solana-keygen pubkey "$deployer")
operator_pubkey=$(solana-keygen pubkey "$operator")

# Into a variable first: a failure inside `$(...)` on the set_kv line would
# write an empty OPERATOR_KEYPAIR and keep going.
operator_base58=$(base58_of "$operator")
set_kv DEPLOY_KEYPAIR "$deployer"
set_kv OPERATOR_KEYPAIR "$operator_base58"
solana config set --keypair "$deployer" --url mainnet-beta >/dev/null

echo "deployer: $deployer_pubkey   (DEPLOY_KEYPAIR, upgrade authority, pays the deploy and the pool; solana CLI now signs with it)"
echo "operator: $operator_pubkey   (OPERATOR_KEYPAIR, the only secret that goes to the VPS)"
echo "Back up both files and keys/hex_vault-mainnet-keypair.json offline, then fund them:"
echo "  solana transfer $deployer_pubkey 5 --from <funded wallet> --allow-unfunded-recipient"
echo "  solana transfer $operator_pubkey 2 --from <funded wallet> --allow-unfunded-recipient"
echo "(rent for the ~820 KB binary is about 4.3 SOL and stays locked in the program; the operator's 2 SOL pays crank fees)"
