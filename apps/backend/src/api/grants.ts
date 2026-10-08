// off-chain-tickets ticket 23. The message a team wallet signs to grant Tickets
// by hand, and the verdict on a request. Pure: no Nest, no Prisma, so the
// controller and the tests share one verdict.
import type { PublicKey } from "@solana/web3.js";

import { verifySignedMessage } from "./invite-code";

/** Same window as Fast pause (FAST_PAUSE_WINDOW_SECONDS). */
export const GRANT_WINDOW_SECONDS = 120;
export const GRANT_REASON_MAX = 200;

/** The exact bytes `POST /ops/grants` must be signed over; the web and CLI builders must match. */
export function grantMessage(pool: string, wallet: string, amount: bigint, reason: string, unixSeconds: number): string {
  return `HexVault grant ${pool} ${wallet} ${amount} ${reason} ${unixSeconds}`;
}

export type GrantRefusal =
  | "WalletNotListed"
  | "RequestStale"
  | "AmountOutOfRange"
  | "ReasonInvalid"
  | "BadSignature";

export type GrantVerdict =
  | { ok: true; amount: bigint; reason: string; message: string }
  | { ok: false; code: GrantRefusal };

export function verifyGrant(input: {
  allowed: ReadonlySet<string>;
  signer: PublicKey;
  pool: string;
  wallet: string;
  amount: unknown;
  reason: unknown;
  time: number;
  signature: Uint8Array;
  nowSeconds: number;
}): GrantVerdict {
  if (!input.allowed.has(input.signer.toBase58())) return { ok: false, code: "WalletNotListed" };
  if (Math.abs(input.nowSeconds - input.time) > GRANT_WINDOW_SECONDS) return { ok: false, code: "RequestStale" };
  const { amount, reason } = input;
  // Tickets are whole numbers; a JSON number past 2^53 would already have lost digits.
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) {
    return { ok: false, code: "AmountOutOfRange" };
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > GRANT_REASON_MAX) {
    return { ok: false, code: "ReasonInvalid" };
  }
  const message = grantMessage(input.pool, input.wallet, BigInt(amount), reason, input.time);
  if (!verifySignedMessage(input.signer, message, input.signature)) return { ok: false, code: "BadSignature" };
  return { ok: true, amount: BigInt(amount), reason, message };
}
