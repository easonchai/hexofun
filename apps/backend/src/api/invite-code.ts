// Invite code format, generation and redeem-signature verification
// (docs/plan/hexo-referrals ticket 06). Pure and DB-free so the admin CLI,
// the indexer and the API can all import it without pulling in Prisma.
import { createPublicKey, randomInt, verify as verifyEd25519 } from "node:crypto";

import type { PublicKey } from "@solana/web3.js";

/** No 0/O/1/I: none of the 32 symbols can be confused reading a code aloud
 *  or off a screenshot. */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const INVITE_CODE_LENGTH = 8;

/** Invite codes are single use from now on (referral-page ticket 07); the
 *  admin issue endpoint and CLI default `maxUses` to this. */
export const INVITE_CODE_MAX_USES = 1;

/** No more than this many remaining uses, summed across every Invite code
 *  (admin-issued included), may be in circulation at once (ADR 0014,
 *  referral-page ticket 07). The default; env `INVITE_CIRCULATION_CAP`
 *  overrides it. */
export const INVITE_CIRCULATION_CAP = 50;

/** A successful redeem grants the redeemer up to this many new codes of its
 *  own, capped by the circulation cap. The default; env
 *  `INVITE_REDEEM_GRANT_COUNT` overrides it. */
export const INVITE_REDEEM_GRANT_COUNT = 2;

/**
 * How many new Invite codes a successful redeem grants its redeemer, given
 * how many remaining uses (maxUses − uses, summed over every Invite code)
 * are already in circulation. `min(grantCount, cap − circulation)`, floored
 * at 0: at or over the cap the redeemer gets fewer or none, and nobody tops
 * them up later.
 */
export function inviteGrantCount(
  circulation: number,
  cap: number = INVITE_CIRCULATION_CAP,
  grantCount: number = INVITE_REDEEM_GRANT_COUNT,
): number {
  return Math.max(0, Math.min(grantCount, cap - circulation));
}

/** A fresh 8-character code. Collisions against `INVITE_CODE_ALPHABET`'s
 *  32^8 (~1.1e12) space are not checked for: the caller's `InviteCode.code`
 *  primary key surfaces one as a clear insert failure instead. */
export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

/** Redeem is case-insensitive on input; codes are stored and compared in
 *  this canonical upper-cased, trimmed form. */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The exact bytes `POST /access/redeem` must be signed over, so the backend
 *  builds this itself rather than trusting a client-supplied message. With a
 *  `referralCode` (docs/plan/referral-page ticket 02, ADR 0014), it rides
 *  inside this same message so applying one costs no extra signature;
 *  omitted, the message is exactly what it was before ticket 02. */
export function accessMessage(wallet: string, code: string, referralCode?: string): string {
  return referralCode
    ? `HEXO access: ${wallet} ${code} ref:${referralCode}`
    : `HEXO access: ${wallet} ${code}`;
}

/**
 * True when `signature` is `wallet`'s ed25519 signature over `message`. The
 * shared verify step behind `verifyAccessSignature` and
 * `verifyApplyReferralSignature`. A Solana address doubles as an Ed25519
 * public key, so this needs no extra keypair material: Node's built-in
 * `crypto` (Ed25519 verify shipped since Node 16) is the only "dependency",
 * since neither tweetnacl nor @noble/curves is reachable from this package
 * (checked: @solana/web3.js 1.98.4 ships no runtime dependencies at all).
 */
export function verifySignedMessage(
  wallet: PublicKey,
  message: string,
  signature: Uint8Array,
): boolean {
  let key;
  try {
    key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(wallet.toBytes()).toString("base64url") },
      format: "jwk",
    });
  } catch {
    return false;
  }
  try {
    return verifyEd25519(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** True when `signature` is `wallet`'s ed25519 signature over
 *  `accessMessage(wallet, code, referralCode)`. */
export function verifyAccessSignature(
  wallet: PublicKey,
  code: string,
  signature: Uint8Array,
  referralCode?: string,
): boolean {
  return verifySignedMessage(wallet, accessMessage(wallet.toBase58(), code, referralCode), signature);
}

/** The exact bytes `POST /referrals/apply` must be signed over (docs/plan/
 *  referral-page ticket 02). Distinct from `accessMessage`, per ADR 0014, so
 *  a redeem signature can't be replayed here, or vice versa. */
export function applyReferralMessage(wallet: string, code: string): string {
  return `HEXO apply referral: ${wallet} ${code}`;
}

/** The four switches Fast pause can set (ops-console ticket 06). */
export const FAST_PAUSE_SWITCHES = ["pool", "game", "jackpot", "deploy"] as const;
export type FastPauseSwitch = (typeof FAST_PAUSE_SWITCHES)[number];

/** The exact bytes `POST /ops/fast-pause` must be signed over. Fixed format,
 *  `HEXO fast pause: <switch> <pool address> <unix seconds>`, distinct from
 *  the access and referral messages so no signature replays across routes.
 *  The web helper (ops-console ticket 07) must match it byte for byte. */
export function fastPauseMessage(
  feature: FastPauseSwitch,
  pool: string,
  unixSeconds: number,
): string {
  return `HEXO fast pause: ${feature} ${pool} ${unixSeconds}`;
}

/** True when `signature` is `wallet`'s ed25519 signature over
 *  `applyReferralMessage(wallet, code)`. */
export function verifyApplyReferralSignature(
  wallet: PublicKey,
  code: string,
  signature: Uint8Array,
): boolean {
  return verifySignedMessage(wallet, applyReferralMessage(wallet.toBase58(), code), signature);
}
