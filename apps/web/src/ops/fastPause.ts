/**
 * Fast pause helpers (ops-console ticket 07): the message a team wallet signs,
 * the POST to `/ops/fast-pause` and the error copy per status.
 *
 * `fastPauseMessage` mirrors apps/backend/src/api/invite-code.ts byte for byte.
 */
import { POOL_ID, poolAddress } from "../chain.js";

export const FAST_PAUSE_SWITCHES = ["pool", "game", "jackpot", "deploy"] as const;
export type FastPauseSwitch = (typeof FAST_PAUSE_SWITCHES)[number];

const FETCH_TIMEOUT_MS = 15_000;

export function fastPauseMessage(feature: FastPauseSwitch, pool: string, unixSeconds: number): string {
  return `HEXO fast pause: ${feature} ${pool} ${unixSeconds}`;
}

/** Signs the fast-pause message. The backend verifies it over the pool's base58 address, not the numeric id. */
export async function signFastPause(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  feature: FastPauseSwitch,
  unixSeconds: number,
): Promise<Uint8Array> {
  const message = fastPauseMessage(feature, poolAddress(POOL_ID).toBase58(), unixSeconds);
  return signMessage(new TextEncoder().encode(message));
}

/** The admin CLI command that does what the failed request should have done. */
const CLI: Record<FastPauseSwitch, string> = {
  pool: "pause",
  game: "pause-game",
  jackpot: "pause-jackpot",
  deploy: "pause-deploy",
};

export function classifyFastPauseError(
  status: number | null,
  reason: string,
  feature: FastPauseSwitch,
): string {
  if (status === 404) return "Fast pause is not enabled on this env.";
  if (status === 403) return "This wallet is not on the list.";
  if (status === 502)
    return `The pause did not land. Run "pnpm --filter @hexvault/backend admin ${CLI[feature]}" from a machine with the backend env.`;
  return reason || "Could not reach the server. Try again.";
}

export type FastPauseResult =
  | { ok: true; signature: string }
  | { ok: false; status: number | null; reason: string };

export async function postFastPause(
  baseUrl: string,
  body: { switch: FastPauseSwitch; wallet: string; time: number; signature: string },
): Promise<FastPauseResult> {
  try {
    const response = await fetch(`${baseUrl}/ops/fast-pause`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as {
      signature?: string;
      message?: string;
    } | null;
    if (!response.ok) {
      return { ok: false, status: response.status, reason: json?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, signature: json?.signature ?? "" };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
