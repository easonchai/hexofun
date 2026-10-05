/**
 * Pure math for the vault's earning balance (yield-claimer ticket 15). The
 * Read model gives Principal, the yield unsettled as of the last sync, that
 * sync's time and the pool's estimated current rate. Between refreshes the
 * screen adds what Principal earns at that rate since the sync. No chain read
 * (ADR 0008); `useLiveYield.ts` owns the timer.
 */
import type { LiveYieldDto } from "./api.js";

const SECONDS_PER_YEAR = 31_536_000n;
/** Rate is carried in hundredths of a basis point so 4.37% keeps its decimals. */
const RATE_SCALE = 10_000n * 100n;
/** ponytail: extrapolate at most a day past the last sync, so a stuck indexer
 *  cannot run the figure away. Lift it if syncs get rarer than daily. */
const MAX_EXTRAPOLATION_SECONDS = 86_400;

export interface BalanceInput {
  /** Atomic units. */
  principal: bigint;
  /** Atomic units, as of `syncedAt`. */
  unsettled: bigint;
  /** Chain unix seconds of the last sync; 0 when the pool has never synced. */
  syncedAt: number;
  /** Estimated APR in basis points; null when unknown. */
  rateBps: number | null;
  impaired: boolean;
}

/** Principal plus unsettled yield at `nowSeconds`. Stops ticking at a zero or
 *  unknown rate, and while the venue is impaired. */
export function balanceAt(input: BalanceInput, nowSeconds: number): bigint {
  const base = input.principal + input.unsettled;
  const { rateBps, syncedAt } = input;
  if (input.impaired || rateBps === null || !(rateBps > 0) || syncedAt <= 0) return base;
  const elapsed = Math.min(Math.max(Math.floor(nowSeconds - syncedAt), 0), MAX_EXTRAPOLATION_SECONDS);
  const rate = BigInt(Math.round(rateBps * 100));
  return base + (input.principal * rate * BigInt(elapsed)) / (SECONDS_PER_YEAR * RATE_SCALE);
}

export interface Shown {
  principal: bigint;
  value: bigint;
}

/** A refresh can land below what the timer already showed (the estimate ran
 *  ahead of what was paid). Hold the higher figure until the true one catches
 *  up. A changed Principal (deposit, withdraw, settle) is a new baseline, and
 *  so is an impaired pool: a real loss must show, not hide behind the old high. */
export function keepForward(prev: Shown | null, next: Shown, impaired = false): Shown {
  return !impaired && prev !== null && prev.principal === next.principal && prev.value > next.value
    ? prev
    : next;
}

/** The ticking applies only while earning. */
export const isTicking = (rateBps: number | null, impaired: boolean): boolean =>
  !impaired && rateBps !== null && rateBps > 0;

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

export interface RateCopy {
  /** "up to 5.00%" */
  ceiling: string;
  /** "4.12%", or "—" before two history points exist. */
  trailing: string;
  /** True when history is shorter than the 7 days. */
  trailingShort: boolean;
}

/** The "up to X%" and 7-day trailing paid rate, as the screen reads them. */
export function rateCopy(live: LiveYieldDto): RateCopy {
  const t = live.rates.trailing7d;
  return {
    ceiling: `up to ${pct(live.rates.ceilingBps)}`,
    trailing: t.aprBps === null ? "—" : pct(t.aprBps),
    trailingShort: t.shortHistory,
  };
}
