// The localnet suites' program is deployed with ANCHOR_WALLET as upgrade
// authority (tests/run-local.sh), and `create_pool` accepts only that key as
// payer (mainnet-readiness-fixes 06). The suites sign it with this.
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

export function deployWallet(): Keypair {
  const path = process.env.ANCHOR_WALLET;
  if (!path) throw new Error("ANCHOR_WALLET is not set; run through tests/run-local.sh");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
