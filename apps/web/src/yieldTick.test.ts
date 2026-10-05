import { describe, expect, it } from "vitest";

import type { LiveYieldDto } from "./api.js";
import { balanceAt, isTicking, keepForward, rateCopy, type BalanceInput } from "./yieldTick.js";

/** 1,000 USDC at 5% a year, synced at t=1000 with 2 USDC already unsettled. */
const base: BalanceInput = {
  principal: 1_000_000_000n,
  unsettled: 2_000_000n,
  syncedAt: 1_000,
  rateBps: 500,
  impaired: false,
};
const FLAT = 1_002_000_000n;

describe("balanceAt", () => {
  it("is Principal plus unsettled at the moment of the sync", () => {
    expect(balanceAt(base, 1_000)).toBe(FLAT);
  });

  it("adds what Principal earns at the estimated rate since the sync", () => {
    // 5% of 1,000 USDC is 50 USDC a year, 136,986 atomic units a day.
    expect(balanceAt(base, 1_000 + 86_400)).toBe(FLAT + 136_986n);
  });

  it("grows with time and never shrinks while the inputs hold", () => {
    expect(balanceAt(base, 1_060)).toBeGreaterThanOrEqual(balanceAt(base, 1_030));
    expect(balanceAt(base, 1_060)).toBeGreaterThan(FLAT);
  });

  it("shows no accrual for a clock behind the sync", () => {
    expect(balanceAt(base, 500)).toBe(FLAT);
  });

  it("stops at a zero, unknown or impaired rate", () => {
    expect(balanceAt({ ...base, rateBps: 0 }, 1_000 + 3_600)).toBe(FLAT);
    expect(balanceAt({ ...base, rateBps: null }, 1_000 + 3_600)).toBe(FLAT);
    expect(balanceAt({ ...base, impaired: true }, 1_000 + 3_600)).toBe(FLAT);
  });

  it("does not extrapolate from a pool that never synced", () => {
    expect(balanceAt({ ...base, syncedAt: 0 }, 1_700_000_000)).toBe(FLAT);
  });

  it("caps the extrapolation at a day", () => {
    expect(balanceAt(base, 1_000 + 10 * 86_400)).toBe(balanceAt(base, 1_000 + 86_400));
  });
});

describe("keepForward", () => {
  const shown = { principal: 100n, value: 110n };

  it("holds the higher figure when a refresh lands lower on the same Principal", () => {
    expect(keepForward(shown, { principal: 100n, value: 108n })).toEqual(shown);
  });

  it("takes a refresh that is higher", () => {
    expect(keepForward(shown, { principal: 100n, value: 112n }).value).toBe(112n);
  });

  it("takes a new baseline when Principal changes, even if lower", () => {
    expect(keepForward(shown, { principal: 40n, value: 40n })).toEqual({ principal: 40n, value: 40n });
  });

  it("shows a lower figure while the pool is impaired", () => {
    expect(keepForward(shown, { principal: 100n, value: 90n }, true).value).toBe(90n);
  });

  it("takes the first figure", () => {
    expect(keepForward(null, shown)).toEqual(shown);
  });
});

describe("isTicking", () => {
  it("is off at zero rate, unknown rate or impaired", () => {
    expect(isTicking(500, false)).toBe(true);
    expect(isTicking(0, false)).toBe(false);
    expect(isTicking(null, false)).toBe(false);
    expect(isTicking(500, true)).toBe(false);
  });
});

describe("rateCopy", () => {
  const live = (aprBps: number | null, shortHistory = false): LiveYieldDto => ({
    rates: {
      trailing24h: { aprBps, windowSeconds: 86_400, shortHistory },
      trailing7d: { aprBps, windowSeconds: 604_800, shortHistory },
      estimatedBps: 400,
      ceilingBps: 500,
    },
    yieldFeeBps: 1_000,
    buyTicketsPaused: false,
    freeIdle: null,
    haircutFactor: null,
  });

  it("reads up to the ceiling with the 7-day paid rate", () => {
    expect(rateCopy(live(412.4))).toEqual({ ceiling: "up to 5.00%", trailing: "4.12%", trailingShort: false });
  });

  it("shows a dash before there is history", () => {
    expect(rateCopy(live(null, true))).toEqual({ ceiling: "up to 5.00%", trailing: "—", trailingShort: true });
  });
});
