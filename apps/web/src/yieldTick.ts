/**
 * Rate copy for the About page (yield-claimer ticket 15): the pool's "up to"
 * ceiling and the 7-day trailing paid rate from `GET /pool`'s `live` block.
 * No chain read (ADR 0008).
 */
import type { LiveYieldDto } from "./api.js";

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
