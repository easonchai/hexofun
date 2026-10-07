import { describe, expect, it } from "vitest";

import {
  ago,
  closesIn,
  deployedBps,
  duration,
  idleLine,
  pct,
  shortDuration,
  stuckLine,
  syncLine,
  UNAVAILABLE,
  usdc,
  usdcShort,
} from "./format.js";

describe("ops format", () => {
  it("shows null as unavailable, never zero", () => {
    expect(usdc(null)).toBe(UNAVAILABLE);
    expect(pct(null)).toBe(UNAVAILABLE);
    expect(usdc("0")).toBe("0.00 USDC");
    expect(pct(0)).toBe("0.00%");
  });

  it("formats USDC and negative margins", () => {
    expect(usdc("1234567890")).toBe("1,234.56 USDC");
    expect(usdc("-5000000")).toBe("-5.00 USDC");
  });

  it("formats basis points as a percent", () => {
    expect(pct(488)).toBe("4.88%");
  });

  it("picks a unit for durations", () => {
    expect(duration(12)).toBe("12 s");
    expect(duration(185)).toBe("3 min");
    expect(duration(7300)).toBe("2 h");
    expect(duration(-4)).toBe("0 s");
  });

  it("words the sync line, and a pool never indexed", () => {
    expect(syncLine("1000", 1012)).toBe("Last Sync 12 s ago");
    expect(syncLine("0", 1012)).toMatch(/not been indexed/);
  });

  it("shortens USDC to k and M, truncating", () => {
    expect(usdcShort("12349000000")).toBe("12.3k USDC");
    expect(usdcShort("4560000000000")).toBe("4.5M USDC");
    expect(usdcShort("-2500000000")).toBe("-2.5k USDC");
    expect(usdcShort("812400000")).toBe("812.40 USDC");
    expect(usdcShort(null)).toBe(UNAVAILABLE);
  });

  it("words ages and closes", () => {
    expect(shortDuration(20)).toBe("20s");
    expect(shortDuration(41 * 60 + 5)).toBe("41m");
    expect(shortDuration(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(shortDuration(2 * 86_400)).toBe("2d");
    expect(ago(980, 1000)).toBe("20s ago");
    expect(ago(null, 1000)).toBe(UNAVAILABLE);
    expect(closesIn(1000 + 41 * 60, 1000)).toBe("closes in 41m");
    expect(closesIn(820, 1000)).toBe("closed 3m ago");
  });

  it("words free idle against the band", () => {
    expect(idleLine("12300000000", 800, { idleFloorBps: 500, idleTargetBps: 1500 })).toBe(
      "12.3k USDC (8%, band 5 to 15%)",
    );
    expect(idleLine("12300000000", null, null)).toBe("12.3k USDC");
    expect(idleLine(null, 800, null)).toBe(UNAVAILABLE);
  });

  it("words a stuck item", () => {
    const at = new Date(2026, 9, 7, 14, 2).getTime() / 1000;
    expect(stuckLine("Drawn", at)).toBe("stuck in Drawn since 14:02");
    expect(stuckLine("Drawn", null)).toBe("stuck in Drawn");
  });

  it("computes the deployed share of the pool", () => {
    expect(deployedBps("300", "700")).toBe(3000);
    expect(deployedBps("0", "0")).toBeNull();
    expect(deployedBps("300", null)).toBeNull();
  });
});
