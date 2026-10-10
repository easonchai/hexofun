// Against a real Postgres (off-chain-tickets 22): the Referral bonus job writes
// grants, shares and `grant_referral` ledger rows together, once per epoch, and
// the route's rows add up to the ledger's.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_referral_grants";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { PrismaClient } from "@prisma/client";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_GAME_CONFIG } from "../api/game-config";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { grantReferralBonuses, referralGrantsForEpoch } from "./referral-grants";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const USDC = 1_000_000n;
const POOL = Keypair.generate().publicKey.toBase58();
const OPERATOR = Keypair.generate().publicKey.toBase58();
const wallet = (): string => Keypair.generate().publicKey.toBase58();
const NOW = 1_000_000n;
const QUALIFY_SECONDS = 100;
const EPOCH = 4n;

describe.skipIf(!DB_AVAILABLE)("Referral bonus grants", () => {
  let prisma: PrismaClient;

  const run = (now = NOW) =>
    grantReferralBonuses(prisma, { poolAddress: POOL, operator: OPERATOR, now, qualifySeconds: QUALIFY_SECONDS });

  /** A Referrer with a Player of `principal` and one Referral per entry of `referees` (Principal in USDC,
   *  `null` for one still below the qualifying line). */
  async function referrerWith(principal: bigint, referees: (bigint | null)[]) {
    const referrer = wallet();
    await prisma.player.create({
      data: {
        poolAddress: POOL, owner: referrer, principal: principal * USDC, epochId: EPOCH, isHouse: false,
        pendingWithdraw: 0n, pendingEpoch: 0n, boughtEpoch: 0n, boughtAmount: 0n,
      },
    });
    await prisma.ticketBalance.create({ data: { poolAddress: POOL, owner: referrer, tickets: principal * USDC, principal: principal * USDC, epochId: EPOCH } });
    const rows = referees.map((usdc) => ({
      referee: wallet(), referrer, code: "AAAAAA", boundAt: 1n,
      principal: (usdc ?? 10n) * USDC, aboveSince: usdc === null ? null : NOW - BigInt(QUALIFY_SECONDS),
    }));
    await prisma.referral.createMany({ data: rows });
    return { referrer, referees: rows.map((r) => r.referee) };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    // Connect here, so the first beforeEach's TRUNCATE does not also pay for the connect under a full parallel run.
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Pool", "Referral", "TicketLedger", "TicketBalance", "GameConfig" RESTART IDENTITY CASCADE',
    );
    await prisma.pool.create({
      data: {
        address: POOL, poolId: 1n, admin: wallet(), operator: OPERATOR, mint: wallet(), epochSeconds: 86_400n,
        epochAnchor: 0n, minDeposit: 0n, paused: false, currentEpochId: EPOCH, currentEpochEndsAt: 0n,
        previousEpochEndsAt: 0n, totalPrincipal: 1_000_000n * USDC, pendingWithdrawals: 0n, minJackpot: 0n,
        baseRateBps: 488, version: 1, shutdown: false, gamePaused: false, jackpotPaused: false,
        ...LIVE_POOL_DEFAULTS, updatedSlot: 0n,
      },
    });
    await prisma.cursor.create({ data: { poolAddress: POOL, ledgerEpochId: EPOCH } });
    await setCap(500);
  });

  const setCap = (bonusCapBps: number, referralTiers: unknown = DEFAULT_GAME_CONFIG.referralTiers) =>
    prisma.gameConfig.create({
      data: { poolAddress: POOL, roundSeconds: 60, houseCutBps: 600, ticketsPerUsdc: 10, bonusCapBps, referralTiers: referralTiers as object, maxTilesPerBet: 36 },
    });

  const grantRows = () =>
    prisma.ticketLedger.findMany({ where: { poolAddress: POOL, reason: "grant_referral" }, orderBy: { owner: "asc" } });

  it("grants once under a retried tick, and the route's sums equal the ledger's", async () => {
    // 3 qualified referees at 100 USDC: tier 2 (300 bps) of 300 USDC = 9 USDC. The unqualified one counts for nothing.
    const a = await referrerWith(1_000n, [100n, 100n, 100n, null]);
    const b = await referrerWith(1_000n, [200n]); // tier 1 (200 bps) of 200 USDC = 4 USDC

    expect(await run()).toBe(2);
    expect(await run()).toBe(0); // the retried tick
    expect(await run(NOW + 50n)).toBe(0);

    const ledger = await grantRows();
    expect(ledger).toHaveLength(2);
    for (const row of ledger) {
      expect(row).toMatchObject({ epochId: EPOCH, ref: `referral:${EPOCH}`, signer: OPERATOR, signature: null });
    }
    const balance = await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner: a.referrer } } });
    expect(balance.tickets).toBe(1_000n * USDC + 9n * USDC);

    const { grants } = await referralGrantsForEpoch(prisma, POOL, EPOCH);
    expect(grants.map((g) => [g.referrer, g.amount, g.tier]).sort()).toEqual(
      [[a.referrer, 9n * USDC, 2], [b.referrer, 4n * USDC, 1]].sort(),
    );
    const ledgerSum = new Map(ledger.map((row) => [row.owner, row.delta]));
    for (const grant of grants) {
      expect(grant.amount).toBe(ledgerSum.get(grant.referrer));
      expect(grant.referrals.reduce((sum, r) => sum + r.share, 0n)).toBe(grant.amount);
      expect(grant).toMatchObject({ referrerPrincipal: 1_000n * USDC, totalPrincipal: 1_000_000n * USDC, bonusCapBps: 500 });
    }
    expect(grants.find((g) => g.referrer === a.referrer)?.referrals.map((r) => r.principal)).toEqual([100n * USDC, 100n * USDC, 100n * USDC]);
  });

  it("scales every grant against the pool-wide cap of the Game config row in force", async () => {
    await setCap(1); // 1 bps of 1,000,000 USDC = 100 USDC; the newest row wins over the 500 bps one
    await referrerWith(10_000n, [2_000n, 2_000n]); // 2% of 4,000 USDC = 80 USDC
    await referrerWith(10_000n, [2_500n, 2_500n]); // 2% of 5,000 USDC = 100 USDC; together 180, scaled to 100
    expect(await run()).toBe(2);
    const { grants } = await referralGrantsForEpoch(prisma, POOL, EPOCH);
    const total = grants.reduce((sum, g) => sum + g.amount, 0n);
    expect(total).toBeLessThanOrEqual(100n * USDC);
    expect(total).toBeGreaterThan(99n * USDC); // 180 USDC scaled to the 100 USDC cap, floored per grant
    expect(grants.every((g) => g.bonusCapBps === 1)).toBe(true);
  });

  it("pays at the tiers of the Game config row in force, and the route keeps the tier it was paid at", async () => {
    await setCap(500, [{ tier: 7, min: 1, max: null, rateBps: 1000 }]); // newest row: one tier, 10%
    const a = await referrerWith(1_000n, [100n, 100n, 100n]); // the seed tiers would pay 3% of 300 = 9 USDC
    expect(await run()).toBe(1);
    expect((await grantRows()).map((r) => r.delta)).toEqual([30n * USDC]);

    await setCap(500); // a later change back to the seed tiers must not rewrite the booked grant
    const { grants } = await referralGrantsForEpoch(prisma, POOL, EPOCH);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ referrer: a.referrer, amount: 30n * USDC, tier: 7, rateBps: 1000 });
  });

  it("throws when the row in force has tiers that do not parse, instead of using the seed", async () => {
    await setCap(500, [{ tier: 1, min: 0, max: null, rateBps: 200 }]);
    await referrerWith(1_000n, [100n]);
    await expect(run()).rejects.toThrow(/referralTiers do not parse/);
    expect(await grantRows()).toEqual([]);
  });

  it("grants a Referrer that qualifies later against the headroom the first grants left", async () => {
    const first = await referrerWith(1_000n, [100n]);
    expect(await run()).toBe(1);
    const late = await referrerWith(1_000n, [100n]);
    expect(await run()).toBe(1);
    const rows = await grantRows();
    expect(rows.map((r) => r.owner).sort()).toEqual([first.referrer, late.referrer].sort());
  });

  it("writes nothing for an epoch with no qualifying Referrer, and the route lists nothing", async () => {
    await referrerWith(1_000n, [null]);
    expect(await run()).toBe(0);
    expect(await grantRows()).toEqual([]);
    expect(await prisma.referralGrant.count()).toBe(0);
    expect(await referralGrantsForEpoch(prisma, POOL, EPOCH)).toEqual({ epochId: EPOCH, grants: [] });
  });

  it("waits for the ledger to reach the first epoch", async () => {
    await referrerWith(1_000n, [100n]);
    await prisma.cursor.update({ where: { poolAddress: POOL }, data: { ledgerEpochId: 0n } });
    expect(await run()).toBe(0);
    expect(await grantRows()).toEqual([]);
  });

  it("books each epoch on its own", async () => {
    const a = await referrerWith(1_000n, [100n]);
    expect(await run()).toBe(1);
    await prisma.cursor.update({ where: { poolAddress: POOL }, data: { ledgerEpochId: EPOCH + 1n } });
    expect(await run()).toBe(1);
    expect((await grantRows()).map((r) => [r.owner, r.epochId])).toEqual([[a.referrer, EPOCH], [a.referrer, EPOCH + 1n]]);
  });
});
