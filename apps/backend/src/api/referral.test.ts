import { describe, expect, it } from "vitest";

import {
  applyReferralEvent,
  daysToQualify,
  DEFAULT_REFERRAL_QUALIFY_SECONDS,
  isQualified,
  nextPrincipal,
  REFERRAL_QUALIFY_PRINCIPAL,
  type ReferralQualificationState,
} from "./referral";

const T0 = 1_000_000n;

describe("nextPrincipal", () => {
  it("Deposited takes the event's absolute principal, ignoring the previous value", () => {
    expect(nextPrincipal(10n, { kind: "Deposited", principal: 999n })).toBe(999n);
  });

  it("WithdrawRequested subtracts the request amount", () => {
    expect(nextPrincipal(100n, { kind: "WithdrawRequested", amount: 40n })).toBe(60n);
  });

  it("WithdrawRequested clamps at 0 instead of going negative", () => {
    expect(nextPrincipal(10n, { kind: "WithdrawRequested", amount: 40n })).toBe(0n);
  });

  it("InstantWithdrawn sets the Principal it carries", () => {
    expect(nextPrincipal(100n, { kind: "InstantWithdrawn", principal: 60n })).toBe(60n);
  });

  it("JackpotPaid adds the compounded prize", () => {
    expect(nextPrincipal(100n, { kind: "JackpotPaid", amount: 250n })).toBe(350n);
  });
});

describe("applyReferralEvent", () => {
  const below: ReferralQualificationState = { principal: 10_000_000n, aboveSince: null };

  it("crosses up through 50 USDC on a deposit and stamps aboveSince", () => {
    const next = applyReferralEvent(
      below,
      { kind: "Deposited", principal: REFERRAL_QUALIFY_PRINCIPAL },
      T0,
    );
    expect(next).toEqual({ principal: REFERRAL_QUALIFY_PRINCIPAL, aboveSince: T0 });
  });

  it("a pending withdrawal dropping Principal below 50 USDC clears aboveSince", () => {
    const above: ReferralQualificationState = {
      principal: 60_000_000n,
      aboveSince: T0,
    };
    const next = applyReferralEvent(
      above,
      { kind: "WithdrawRequested", amount: 20_000_000n },
      T0 + 500n,
    );
    expect(next).toEqual({ principal: 40_000_000n, aboveSince: null });
  });

  it("yield pushing Principal over the line sets aboveSince", () => {
    const almost: ReferralQualificationState = {
      principal: 49_999_999n,
      aboveSince: null,
    };
    const next = applyReferralEvent(almost, { kind: "JackpotPaid", amount: 1n }, T0);
    expect(next).toEqual({ principal: REFERRAL_QUALIFY_PRINCIPAL, aboveSince: T0 });
  });

  it("a dip then a restore crosses twice, and the restore's timestamp is the new aboveSince (the clock restarts)", () => {
    const above: ReferralQualificationState = { principal: 60_000_000n, aboveSince: T0 };
    const dipped = applyReferralEvent(
      above,
      { kind: "WithdrawRequested", amount: 15_000_000n },
      T0 + 100n,
    );
    expect(dipped).toEqual({ principal: 45_000_000n, aboveSince: null });

    const restored = applyReferralEvent(
      dipped,
      { kind: "Deposited", principal: 55_000_000n },
      T0 + 200n,
    );
    expect(restored).toEqual({ principal: 55_000_000n, aboveSince: T0 + 200n });
  });

  it("staying above does not restart the clock", () => {
    const above: ReferralQualificationState = { principal: 60_000_000n, aboveSince: T0 };
    const next = applyReferralEvent(above, { kind: "JackpotPaid", amount: 1_000n }, T0 + 999n);
    expect(next).toEqual({ principal: 60_001_000n, aboveSince: T0 });
  });

  it("staying below leaves aboveSince null", () => {
    const next = applyReferralEvent(below, { kind: "JackpotPaid", amount: 1n }, T0);
    expect(next).toEqual({ principal: 10_000_001n, aboveSince: null });
  });

  it("landing exactly on the threshold counts as at or above it", () => {
    const next = applyReferralEvent(below, { kind: "Deposited", principal: REFERRAL_QUALIFY_PRINCIPAL }, T0);
    expect(next.aboveSince).toBe(T0);
  });
});

describe("isQualified", () => {
  it("is false with no aboveSince", () => {
    expect(isQualified(null, T0)).toBe(false);
  });

  it("is false before the hold period elapses", () => {
    const now = T0 + BigInt(DEFAULT_REFERRAL_QUALIFY_SECONDS) - 1n;
    expect(isQualified(T0, now)).toBe(false);
  });

  it("is true exactly at the hold period", () => {
    const now = T0 + BigInt(DEFAULT_REFERRAL_QUALIFY_SECONDS);
    expect(isQualified(T0, now)).toBe(true);
  });

  it("is true well past the hold period", () => {
    const now = T0 + BigInt(DEFAULT_REFERRAL_QUALIFY_SECONDS) * 3n;
    expect(isQualified(T0, now)).toBe(true);
  });

  it("honors a shortened devnet qualifySeconds", () => {
    expect(isQualified(T0, T0 + 60n, 60)).toBe(true);
    expect(isQualified(T0, T0 + 59n, 60)).toBe(false);
  });
});

describe("daysToQualify", () => {
  it("is null with no aboveSince", () => {
    expect(daysToQualify(null, T0)).toBeNull();
  });

  it("is 0 once already qualified", () => {
    const now = T0 + BigInt(DEFAULT_REFERRAL_QUALIFY_SECONDS) + 1_000n;
    expect(daysToQualify(T0, now)).toBe(0);
  });

  it("rounds a partial day up", () => {
    // One second short of 7 days elapsed: 1 second of the 7th day remains.
    const now = T0 + BigInt(DEFAULT_REFERRAL_QUALIFY_SECONDS) - 1n;
    expect(daysToQualify(T0, now)).toBe(1);
  });

  it("reports whole days remaining right after crossing", () => {
    expect(daysToQualify(T0, T0)).toBe(7);
  });
});
