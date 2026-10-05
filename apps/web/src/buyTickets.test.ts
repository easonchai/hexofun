import { describe, expect, it } from "vitest";

import { buyDisabledReason, buyTicketsVisible, ticketsFromUsdc } from "./buyTickets.js";

describe("ticketsFromUsdc", () => {
  it("multiplies by the pool's tickets-per-USDC rate", () => {
    expect(ticketsFromUsdc(1_000_000n, 10)).toBe(10_000_000n);
  });

  it("counts at full value, with no discount for the time left in the epoch", () => {
    expect(ticketsFromUsdc(86_400n, 1)).toBe(86_400n);
  });

  it("is zero for a zero amount", () => {
    expect(ticketsFromUsdc(0n, 10)).toBe(0n);
  });
});

describe("buyTicketsVisible", () => {
  it("shows only when neither the Vercel gate nor the on-chain pause says no", () => {
    expect(buyTicketsVisible(false, false)).toBe(true);
    expect(buyTicketsVisible(true, false)).toBe(false);
    expect(buyTicketsVisible(false, true)).toBe(false);
  });

  it("hides while the on-chain pause is unknown", () => {
    expect(buyTicketsVisible(false, null)).toBe(false);
  });
});

describe("buyDisabledReason", () => {
  const base = { paused: false, shutdown: false, principal: 100n, allowanceLeft: 50n };

  it("is enabled when nothing blocks it", () => {
    expect(buyDisabledReason(base)).toBeNull();
  });

  it("is disabled while the pool is paused", () => {
    expect(buyDisabledReason({ ...base, paused: true })).toBe("pool is paused");
  });

  it("is disabled once the pool is shut down, ahead of the paused reason", () => {
    expect(buyDisabledReason({ ...base, paused: true, shutdown: true })).toBe(
      "pool is closed",
    );
  });

  it("is disabled with zero Principal", () => {
    expect(buyDisabledReason({ ...base, principal: 0n, allowanceLeft: 0n })).toBe(
      "deposit first",
    );
  });

  it("is disabled with zero allowance left", () => {
    expect(buyDisabledReason({ ...base, allowanceLeft: 0n })).toBe(
      "today's buy allowance is spent",
    );
  });
});
