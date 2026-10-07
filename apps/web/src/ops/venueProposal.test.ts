import { describe, expect, it } from "vitest";

import { drainAccess, migrateAccess, proposalView, venueKindName } from "./venueProposal.js";

const proposal = (unlocksAt: number) => ({
  venueKind: 2,
  klendProgram: "P",
  klendMarket: "M",
  klendReserve: "R",
  klendCtoken: "C",
  proposedAt: String(unlocksAt - 172_800),
  unlocksAt: String(unlocksAt),
});

describe("proposalView", () => {
  it("is unavailable when the summary carries no proposal field, never 'none'", () => {
    expect(proposalView({} as never, 1_000)).toEqual({ state: "unavailable" });
  });

  it("is none when the API reports no open proposal", () => {
    expect(proposalView({ venueProposal: null }, 1_000)).toEqual({ state: "none" });
  });

  it("shows the target, the kind and the time left while the lock runs", () => {
    expect(proposalView({ venueProposal: proposal(1_000 + 7_300) }, 1_000)).toEqual({
      state: "locked",
      kind: "kVault",
      reserve: "R",
      unlock: "in 2 h",
      unlocksAt: new Date((1_000 + 7_300) * 1000).toISOString(),
    });
  });

  it("says unlocked once the lock has elapsed, and at the exact second", () => {
    expect(proposalView({ venueProposal: proposal(1_000) }, 1_000).state).toBe("unlocked");
    expect(proposalView({ venueProposal: proposal(1_000) }, 1_000 + 185)).toMatchObject({
      state: "unlocked",
      unlock: "3 min ago",
    });
  });
});

describe("venueKindName", () => {
  it("names the kinds, flags an unknown one and shows null as unavailable", () => {
    expect([0, 1, 2].map(venueKindName)).toEqual(["klend", "stub", "kVault"]);
    expect(venueKindName(9)).toBe("unknown (9)");
    expect(venueKindName(null)).toBe("unavailable");
  });
});

describe("drainAccess", () => {
  const base = { admin: "ADMIN", operatorKey: "OPERATOR" };

  it("lets the Admin and the Operator drain with no proposal, and nobody else", () => {
    const none = { ...base, venueProposal: null };
    expect(drainAccess(none, "ADMIN")).toEqual({ allowed: true });
    expect(drainAccess(none, "OPERATOR")).toEqual({ allowed: true });
    expect(drainAccess(none, "STRANGER")).toMatchObject({ allowed: false, reason: expect.stringMatching(/only the Admin or the Operator/) });
  });

  it("lets any connected wallet drain while a proposal is open", () => {
    expect(drainAccess({ ...base, venueProposal: proposal(1_000) }, "STRANGER")).toEqual({ allowed: true });
  });

  it("says why when no wallet is connected or the backend is too old to tell", () => {
    expect(drainAccess({ ...base, venueProposal: null }, null)).toMatchObject({ allowed: false });
    expect(drainAccess({ admin: "A" } as never, "A")).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/venue proposal/),
    });
    expect(drainAccess({ venueProposal: null, admin: null, operatorKey: null }, "A")).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Admin and Operator/),
    });
  });
});

describe("migrateAccess", () => {
  const params = { minVenueMove: "100000000" } as never;
  const summary = (unlocksAt: number, venueValue: string, venueParams = params) => ({
    venueProposal: proposal(unlocksAt),
    venueValue,
    venueParams,
  });

  it("is allowed once the lock has elapsed and the position is at or under min_venue_move", () => {
    expect(migrateAccess(summary(1_000, "100000000"), 1_000)).toEqual({ allowed: true });
    expect(migrateAccess(summary(1_000, "0"), 5_000)).toEqual({ allowed: true });
  });

  it("says why when there is no proposal, the lock runs, or the position is above dust", () => {
    expect(migrateAccess({ venueProposal: null, venueValue: "0", venueParams: params }, 1)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/No venue proposal/),
    });
    expect(migrateAccess(summary(8_200, "0"), 1_000)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/lock ends in 2 h/),
    });
    expect(migrateAccess(summary(1_000, "100000001"), 2_000)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Drain it first/),
    });
  });

  it("never offers the button on a read it cannot make", () => {
    expect(migrateAccess({ venueValue: "0", venueParams: params } as never, 1)).toMatchObject({ allowed: false });
    expect(migrateAccess(summary(1_000, "0", null as never), 2_000)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/minimum venue move/),
    });
  });
});
