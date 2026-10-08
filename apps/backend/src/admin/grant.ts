// `admin grant-tickets` (off-chain-tickets ticket 23): signs a manual grant with
// the keypair file it is given and posts it to the backend. No chain, no
// database; the backend books the ledger row (apps/backend/src/api/grants.controller.ts).
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { readFileSync } from "node:fs";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { grantMessage } from "../api/grants";
import type { AdminCommand } from "./args";

const REQUEST_TIMEOUT_MS = 15_000;

/** A `solana-keygen` file: a JSON array of the 64 secret key bytes. */
export function loadKeypairFile(path: string): Keypair {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  } catch (cause) {
    throw new Error(`--keypair ${path} is not a readable solana keypair file (a JSON array of 64 bytes)`, { cause });
  }
}

export interface GrantDeps {
  /** The pool's base58 address, which the message is signed over. */
  pool: string;
  backendUrl: string;
  nowSeconds?: number;
  fetchFn?: typeof fetch;
}

/** Posts the signed grant and prints the new ledger row's id, alone, to stdout. */
export async function grantTickets(
  command: Extract<AdminCommand, { kind: "grant-tickets" }>,
  signer: Keypair,
  deps: GrantDeps,
): Promise<void> {
  const time = Math.floor(deps.nowSeconds ?? Date.now() / 1000);
  const wallet = command.owner.toBase58();
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(signer.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  const message = grantMessage(deps.pool, wallet, command.amount, command.reason, time);
  const signature = bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));

  const response = await (deps.fetchFn ?? fetch)(`${deps.backendUrl.replace(/\/+$/, "")}/ops/grants`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      wallet,
      amount: Number(command.amount),
      reason: command.reason,
      signer: signer.publicKey.toBase58(),
      time,
      signature,
    }),
  });
  const json = (await response.json().catch(() => null)) as { id?: string; code?: string; message?: string } | null;
  if (!response.ok) {
    const why = json?.code ? `${json.code}: ${json.message ?? ""}` : (json?.message ?? "");
    throw new Error(`the backend refused the grant (HTTP ${response.status}) ${why}`.trim());
  }
  process.stderr.write(`granted ${command.amount} Tickets to ${wallet} as ${signer.publicKey.toBase58()}\n`);
  process.stdout.write(`${json?.id ?? ""}\n`);
}
