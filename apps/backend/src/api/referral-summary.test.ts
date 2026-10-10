// Pure, DB-free (docs/plan/hexo-referrals ticket 11): mirrors referral.test.ts
// and referral-bonus.test.ts's own table-test style.
import { describe, expect, it } from "vitest";

import { RATE_TIERS } from "./referral-bonus";
import { buildReferralsResponse, maskWallet, type ReferralInput } from "./referral-summary";

const referral = (overrides: Partial<ReferralInput> & { referee: string }): ReferralInput => ({
  aboveSince: null,
  boundAt: 0n,
  bonusToday: 0n,
  ...overrides,
});

const NOW = 1_700_000_000n;
const QUALIFY_SECONDS = 604_800;
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("maskWallet", () => {
  it("keeps a short string as-is", () => {
    expect(maskWallet("short")).toBe("short");
  });

  it("masks a base58 wallet to first4…last4", () => {
    expect(maskWallet(WALLET)).toBe("9xQe…VFin");
  });
});

const NO_BONUS = { amount: 0n, uncapped: 0n };

describe("buildReferralsResponse", () => {
  it("is the empty state for a wallet with no referrals", () => {
    const response = buildReferralsResponse(RATE_TIERS, null, [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(response).toEqual({
      referralCode: null,
      referrals: { items: [], nextCursor: null },
      qualifiedCount: 0,
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      bonusToday: NO_BONUS,
    });
  });

  // beta-launch-fixes ticket 13: invite codes are private, so the response
  // never carries an `inviteCodes` field at all.
  it("never returns an inviteCodes field", () => {
    const response = buildReferralsResponse(RATE_TIERS, null, [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(response).not.toHaveProperty("inviteCodes");
  });

  it("passes the wallet's own referral code through, null before its first deposit", () => {
    const withCode = buildReferralsResponse(RATE_TIERS, "ABCD2345", [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(withCode.referralCode).toBe("ABCD2345");

    const withoutCode = buildReferralsResponse(RATE_TIERS, null, [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(withoutCode.referralCode).toBeNull();
  });

  it("masks each referral's wallet and reports qualified / holding / below status with daysLeft", () => {
    const referrals: ReferralInput[] = [
      referral({ referee: WALLET, aboveSince: NOW - BigInt(QUALIFY_SECONDS), boundAt: 3n }), // exactly qualified
      referral({ referee: WALLET, aboveSince: NOW - 100_000n, boundAt: 2n }), // above, holding
      referral({ referee: WALLET, aboveSince: null, boundAt: 1n }), // below $50
    ];
    const response = buildReferralsResponse(RATE_TIERS, null, referrals, NOW, QUALIFY_SECONDS, NO_BONUS);
    // Newest boundAt first.
    expect(response.referrals.items).toEqual([
      { wallet: "9xQe…VFin", status: "qualified", daysLeft: null, bonusToday: 0n, joinedAt: 3n },
      { wallet: "9xQe…VFin", status: "holding", daysLeft: 6, bonusToday: 0n, joinedAt: 2n },
      { wallet: "9xQe…VFin", status: "below", daysLeft: null, bonusToday: 0n, joinedAt: 1n },
    ]);
    expect(response.referrals.nextCursor).toBeNull();
    expect(response.qualifiedCount).toBe(1);
  });

  it("passes each referral's own bonusToday share through unchanged", () => {
    const referrals: ReferralInput[] = [
      referral({ referee: WALLET, bonusToday: 6_000_000n, boundAt: 1n }),
    ];
    const response = buildReferralsResponse(RATE_TIERS, null, referrals, NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(response.referrals.items[0]?.bonusToday).toBe(6_000_000n);
  });

  it("bands over the tiers it is given", () => {
    const response = buildReferralsResponse(
      [{ tier: 1, min: 1, max: null, rateBps: 1000 }],
      null,
      [],
      NOW,
      QUALIFY_SECONDS,
      NO_BONUS,
    );
    expect(response.nextBand).toEqual({ tier: 1, rateBps: 1000, minCount: 1, maxCount: null });
  });

  it("passes today's bonus amount and uncapped through unchanged", () => {
    const response = buildReferralsResponse(RATE_TIERS, null, [], NOW, QUALIFY_SECONDS, {
      amount: 10_000_000n,
      uncapped: 72_000_000n,
    });
    expect(response.bonusToday).toEqual({ amount: 10_000_000n, uncapped: 72_000_000n });
  });

  // referral-page ticket 05: cursor pagination, newest boundAt first.
  describe("referrals pagination", () => {
    const manyReferrals = (count: number): ReferralInput[] =>
      Array.from({ length: count }, (_, i) =>
        referral({ referee: `${WALLET}${i}`, boundAt: BigInt(i) }),
      );

    it("defaults to a page of 50, newest boundAt first", () => {
      const response = buildReferralsResponse(
        RATE_TIERS,
        null,
        manyReferrals(60),
        NOW,
        QUALIFY_SECONDS,
        NO_BONUS,
      );
      expect(response.referrals.items).toHaveLength(50);
      expect(response.referrals.items[0]?.joinedAt).toBe(59n); // newest first
      expect(response.referrals.items[49]?.joinedAt).toBe(10n);
      expect(response.referrals.nextCursor).not.toBeNull();
    });

    it("a nextCursor's page picks up right after it, and the last page has no nextCursor", () => {
      const first = buildReferralsResponse(
        RATE_TIERS,
        null,
        manyReferrals(60),
        NOW,
        QUALIFY_SECONDS,
        NO_BONUS,
        null,
        50,
      );
      const second = buildReferralsResponse(
        RATE_TIERS,
        null,
        manyReferrals(60),
        NOW,
        QUALIFY_SECONDS,
        NO_BONUS,
        first.referrals.nextCursor,
        50,
      );
      expect(second.referrals.items).toHaveLength(10);
      expect(second.referrals.items[0]?.joinedAt).toBe(9n);
      expect(second.referrals.nextCursor).toBeNull();
    });

    it("respects an explicit limit", () => {
      const response = buildReferralsResponse(
        RATE_TIERS,
        null,
        manyReferrals(5),
        NOW,
        QUALIFY_SECONDS,
        NO_BONUS,
        null,
        2,
      );
      expect(response.referrals.items).toHaveLength(2);
      expect(response.referrals.nextCursor).not.toBeNull();
    });

    it("qualifiedCount counts every referral, not just the page", () => {
      const referrals = manyReferrals(3).map((r) => ({ ...r, aboveSince: 0n }));
      const response = buildReferralsResponse(
        RATE_TIERS,
        null,
        referrals,
        BigInt(QUALIFY_SECONDS), // now == qualifySeconds, so aboveSince 0 is exactly qualified
        QUALIFY_SECONDS,
        NO_BONUS,
        null,
        1, // page of 1, but all 3 are qualified
      );
      expect(response.referrals.items).toHaveLength(1);
      expect(response.qualifiedCount).toBe(3);
    });
  });

  // Every band edge referral-bonus.ts's RATE_TIERS defines, plus 11+, so the
  // web pure test ("N more to reach X%") has a backend-verified table to
  // match against.
  const BAND_EDGES: {
    qualifiedCount: number;
    band: { tier: number; rateBps: number; minCount: number; maxCount: number | null };
    nextBand: { tier: number; rateBps: number; minCount: number; maxCount: number | null } | null;
  }[] = [
    {
      qualifiedCount: 0,
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
    },
    {
      qualifiedCount: 1,
      band: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      nextBand: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
    },
    {
      qualifiedCount: 2,
      band: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      nextBand: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
    },
    {
      qualifiedCount: 3,
      band: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
      nextBand: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
    },
    {
      qualifiedCount: 5,
      band: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
      nextBand: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
    },
    {
      qualifiedCount: 6,
      band: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
      nextBand: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
    },
    {
      qualifiedCount: 10,
      band: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
      nextBand: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
    },
    {
      qualifiedCount: 11,
      band: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
      nextBand: null,
    },
  ];

  it.each(BAND_EDGES)(
    "bands $qualifiedCount qualified referrals as $band.tier, next $nextBand.tier",
    ({ qualifiedCount, band, nextBand }) => {
      const referrals: ReferralInput[] = Array.from({ length: qualifiedCount }, () =>
        referral({ referee: WALLET, aboveSince: NOW - BigInt(QUALIFY_SECONDS) }), // exactly qualified
      );
      const response = buildReferralsResponse(RATE_TIERS, null, referrals, NOW, QUALIFY_SECONDS, NO_BONUS);
      expect(response.qualifiedCount).toBe(qualifiedCount);
      expect(response.band).toEqual(band);
      expect(response.nextBand).toEqual(nextBand);
    },
  );
});
