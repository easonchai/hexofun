/**
 * Display helpers for the Ops console. A figure the API returned as null is
 * "unavailable", never zero: callers pass the null straight through.
 */
import { formatMoney2 } from "../lib/money.js";

export const UNAVAILABLE = "unavailable";
export const USDC_DECIMALS = 6;

/** Atomic USDC string to "1,234.56 USDC". */
export const usdc = (atomic: string | null | undefined): string =>
  atomic == null ? UNAVAILABLE : `${formatMoney2(BigInt(atomic), USDC_DECIMALS)} USDC`;

/** Basis points to "4.88%". */
export const pct = (bps: number | null | undefined): string =>
  bps == null ? UNAVAILABLE : `${(bps / 100).toFixed(2)}%`;

/** Whole seconds to "12 s", "3 min" or "2 h". */
export const duration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
};

/** The line above every on-chain figure. `lastSyncAt` is chain unix seconds. */
export const syncLine = (lastSyncAt: string, nowSeconds: number): string => {
  const at = Number(lastSyncAt);
  if (!Number.isFinite(at) || at <= 0) return "This pool has not been indexed yet.";
  return `Last Sync ${duration(nowSeconds - at)} ago`;
};

/** Basis points to "8%" or "4.88%": the headline's percent, trailing zeros dropped. */
export const pctShort = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** Atomic USDC to "12.3k USDC" or "4.5M USDC", truncated; under 1,000 as `usdc`. */
export const usdcShort = (atomic: string | null | undefined): string => {
  if (atomic == null) return UNAVAILABLE;
  const value = BigInt(atomic);
  const sign = value < 0n ? "-" : "";
  const whole = (value < 0n ? -value : value) / 10n ** BigInt(USDC_DECIMALS);
  const tenths = (unit: bigint, suffix: string) =>
    `${sign}${whole / unit}.${(whole % unit) / (unit / 10n)}${suffix} USDC`;
  if (whole >= 1_000_000n) return tenths(1_000_000n, "M");
  if (whole >= 1_000n) return tenths(1_000n, "k");
  return usdc(atomic);
};

/** Whole seconds to "20s", "41m", "3h 5m" or "2d 4h". */
export const shortDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const pair = (big: number, unit: string, small: number, smallUnit: string) =>
    small ? `${big}${unit} ${small}${smallUnit}` : `${big}${unit}`;
  if (s < 86_400) return pair(Math.floor(s / 3600), "h", Math.floor(s / 60) % 60, "m");
  return pair(Math.floor(s / 86_400), "d", Math.floor(s / 3600) % 24, "h");
};

/** "20s ago" from unix seconds; null is unavailable. */
export const ago = (atSeconds: number | null, nowSeconds: number): string =>
  atSeconds === null ? UNAVAILABLE : `${shortDuration(nowSeconds - atSeconds)} ago`;

/** "closes in 41m", or "closed 3m ago" once past. */
export const closesIn = (endsAtSeconds: number | null, nowSeconds: number): string => {
  if (endsAtSeconds === null) return UNAVAILABLE;
  const left = endsAtSeconds - nowSeconds;
  return left > 0 ? `closes in ${shortDuration(left)}` : `closed ${shortDuration(-left)} ago`;
};

/** "12.3k USDC (8%, band 5 to 15%)": free idle against the Idle band. */
export const idleLine = (
  freeIdle: string | null,
  freeIdleBps: number | null,
  band: { idleFloorBps: number; idleTargetBps: number } | null,
): string => {
  if (freeIdle === null) return UNAVAILABLE;
  const parts = [
    ...(freeIdleBps === null ? [] : [pctShort(freeIdleBps)]),
    ...(band ? [`band ${Number((band.idleFloorBps / 100).toFixed(2))} to ${pctShort(band.idleTargetBps)}`] : []),
  ];
  return parts.length ? `${usdcShort(freeIdle)} (${parts.join(", ")})` : usdcShort(freeIdle);
};

/** Local wall clock "14:02" for unix seconds. */
export const clock = (atSeconds: number): string => {
  const d = new Date(atSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** "stuck in Drawn since 14:02"; without a time, "stuck in Drawn". */
export const stuckLine = (status: string, sinceSeconds: number | null): string =>
  sinceSeconds === null ? `stuck in ${status}` : `stuck in ${status} since ${clock(sinceSeconds)}`;

/**
 * Share of the pool's money sitting in the venue, in basis points: venue value
 * over venue value plus the vault. Null when the vault read failed or both are zero.
 */
export const deployedBps = (
  venueValue: string,
  vaultLiquidity: string | null,
): number | null => {
  if (vaultLiquidity === null) return null;
  const venue = BigInt(venueValue);
  const total = venue + BigInt(vaultLiquidity);
  return total === 0n ? null : Number((venue * 10_000n) / total);
};
