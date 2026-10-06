import { describe, expect, it } from "vitest";

import { deployedBps, duration, pct, syncLine, UNAVAILABLE, usdc } from "./format.js";

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

  it("computes the deployed share of the pool", () => {
    expect(deployedBps("300", "700")).toBe(3000);
    expect(deployedBps("0", "0")).toBeNull();
    expect(deployedBps("300", null)).toBeNull();
  });
});
