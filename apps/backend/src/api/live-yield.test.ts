// The read model's live-yield arithmetic (yield-claimer ticket 14), pure.
import { describe, expect, it } from "vitest";

import {
  INDEX_SCALE,
  decodeReserve,
  effectiveTickets,
  estimatedRateBps,
  freeIdle,
  haircutFactor,
  instantWithdrawCoverable,
  pendingTickets,
  solvencyMargin,
  supplyRateBps,
  trailingRate,
  unsettledYield,
  type PoolAssets,
  type ReserveStats,
} from "./live-yield";

const DAY = 86_400n;
const YEAR = 31_536_000n;
const ONE_PERCENT = INDEX_SCALE / 100n;

describe("effectiveTickets and pendingTickets", () => {
  // 300 of Principal, 200 of it deposited in epoch 4, so 100 Tickets are active.
  const player = {
    principal: 300n,
    entries: 100n,
    epochId: 4n,
    pendingDeposit: 200n,
    pendingDepositEpoch: 4n,
  };

  it("counts the active Tickets and holds the deposit pending in the epoch it was made", () => {
    expect(effectiveTickets(player, 4n)).toBe(100n);
    expect(pendingTickets(player, 4n)).toBe(200n);
  });

  it("folds the pending deposit into Tickets from the next epoch, without a touch", () => {
    expect(effectiveTickets(player, 5n)).toBe(300n);
    expect(pendingTickets(player, 5n)).toBe(0n);
    expect(effectiveTickets(player, 9n)).toBe(300n);
  });

  it("reads zero pending for a Player who never deposited", () => {
    expect(pendingTickets({ pendingDeposit: 0n, pendingDepositEpoch: 0n }, 3n)).toBe(0n);
  });
});

describe("unsettledYield", () => {
  it("is principal times the index rise since the last settle, rounded down", () => {
    expect(unsettledYield(1_000_000n, 2n * INDEX_SCALE, INDEX_SCALE)).toBe(1_000_000n);
    expect(unsettledYield(100n, INDEX_SCALE + INDEX_SCALE / 3n, INDEX_SCALE)).toBe(33n);
  });

  it("is zero while the index has not moved, and never negative", () => {
    expect(unsettledYield(1_000_000n, INDEX_SCALE, INDEX_SCALE)).toBe(0n);
    expect(unsettledYield(1_000_000n, INDEX_SCALE, 2n * INDEX_SCALE)).toBe(0n);
  });
});

describe("trailingRate", () => {
  // 1% of index rise over exactly one year is 100 bps a year.
  const latest = { at: 1_000n * DAY, yieldIndex: INDEX_SCALE + ONE_PERCENT };

  it("annualises the index rise over the window", () => {
    const start = { at: latest.at - YEAR, yieldIndex: INDEX_SCALE };
    expect(trailingRate(latest, start, Number(YEAR))).toEqual({
      aprBps: 100,
      windowSeconds: Number(YEAR),
      shortHistory: false,
    });
  });

  it("scales a one-day rise up to a year", () => {
    const start = { at: latest.at - DAY, yieldIndex: INDEX_SCALE };
    const rate = trailingRate(latest, start, Number(DAY));
    expect(rate.aprBps).toBe(36_500);
    expect(rate.shortHistory).toBe(false);
  });

  it("uses what exists and says so when history is shorter than the window", () => {
    const start = { at: latest.at - DAY / 2n, yieldIndex: INDEX_SCALE };
    const rate = trailingRate(latest, start, Number(DAY));
    expect(rate.windowSeconds).toBe(Number(DAY / 2n));
    expect(rate.shortHistory).toBe(true);
    expect(rate.aprBps).toBe(73_000);
  });

  it("reports unknown, not zero, with nothing to compare", () => {
    expect(trailingRate(latest, null, Number(DAY))).toEqual({
      aprBps: null,
      windowSeconds: 0,
      shortHistory: true,
    });
    expect(trailingRate(latest, latest, Number(DAY)).aprBps).toBeNull();
  });
});

// Mainnet's USDC reserve on 2026-10-05: 10.49M free, 110.6M borrowed, curve
// 0% at 0 utilisation, 5.51% at 95%, 36.34% at 100%, klend keeps 10%.
const RESERVE: ReserveStats = {
  available: 10_494_662_422_077n,
  borrowed: 110_631_257_105_092n,
  protocolTakeRatePct: 10,
  curve: [
    { utilBps: 0, rateBps: 0 },
    { utilBps: 9_500, rateBps: 551 },
    ...Array.from({ length: 9 }, () => ({ utilBps: 10_000, rateBps: 3_634 })),
  ],
};

describe("supplyRateBps", () => {
  it("is the borrow rate at the current utilisation, times utilisation, less klend's cut", () => {
    // 91.3% utilised: 551 * 0.913 / 0.95 ~ 529.5 bps borrow, x 0.913 x 0.9 ~ 435 bps.
    const rate = supplyRateBps(RESERVE) as number;
    expect(rate).toBeGreaterThan(430);
    expect(rate).toBeLessThan(440);
  });

  it("follows the steep leg past the kink", () => {
    const rate = supplyRateBps({ ...RESERVE, available: 1_000n, borrowed: 99_000n }) as number;
    // 99% utilised: borrow 551 + (3634 - 551) * 0.8 = 3017 bps, x 0.99 x 0.9.
    expect(rate).toBeGreaterThan(2_600);
    expect(rate).toBeLessThan(2_750);
  });

  it("is unknown for an empty reserve", () => {
    expect(supplyRateBps({ ...RESERVE, available: 0n, borrowed: 0n })).toBeNull();
  });
});

describe("decodeReserve", () => {
  it("reads liquidity, take rate and curve from the offsets klend lays them at", () => {
    const data = Buffer.alloc(8_624);
    data.writeBigUInt64LE(5_000n, 224);
    // klend's borrowed amount is a u128 with 60 fractional bits.
    const borrowedSf = 7_000n << 60n;
    data.writeBigUInt64LE(borrowedSf & 0xffff_ffff_ffff_ffffn, 232);
    data.writeBigUInt64LE(borrowedSf >> 64n, 240);
    data.writeUInt8(10, 4_870);
    data.writeUInt32LE(9_500, 4_920 + 8);
    data.writeUInt32LE(551, 4_920 + 12);
    const reserve = decodeReserve(data);
    expect(reserve.available).toBe(5_000n);
    expect(reserve.borrowed).toBe(7_000n);
    expect(reserve.protocolTakeRatePct).toBe(10);
    expect(reserve.curve[1]).toEqual({ utilBps: 9_500, rateBps: 551 });
    expect(reserve.curve).toHaveLength(11);
  });

  it("refuses an account too short to be a reserve", () => {
    expect(() => decodeReserve(Buffer.alloc(200))).toThrow(/too short/);
  });
});

describe("estimatedRateBps", () => {
  const base = { venueValue: 90n, freeIdle: 10n, yieldFeeBps: 1_000, ceilingBps: 488 };

  it("is the venue rate times the deployed share, less the fee", () => {
    // 6.5% venue, 90% deployed, 10% fee: about 5.3%, as the spec's example says.
    const rate = estimatedRateBps({ ...base, supplyRateBps: 650, ceilingBps: 10_000 }) as number;
    expect(rate).toBeCloseTo(526.5, 5);
  });

  it("is capped at the ceiling", () => {
    expect(estimatedRateBps({ ...base, supplyRateBps: 650 })).toBe(488);
  });

  it("is unknown while the rate or the vault is unknown", () => {
    expect(estimatedRateBps({ ...base, supplyRateBps: null })).toBeNull();
    expect(estimatedRateBps({ ...base, supplyRateBps: 650, freeIdle: null })).toBeNull();
  });

  it("is zero for a pool holding nothing", () => {
    expect(estimatedRateBps({ ...base, supplyRateBps: 650, venueValue: 0n, freeIdle: 0n })).toBe(0);
  });
});

describe("instantWithdrawCoverable", () => {
  it("is covered by free idle alone", () => {
    expect(instantWithdrawCoverable(100n, 100n, 0n, 0n)).toBe(true);
    expect(instantWithdrawCoverable(101n, 100n, 0n, 0n)).toBe(false);
  });

  it("adds what the reserve can free, but never more than the pool holds there", () => {
    expect(instantWithdrawCoverable(150n, 100n, 500n, 50n)).toBe(true);
    expect(instantWithdrawCoverable(151n, 100n, 500n, 50n)).toBe(false);
    expect(instantWithdrawCoverable(150n, 100n, 40n, 1_000n)).toBe(false);
  });
});

describe("freeIdle", () => {
  it("is the vault less the queued withdrawals, never negative", () => {
    expect(freeIdle(100n, 30n)).toBe(70n);
    expect(freeIdle(20n, 30n)).toBe(0n);
  });
});

describe("solvency and haircut", () => {
  const pool: PoolAssets = {
    totalPrincipal: 1_000n,
    pendingWithdrawals: 100n,
    venueValue: 800n,
    yieldOwed: 10n,
    feeOwed: 5n,
    prizeOwed: 5n,
    deficit: 0n,
  };

  it("is the signed margin of vault plus venue over every liability", () => {
    // 400 + 800 = 1200 against 1000 + 100 + 20 = 1120.
    expect(solvencyMargin(pool, 400n)).toBe(80n);
    expect(solvencyMargin(pool, 300n)).toBe(-20n);
  });

  it("counts the recorded deficit as a liability the pool is excused from", () => {
    expect(solvencyMargin({ ...pool, deficit: 50n }, 300n)).toBe(30n);
  });

  it("pays net assets over claims, capped at 1", () => {
    // Net 1200 - 20 = 1180 over claims 1100.
    expect(haircutFactor(pool, 400n)).toBe(1);
    // An empty vault: net 800 - 20 = 780 over claims 1100.
    expect(haircutFactor(pool, 0n)).toBeCloseTo(0.70909, 5);
  });

  it("is zero for a pool with no claims", () => {
    expect(haircutFactor({ ...pool, totalPrincipal: 0n, pendingWithdrawals: 0n }, 0n)).toBe(0);
  });
});
