/**
 * Game config helpers (off-chain-tickets ticket 14): the message a team wallet
 * signs, the form-to-fields check, the read of `GET /game/config`, the POST to
 * `/ops/game-config` and the error copy per refusal.
 *
 * `gameConfigMessage` mirrors apps/backend/src/api/game-config.ts byte for
 * byte, key order included. The web cannot import backend source, so each
 * suite pins the same literal.
 */
export interface ReferralTier {
  tier: number;
  min: number;
  max: number | null;
  rateBps: number;
}

export interface GameConfigFields {
  roundSeconds: number;
  houseCutBps: number;
  ticketsPerUsdc: number;
  bonusCapBps: number;
  referralTiers: ReferralTier[];
  maxTilesPerBet: number;
}

export interface GameConfigRow extends GameConfigFields {
  id: number;
  poolAddress: string;
  /** Null on the seed row the backend writes on first run. */
  signer: string | null;
  signature: string | null;
  message: string | null;
  createdAt: string;
}

export interface GameConfigDto {
  inForce: GameConfigRow | null;
  history: GameConfigRow[];
}

const FETCH_TIMEOUT_MS = 15_000;

/** Canonical key order, the one the backend signs over. */
export function toFields(f: GameConfigFields): GameConfigFields {
  return {
    roundSeconds: f.roundSeconds,
    houseCutBps: f.houseCutBps,
    ticketsPerUsdc: f.ticketsPerUsdc,
    bonusCapBps: f.bonusCapBps,
    referralTiers: f.referralTiers.map((t) => ({ tier: t.tier, min: t.min, max: t.max, rateBps: t.rateBps })),
    maxTilesPerBet: f.maxTilesPerBet,
  };
}

export function gameConfigMessage(pool: string, unixSeconds: number, fields: GameConfigFields): string {
  return `HexVault game-config ${pool} ${unixSeconds} ${JSON.stringify(toFields(fields))}`;
}

/** The form's text boxes. Tiers are one JSON box: four rows, rarely edited. */
export interface FormValues {
  roundSeconds: string;
  houseCutBps: string;
  ticketsPerUsdc: string;
  bonusCapBps: string;
  maxTilesPerBet: string;
  referralTiers: string;
}

export function formFromFields(f: GameConfigFields): FormValues {
  return {
    roundSeconds: String(f.roundSeconds),
    houseCutBps: String(f.houseCutBps),
    ticketsPerUsdc: String(f.ticketsPerUsdc),
    bonusCapBps: String(f.bonusCapBps),
    maxTilesPerBet: String(f.maxTilesPerBet),
    referralTiers: JSON.stringify(toFields(f).referralTiers, null, 1),
  };
}

const RANGES = [
  ["roundSeconds", "Round seconds", 60, 2_147_483_647],
  ["houseCutBps", "House cut bps", 0, 10_000],
  ["ticketsPerUsdc", "Tickets per USDC", 1, 65_535],
  ["bonusCapBps", "Bonus cap bps", 0, 10_000],
  ["maxTilesPerBet", "Max tiles per bet", 1, 36],
] as const;

/** Checks what it can before a signature is asked for; the backend stays the judge. */
export function parseForm(
  values: FormValues,
): { ok: true; fields: GameConfigFields } | { ok: false; error: string } {
  const nums: Partial<Record<(typeof RANGES)[number][0], number>> = {};
  for (const [key, label, min, max] of RANGES) {
    const text = values[key].trim();
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < min || n > max) {
      return { ok: false, error: `${label} must be a whole number from ${min} to ${max}.` };
    }
    nums[key] = n;
  }
  let tiers: unknown;
  try {
    tiers = JSON.parse(values.referralTiers);
  } catch {
    return { ok: false, error: "Referral tiers must be valid JSON." };
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, error: "Referral tiers must be a list of at least one tier." };
  }
  // The backend checks each tier's ranges; the shape is all the signature needs here.
  return {
    ok: true,
    fields: toFields({ ...(nums as Omit<GameConfigFields, "referralTiers">), referralTiers: tiers as ReferralTier[] }),
  };
}

export function classifyGameConfigError(status: number | null, code: string | null, reason: string): string {
  if (status === 404) return "The Game config cannot be changed on this env.";
  if (code === "WalletNotListed") return "This wallet is not on the list.";
  if (code === "RequestStale") return "The request was too old. Check your clock and sign again.";
  if (code === "BadSignature") return "The signature did not match these fields. Sign again.";
  if (code === "AlreadyApplied") return "That signed change was already applied.";
  return reason || "Could not reach the server. Try again.";
}

export type GameConfigResult =
  | { ok: true; row: GameConfigRow }
  | { ok: false; status: number | null; code: string | null; reason: string };

export async function fetchGameConfig(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: GameConfigDto } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${baseUrl}/game/config`, {
      signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as GameConfigDto };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Signs the change with the connected wallet and posts it. Never throws. */
export async function submitGameConfig(args: {
  baseUrl: string;
  pool: string;
  wallet: string;
  fields: GameConfigFields;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  encodeSignature: (bytes: Uint8Array) => string;
  nowSeconds: number;
}): Promise<GameConfigResult> {
  const time = Math.floor(args.nowSeconds);
  try {
    const bytes = await args.signMessage(new TextEncoder().encode(gameConfigMessage(args.pool, time, args.fields)));
    const response = await fetch(`${args.baseUrl}/ops/game-config`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        wallet: args.wallet,
        time,
        signature: args.encodeSignature(bytes),
        fields: toFields(args.fields),
      }),
    });
    const json = (await response.json().catch(() => null)) as
      | (Partial<GameConfigRow> & { code?: string; message?: string })
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: json?.code ?? null,
        reason: json?.message ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, row: json as GameConfigRow };
  } catch (error) {
    // Most often the wallet declining the signature request.
    return { ok: false, status: null, code: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
