import { describe, expect, it } from "vitest";

import {
  buyDisabledReason,
  buyTicketsVisible,
  pendingDepositNote,
} from "./buyTickets.js";

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

describe("pendingDepositNote", () => {
  it("is absent with no Pending deposit", () => {
    expect(pendingDepositNote(0n)).toBeNull();
  });

  it("says the new deposit counts from the next epoch", () => {
    expect(pendingDepositNote(1n)).toBe("Your new deposit counts from the next epoch.");
  });
});
