#!/usr/bin/env bash
# Makes the mainnet deployer/operator hot key once and wires it into
# .env.mainnet, so `scripts/deploy.sh mainnet` and bootstrap sign with the
# same key without anyone converting keypairs by hand. Run from the repo root:
#
#   scripts/mainnet-keys.sh            # the launch key, freshly generated
#   scripts/mainnet-keys.sh import     # the launch key from a wallet's exported base58 secret (Phantom etc.)
#   scripts/mainnet-keys.sh spare      # a spare operator for a later set-operator
#
# The launch key goes into .env.mainnet as OPERATOR_KEYPAIR (base58, what the
# backend reads) and DEPLOY_KEYPAIR (the file, what deploy.sh reads), and
# becomes the solana CLI's configured keypair. The spare is only created and
# funded; its base58 is printed for the password manager, nothing is written
# to the env file. Keypair files live under keys/, which is gitignored.
set -euo pipefail

env_file=.env.mainnet
mode="${1:-launch}"
case "$mode" in
  launch | import) key="keys/hexvault-mainnet-operator.json" ;;
  spare) key="keys/hexvault-mainnet-operator-spare.json" ;;
  *) echo "usage: $0 [launch|import|spare]" >&2; exit 1 ;;
esac

mkdir -p keys
if [ -f "$key" ]; then
  echo "==> reusing $key"
elif [ "$mode" = "import" ]; then
  # Wallets export the secret as base58; the solana CLI wants the JSON byte
  # array. Read it without echo and never print it.
  printf 'Paste the wallet'"'"'s exported private key (base58, not shown): '
  read -rs secret; echo
  key_abs="$PWD/$key"
  # Over stdin, not argv, so the secret never shows in `ps`.
  printf '%s' "$secret" | (cd apps/backend && node -e '
const bs58 = require("bs58");
const bytes = bs58.default.decode(require("fs").readFileSync(0, "utf8").trim());
if (bytes.length !== 64) throw new Error(`expected a 64 byte secret key, got ${bytes.length} bytes`);
require("fs").writeFileSync(process.argv[1], JSON.stringify(Array.from(bytes)));
' "$key_abs")
  chmod 600 "$key"
  echo "==> imported into $key"
else
  solana-keygen new --no-bip39-passphrase -s -o "$key"
  echo "==> created $key"
fi
pubkey=$(solana-keygen pubkey "$key")
# The backend wants the base58 secret; solana-keygen only writes the JSON
# byte array. bs58 is a backend dependency, so run node from there.
key_abs="$PWD/$key"
base58=$(cd apps/backend && node -e '
const bs58 = require("bs58");
const bytes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(bs58.default.encode(Buffer.from(bytes)));
' "$key_abs")

if [ "${1:-launch}" = "spare" ]; then
  echo "spare operator: $pubkey"
  echo "Fund it with 2 SOL and create its USDC account before any set-operator:"
  echo "  solana transfer $pubkey 2 --allow-unfunded-recipient"
  echo "  spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner $pubkey"
  echo "Store this base58 secret in the password manager (it is OPERATOR_KEYPAIR after a rotation):"
  echo "  $base58"
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
set_kv OPERATOR_KEYPAIR "$base58"
set_kv DEPLOY_KEYPAIR "$key"
solana config set --keypair "$key" --url mainnet-beta >/dev/null

echo "deployer/operator: $pubkey"
echo "Written to $env_file as OPERATOR_KEYPAIR and DEPLOY_KEYPAIR; solana CLI now signs with it."
echo "Back up $key and keys/hex_vault-mainnet-keypair.json offline, then fund it:"
echo "  solana transfer $pubkey 5 --from <funded wallet> --allow-unfunded-recipient"
echo "(rent for the ~820 KB binary is about 4.3 SOL and stays locked in the program; the rest covers pool creation, token accounts and operator fees)"
