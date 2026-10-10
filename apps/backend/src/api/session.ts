// Session delegation, pure and DB-free (off-chain-tickets ticket 15, spec
// "Session delegation", research 02). A wallet signs a SIWS-shaped text that
// names a browser-held session key; the backend verifies it here and the
// service stores it. The web builds the same text in apps/web/src/session.ts;
// both tests pin the same fixture string.
import { PublicKey } from "@solana/web3.js";

import { verifySignedMessage } from "./invite-code";

/** A delegation may not run longer than this, from its own `Issued At`. */
export const SESSION_MAX_SECONDS = 24 * 60 * 60;
/** A nonce from `GET /game/sessions/nonce` lives this long. */
export const NONCE_TTL_SECONDS = 10 * 60;
/** How far `Issued At` may sit from the server's clock, either way. Also the
 *  slack a client with a fast clock gets on the 24 hour cap. */
export const ISSUED_AT_SKEW_SECONDS = 10 * 60;
/** How far a revoke request's time may sit from the server's clock. */
export const REVOKE_WINDOW_SECONDS = 120;

/** The refusal names a delegation or revoke can come back with. */
export type DelegationCode =
  | "BadMessage"
  | "BadSignature"
  | "IssuedAtOutOfRange"
  | "ExpiryTooLong"
  | "AlreadyExpired"
  | "NonceInvalid";
export type RevokeCode = "BadSignature" | "StaleRevoke";

export const DELEGATION_STATEMENT =
  "Authorize a HexVault betting session. This key can place bets in the game and cannot withdraw.";

export interface DelegationFields {
  /** Host of `uri`, e.g. `hexvault.xyz` or `localhost:5173`. */
  domain: string;
  wallet: string;
  uri: string;
  /** The cluster name, verbatim (`devnet`, `mainnet-beta`). */
  chainId: string;
  nonce: string;
  /** `YYYY-MM-DDTHH:MM:SSZ`, no milliseconds. */
  issuedAt: string;
  expirationTime: string;
  sessionPubkey: string;
  programId: string;
}

/** Research 02's delegation text, byte for byte. Restricted ASCII so a Ledger
 *  can show it. */
export function delegationMessage(f: DelegationFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.wallet,
    "",
    DELEGATION_STATEMENT,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
    "Resources:",
    `- hexvault:session:${f.sessionPubkey}`,
    `- hexvault:program:${f.programId}`,
  ].join("\n");
}

/** The exact text `POST /game/sessions/:id/revoke` must be signed over. */
export function revokeMessage(sessionPubkey: string, unixSeconds: number): string {
  return `HexVault revoke session ${sessionPubkey} ${unixSeconds}`;
}

const isoSeconds = (date: Date): string => date.toISOString().replace(".000Z", "Z");

/** Parses `YYYY-MM-DDTHH:MM:SSZ` only; anything else is null. */
function parseIso(text: string | undefined): Date | null {
  if (text === undefined || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) || isoSeconds(date) !== text ? null : date;
}

function canonicalKey(text: string | undefined): PublicKey | null {
  if (text === undefined) return null;
  try {
    const key = new PublicKey(text);
    return key.toBase58() === text ? key : null;
  } catch {
    return null;
  }
}

export interface DelegationContext {
  now: Date;
  /** Origins the web is served from (`CORS_ORIGIN`). */
  allowedOrigins: readonly string[];
  /** The request's `Origin` header; the signed URI must equal it, so a delegation
   *  signed for the real site cannot be replayed from another one. */
  origin: string | undefined;
  /** `CLUSTER`. */
  chainId: string;
  programId: string;
  /** Spends the nonce; true once, for a live nonce. Called last, so a message
   *  that fails any other check leaves its nonce alone. */
  consumeNonce: (nonce: string) => Promise<boolean>;
}

export interface Delegation {
  wallet: string;
  sessionPubkey: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export type DelegationResult =
  | { ok: true; delegation: Delegation }
  | { ok: false; code: DelegationCode };

/**
 * Verifies a delegation. The message is parsed for the fields the wallet and
 * the key choose, rebuilt with the server's own domain checks and cluster and
 * program, and refused unless the rebuild matches byte for byte, so nothing
 * the signature covers goes unchecked. The signature is the wallet's ed25519
 * signature over the raw UTF-8 bytes (what Phantom and Solflare `signMessage`
 * and `signIn` produce); Solana's off-chain header is not accepted until a
 * wallet is seen using it (ticket 15 device checks).
 */
export async function verifyDelegation(
  input: { message: string; signature: Uint8Array },
  ctx: DelegationContext,
): Promise<DelegationResult> {
  const fail = (code: DelegationCode): DelegationResult => ({ ok: false, code });
  const { message } = input;
  const lines = message.split("\n");
  const pick = (prefix: string): string | undefined =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);

  const wallet = canonicalKey(lines[1]);
  const session = canonicalKey(pick("- hexvault:session:"));
  const uri = pick("URI: ");
  const nonce = pick("Nonce: ");
  const issuedAt = parseIso(pick("Issued At: "));
  const expiresAt = parseIso(pick("Expiration Time: "));
  if (!wallet || !session || !uri || !nonce || !issuedAt || !expiresAt) return fail("BadMessage");
  if (!ctx.allowedOrigins.includes(uri) || uri !== ctx.origin) return fail("BadMessage");
  let domain: string;
  try {
    domain = new URL(uri).host;
  } catch {
    return fail("BadMessage");
  }
  const rebuilt = delegationMessage({
    domain,
    wallet: wallet.toBase58(),
    uri,
    chainId: ctx.chainId,
    nonce,
    issuedAt: isoSeconds(issuedAt),
    expirationTime: isoSeconds(expiresAt),
    sessionPubkey: session.toBase58(),
    programId: ctx.programId,
  });
  if (rebuilt !== message) return fail("BadMessage");

  if (!verifySignedMessage(wallet, message, input.signature)) return fail("BadSignature");

  const nowMs = ctx.now.getTime();
  if (Math.abs(nowMs - issuedAt.getTime()) > ISSUED_AT_SKEW_SECONDS * 1000) {
    return fail("IssuedAtOutOfRange");
  }
  if (expiresAt.getTime() - issuedAt.getTime() > SESSION_MAX_SECONDS * 1000) {
    return fail("ExpiryTooLong");
  }
  if (expiresAt.getTime() <= nowMs) return fail("AlreadyExpired");
  if (!(await ctx.consumeNonce(nonce))) return fail("NonceInvalid");

  return {
    ok: true,
    delegation: {
      wallet: wallet.toBase58(),
      sessionPubkey: session.toBase58(),
      nonce,
      issuedAt,
      expiresAt,
    },
  };
}

/** Verifies the wallet's signature over `revokeMessage(sessionPubkey, time)`,
 *  with `time` within `REVOKE_WINDOW_SECONDS` of `now`. The caller supplies
 *  the Session's own wallet and key, so the signature must be the delegating
 *  wallet's. */
export function verifyRevoke(
  session: { wallet: string; sessionPubkey: string },
  input: { time: number; signature: Uint8Array },
  now: Date,
): { ok: true } | { ok: false; code: RevokeCode } {
  if (Math.abs(now.getTime() / 1000 - input.time) > REVOKE_WINDOW_SECONDS) {
    return { ok: false, code: "StaleRevoke" };
  }
  const wallet = canonicalKey(session.wallet);
  const signed =
    wallet !== null &&
    verifySignedMessage(wallet, revokeMessage(session.sessionPubkey, input.time), input.signature);
  return signed ? { ok: true } : { ok: false, code: "BadSignature" };
}
