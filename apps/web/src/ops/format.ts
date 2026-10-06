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
