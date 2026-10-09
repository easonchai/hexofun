// off-chain-tickets ticket 14. The Game config's fields, their ranges, the
// message a team wallet signs to change them, and the four refusals. Pure: no
// Nest, no Prisma, so the controller and the tests share one verdict.
import type { PublicKey } from "@solana/web3.js";

import { verifySignedMessage } from "./invite-code";
import { RATE_TIERS } from "./referral-bonus";

/** Same window as Fast pause (FAST_PAUSE_WINDOW_SECONDS). */
export const GAME_CONFIG_WINDOW_SECONDS = 120;

// A type alias, not an interface: Prisma's Json input wants an index signature.
export type ReferralTier = {
  tier: number;
  min: number;
  max: number | null;
  rateBps: number;
};

export interface GameConfigFields {
  roundSeconds: number;
  houseCutBps: number;
  ticketsPerUsdc: number;
  bonusCapBps: number;
  referralTiers: ReferralTier[];
  maxTilesPerBet: number;
}

/**
 * The seed row: the values the last deployments bootstrapped with (the old
 * `DEFAULT_POOL_PARAMS`: house cut 6%, 10 Tickets per USDC, bonus cap 5%),
 * today's referral tiers, and the spec's 60 second Round and 36 tile bet.
 * The Pool no longer carries these, so there is nothing live to copy.
 */
export const DEFAULT_GAME_CONFIG: GameConfigFields = {
  roundSeconds: 60,
  houseCutBps: 600,
  ticketsPerUsdc: 10,
  bonusCapBps: 500,
  referralTiers: RATE_TIERS.map((t) => ({ ...t })),
  maxTilesPerBet: 36,
};

const MAX_BPS = 10_000;
const MAX_INT32 = 2_147_483_647;
const MAX_TIERS = 16;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

function parseTiers(raw: unknown): ReferralTier[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIERS) return null;
  const tiers: ReferralTier[] = [];
  for (const item of raw as unknown[]) {
    const t = item as Partial<Record<keyof ReferralTier, unknown>> | null;
    if (t === null || typeof t !== "object") return null;
    if (!isInt(t.tier, 1, MAX_TIERS) || !isInt(t.min, 1, MAX_INT32) || !isInt(t.rateBps, 0, MAX_BPS)) {
      return null;
    }
    if (t.max !== null && !isInt(t.max, t.min, MAX_INT32)) return null;
    // Highest tier first: referral-bonus.ts takes the first match.
    if (tiers.length > 0 && t.min >= tiers[tiers.length - 1]!.min) return null;
    tiers.push({ tier: t.tier, min: t.min, max: t.max, rateBps: t.rateBps });
  }
  return tiers;
}

/**
 * The tiers stored on a Game config row, re-parsed on read. A row that fails
 * is an error: falling back to the seed would pay at rates nobody signed.
 */
export function referralTiersFromRow(raw: unknown, context: string): ReferralTier[] {
  const tiers = parseTiers(raw);
  if (tiers === null) throw new Error(`${context}: the Game config row's referralTiers do not parse`);
  return tiers;
}

/** The fields in canonical key order, or null when any is missing or out of range. */
export function parseGameConfigFields(raw: unknown): GameConfigFields | null {
  const r = raw as Partial<Record<keyof GameConfigFields, unknown>> | null;
  if (r === null || typeof r !== "object") return null;
  const referralTiers = parseTiers(r.referralTiers);
  if (
    !isInt(r.roundSeconds, 60, MAX_INT32) ||
    !isInt(r.houseCutBps, 0, MAX_BPS) ||
    !isInt(r.ticketsPerUsdc, 1, 65_535) ||
    !isInt(r.bonusCapBps, 0, MAX_BPS) ||
    !isInt(r.maxTilesPerBet, 1, 36) ||
    referralTiers === null
  ) {
    return null;
  }
  return {
    roundSeconds: r.roundSeconds,
    houseCutBps: r.houseCutBps,
    ticketsPerUsdc: r.ticketsPerUsdc,
    bonusCapBps: r.bonusCapBps,
    referralTiers,
    maxTilesPerBet: r.maxTilesPerBet,
  };
}

/** The exact bytes `POST /ops/game-config` must be signed over. The JSON is
 *  `parseGameConfigFields`' key order, no spaces; the web helper must match. */
export function gameConfigMessage(pool: string, unixSeconds: number, fields: GameConfigFields): string {
  return `HexVault game-config ${pool} ${unixSeconds} ${JSON.stringify(fields)}`;
}

export type GameConfigRefusal =
  | "WalletNotListed"
  | "RequestStale"
  | "FieldOutOfRange"
  | "BadSignature";

export type GameConfigVerdict =
  | { ok: true; fields: GameConfigFields; message: string }
  | { ok: false; code: GameConfigRefusal };

export function verifyGameConfigChange(input: {
  allowed: ReadonlySet<string>;
  wallet: PublicKey;
  pool: string;
  time: number;
  fields: unknown;
  signature: Uint8Array;
  nowSeconds: number;
}): GameConfigVerdict {
  if (!input.allowed.has(input.wallet.toBase58())) return { ok: false, code: "WalletNotListed" };
  if (Math.abs(input.nowSeconds - input.time) > GAME_CONFIG_WINDOW_SECONDS) {
    return { ok: false, code: "RequestStale" };
  }
  const fields = parseGameConfigFields(input.fields);
  if (fields === null) return { ok: false, code: "FieldOutOfRange" };
  const message = gameConfigMessage(input.pool, input.time, fields);
  if (!verifySignedMessage(input.wallet, message, input.signature)) {
    return { ok: false, code: "BadSignature" };
  }
  return { ok: true, fields, message };
}
