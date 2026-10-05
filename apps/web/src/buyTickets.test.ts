import { describe, expect, it } from "vitest";

import { buyDisabledReason, buyTicketsVisible, drawValue, ticketsFromUsdc } from "./buyTickets.js";

const EPOCH_SECONDS = 86_400n;

describe("drawValue", () => {
  it("is worth full face value at the start of the day", () => {
    expect(drawValue(100n, EPOCH_SECONDS, EPOCH_SECONDS)).toBe(100n);
  });

  it("is worth half at the middle of the day", () => {
    expect(drawValue(100n, EPOCH_SECONDS / 2n, EPOCH_SECONDS)).toBe(50n);
  });

  it("is worth almost nothing in the draw's last minute", () => {
    expect(drawValue(86_400n, 60n, EPOCH_SECONDS)).toBe(60n);
  });

  it("clamps a negative seconds-left to zero", () => {
    expect(drawValue(100n, -5n, EPOCH_SECONDS)).toBe(0n);
  });

  it("clamps seconds-left over the epoch length", () => {
    expect(drawValue(100n, EPOCH_SECONDS * 2n, EPOCH_SECONDS)).toBe(100n);
  });

  it("is zero with no epoch length", () => {
    expect(drawValue(100n, 100n, 0n)).toBe(0n);
  });
});

describe("ticketsFromUsdc", () => {
  it("multiplies by the pool's tickets-per-USDC rate", () => {
    expect(ticketsFromUsdc(1_000_000n, 10)).toBe(10_000_000n);
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
