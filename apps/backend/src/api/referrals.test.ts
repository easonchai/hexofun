// Against a real Postgres (docs/plan/hexo-referrals ticket 11), same shape as
// access.test.ts: a dedicated database so a rerun, or another agent's suite,
// cannot collide with these rows. ReferralsController is exercised directly,
// not through the whole ApiModule: its only ChainService call is
// `poolAddress()`, so a one-method fake stands in. The
// SerializationInterceptor is wired in here by hand (api.module.ts registers
// it for the real app) so bigint fields serialize the same way in this
// isolated test as they do in production.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_referrals";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Player, Pool } from "@prisma/client";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_PLAYER_DEFAULTS, LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { applyReferralMessage } from "./invite-code";
import { REFERRAL_QUALIFY_PRINCIPAL } from "./referral";
import { ReferralsController } from "./referrals.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const REFERRER = Keypair.generate().publicKey.toBase58();
const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
/** A pool left behind by a Pool cutover (ADR 0016). */
const RETIRED_POOL_ADDRESS = Keypair.generate().publicKey.toBase58();

/** Makes POOL_ADDRESS the Active pool. */
const fakeChain = { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL_ADDRESS) } };

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Pool", "InviteCode", "InviteRedemption", "Referral", "ReferralGrant", "ReferralGrantShare", "ReferralCode", "Player" CASCADE',
  );
}

/** Signs with a Solana keypair's own seed, mirroring what a wallet's
 *  `signMessage` does (see access.test.ts). */
function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

const emptyPlayer = (owner: string, poolAddress: string = POOL_ADDRESS): Player => ({
  poolAddress,
  owner,
  principal: 0n,
  entries: 0n,
  epochId: 0n,
  isHouse: false,
  pendingWithdraw: 0n,
  pendingEpoch: 0n,
  boughtEpoch: 0n,
  boughtAmount: 0n,
  bonusEpoch: 0n,
  bonusGranted: 0n,
  slot: 0n,
  ...LIVE_PLAYER_DEFAULTS,
});

const emptyPool = (overrides: Partial<Pool> = {}): Pool => ({
  address: POOL_ADDRESS,
  poolId: 1n,
  admin: Keypair.generate().publicKey.toBase58(),
  operator: Keypair.generate().publicKey.toBase58(),
  pendingAdmin: null,
  mint: Keypair.generate().publicKey.toBase58(),
  epochSeconds: 86_400n,
  epochAnchor: 0n,
  roundSeconds: 60n,
  closeBuffer: 15n,
  minDeposit: 0n,
  paused: false,
  currentEpochId: 5n,
  currentEpochEndsAt: 0n,
  previousEpochEndsAt: 0n,
  totalPrincipal: 0n,
  pendingWithdrawals: 0n,
  minJackpot: 0n,
  houseCutBps: 0,
  baseRateBps: 488,
  ticketsPerUsdc: 1,
  bonusCapBps: 500,
  bonusEpoch: 0n,
  bonusGranted: 0n,
  version: 1,
  shutdown: false,
  gamePaused: false,
  jackpotPaused: false,
  ...LIVE_POOL_DEFAULTS,
  updatedSlot: 0n,
  ...overrides,
});

describe.skipIf(!DB_AVAILABLE)("GET /referrals/:wallet", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      controllers: [ReferralsController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: SerializationInterceptor }, fakeChain],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.inviteRedemption.deleteMany();
    await prisma.inviteCode.deleteMany();
    await prisma.referral.deleteMany();
    await prisma.referralGrantShare.deleteMany();
    await prisma.referralGrant.deleteMany();
    await prisma.referralCode.deleteMany();
    await prisma.player.deleteMany();
    // Last: every pool-scoped row above references it (onDelete: Restrict).
    await prisma.pool.deleteMany();
  });

  it("400s a malformed wallet", async () => {
    await http.get("/referrals/not-a-wallet").expect(400);
  });

  it("is the empty state for a wallet with nothing indexed yet (no pool either)", async () => {
    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body).toEqual({
      referralCode: null,
      referrals: { items: [], nextCursor: null },
      qualifiedCount: 0,
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      bonusToday: { amount: "0", uncapped: "0" },
    });
  });

  it("returns the wallet's own referral code once the indexer has created one", async () => {
    await prisma.referralCode.create({
      data: { code: "ABCD2345", owner: REFERRER, createdAt: 0n },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.referralCode).toBe("ABCD2345");
  });

  it("mints a code for a wallet past the gate that has not deposited, once", async () => {
    await prisma.inviteRedemption.create({
      data: { wallet: REFERRER, code: "ABCD2345", redeemedAt: 0n },
    });

    const [first, second] = await Promise.all([
      http.get(`/referrals/${REFERRER}`).expect(200),
      http.get(`/referrals/${REFERRER}`).expect(200),
    ]);
    expect(first.body.referralCode).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(second.body.referralCode).toBe(first.body.referralCode);
    expect(await prisma.referralCode.count({ where: { owner: REFERRER } })).toBe(1);
  });

  // beta-launch-fixes ticket 13: an owner's unused invite codes are never in
  // this response, so nobody can harvest them off the leaderboard.
  it("never returns inviteCodes, even when the wallet owns some", async () => {
    await prisma.inviteCode.create({
      data: { code: "ABCD2345", ownerWallet: REFERRER, maxUses: 5, uses: 2, createdAt: 0n },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body).not.toHaveProperty("inviteCodes");
  });

  it("masks referral wallets and reports the qualified / holding / below status", async () => {
    const qualifiedReferee = Keypair.generate().publicKey.toBase58();
    const holdingReferee = Keypair.generate().publicKey.toBase58();
    const belowReferee = Keypair.generate().publicKey.toBase58();
    const now = BigInt(Math.floor(Date.now() / 1000));

    await prisma.referral.create({
      data: {
        referee: qualifiedReferee,
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: 3n,
        aboveSince: now - 604_800n, // exactly the default qualify window
        principal: 50_000_000n,
      },
    });
    await prisma.referral.create({
      data: {
        referee: holdingReferee,
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: 2n,
        aboveSince: now - 100_000n,
        principal: 60_000_000n,
      },
    });
    await prisma.referral.create({
      data: {
        referee: belowReferee,
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: 1n,
        aboveSince: null,
        principal: 0n,
      },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    const items = body.referrals.items as {
      wallet: string;
      status: string;
      daysLeft: number | null;
      bonusToday: string;
      joinedAt: string;
    }[];
    expect(items).toHaveLength(3);
    for (const row of items) {
      expect(row.wallet).not.toBe(qualifiedReferee);
      expect(row.wallet).not.toBe(holdingReferee);
      expect(row.wallet).not.toBe(belowReferee);
      expect(row.wallet).toMatch(/^.{4}….{4}$/);
      expect(row.bonusToday).toBe("0"); // no grant recorded today
    }
    // Newest boundAt first.
    expect(items.map((row) => row.status)).toEqual(["qualified", "holding", "below"]);
    expect(items[0]?.daysLeft).toBeNull();
    expect(items[1]?.daysLeft).toBe(6);
    expect(items[2]?.daysLeft).toBeNull();
    expect(body.referrals.nextCursor).toBeNull();
    expect(body.qualifiedCount).toBe(1);
    expect(body.band).toEqual({ tier: 1, rateBps: 200, minCount: 1, maxCount: 2 });
    expect(body.nextBand).toEqual({ tier: 2, rateBps: 300, minCount: 3, maxCount: 5 });
  });

  it("reads each referral's own bonusToday off its ReferralGrantShare row", async () => {
    await prisma.pool.create({ data: emptyPool({ currentEpochId: 5n }) });
    const referee = Keypair.generate().publicKey.toBase58();
    const otherReferee = Keypair.generate().publicKey.toBase58();
    await prisma.referral.createMany({
      data: [
        {
          referee,
          referrer: REFERRER,
          code: "ABCD2345",
          boundAt: 2n,
          aboveSince: 0n,
          principal: 100_000_000n,
        },
        {
          referee: otherReferee,
          referrer: REFERRER,
          code: "ABCD2345",
          boundAt: 1n,
          aboveSince: 0n,
          principal: 100_000_000n,
        },
      ],
    });
    await prisma.referralGrant.create({
      data: {
        poolAddress: POOL_ADDRESS,
        epochId: 5n,
        referrer: REFERRER,
        amount: 8_000_000n,
        uncapped: 8_000_000n,
        qualifiedCount: 2,
        rateBps: 200,
      },
    });
    await prisma.referralGrantShare.createMany({
      data: [
        { poolAddress: POOL_ADDRESS, epochId: 5n, referrer: REFERRER, referee, amount: 6_000_000n },
        { poolAddress: POOL_ADDRESS, epochId: 5n, referrer: REFERRER, referee: otherReferee, amount: 2_000_000n },
      ],
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    const items = body.referrals.items as { wallet: string; bonusToday: string }[];
    expect(items.map((row) => row.bonusToday)).toEqual(["6000000", "2000000"]);
  });

  it("paginates with a default page of 50 and honours ?cursor= / ?limit=", async () => {
    await prisma.referral.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        referee: Keypair.generate().publicKey.toBase58(),
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: BigInt(i),
        aboveSince: null,
      })),
    });

    const firstPage = await http.get(`/referrals/${REFERRER}?limit=2`).expect(200);
    expect(firstPage.body.referrals.items).toHaveLength(2);
    expect(firstPage.body.referrals.items[0].joinedAt).toBe("4");
    expect(firstPage.body.referrals.nextCursor).not.toBeNull();

    const secondPage = await http
      .get(`/referrals/${REFERRER}?limit=2&cursor=${firstPage.body.referrals.nextCursor}`)
      .expect(200);
    expect(secondPage.body.referrals.items).toHaveLength(2);
    expect(secondPage.body.referrals.items[0].joinedAt).toBe("2");

    const wholeDefault = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(wholeDefault.body.referrals.items).toHaveLength(5); // well under the default 50
    expect(wholeDefault.body.referrals.nextCursor).toBeNull();
  });

  it("reads today's bonus amount and uncapped off the pool's currentEpochId", async () => {
    await prisma.pool.create({ data: emptyPool({ currentEpochId: 5n }) });
    await prisma.referralGrant.create({
      data: {
        poolAddress: POOL_ADDRESS,
        epochId: 5n,
        referrer: REFERRER,
        amount: 10_000_000n,
        uncapped: 72_000_000n,
        qualifiedCount: 6,
        rateBps: 400,
      },
    });
    // A different epoch's grant must not leak into today's reading.
    await prisma.referralGrant.create({
      data: {
        poolAddress: POOL_ADDRESS,
        epochId: 4n,
        referrer: REFERRER,
        amount: 50_000_000n,
        uncapped: 50_000_000n,
        qualifiedCount: 4,
        rateBps: 300,
      },
    });
    // Nor a retired pool's grant for the same epoch id: ids restart per pool
    // (ADR 0016).
    await prisma.pool.create({
      data: emptyPool({ address: RETIRED_POOL_ADDRESS, currentEpochId: 5n }),
    });
    await prisma.referralGrant.create({
      data: {
        poolAddress: RETIRED_POOL_ADDRESS,
        epochId: 5n,
        referrer: REFERRER,
        amount: 90_000_000n,
        uncapped: 90_000_000n,
        qualifiedCount: 9,
        rateBps: 500,
      },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.bonusToday).toEqual({ amount: "10000000", uncapped: "72000000" });
  });

  it("reads 0/0 for a wallet the bonus job has not granted today", async () => {
    await prisma.pool.create({ data: emptyPool({ currentEpochId: 5n }) });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.bonusToday).toEqual({ amount: "0", uncapped: "0" });
  });
});

describe.skipIf(!DB_AVAILABLE)("POST /referrals/apply", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      controllers: [ReferralsController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: SerializationInterceptor }, fakeChain],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);
    await prisma.pool.createMany({
      data: [emptyPool(), emptyPool({ address: RETIRED_POOL_ADDRESS })],
    });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.referral.deleteMany();
    await prisma.referralCode.deleteMany();
    await prisma.player.deleteMany();
  });

  it("400s a signature that does not match the wallet and code", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(wallet, "not the right message"),
      })
      .expect(400);
  });

  it("400s a redeem signature replayed here (ADR 0014: distinct messages)", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(wallet, `HEXO access: ${wallet.publicKey.toBase58()} OWNR2345`),
      })
      .expect(400);
  });

  it("binds the referral code owner as referrer", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "OWNR2345"),
        ),
      })
      .expect(200);
    expect(body).toEqual({ applied: true, reason: "referral applied" });

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.referrer).toBe(owner.publicKey.toBase58());
    expect(referral?.code).toBe("OWNR2345");
  });

  // Binding after a first deposit is allowed; the row's qualification state
  // is seeded from the Active pool's Player so the 7-day clock starts now
  // when Principal is already at the threshold.
  it("binds a wallet that has already deposited, seeding principal and aboveSince", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "DEPO2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await prisma.player.create({
      data: { ...emptyPlayer(wallet.publicKey.toBase58()), principal: REFERRAL_QUALIFY_PRINCIPAL },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "DEPO2345",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "DEPO2345"),
        ),
      })
      .expect(200);
    expect(body).toEqual({ applied: true, reason: "referral applied" });

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.referrer).toBe(owner.publicKey.toBase58());
    expect(referral?.principal).toBe(REFERRAL_QUALIFY_PRINCIPAL);
    expect(referral?.aboveSince).toBe(referral?.boundAt);
  });

  // A Player only in a retired pool (ADR 0016) is not the Active pool's
  // Principal, so the row seeds as never deposited.
  it("binds a wallet whose only Player is in the retired pool, seeded at zero", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "RETD2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await prisma.player.create({
      data: {
        ...emptyPlayer(wallet.publicKey.toBase58(), RETIRED_POOL_ADDRESS),
        principal: REFERRAL_QUALIFY_PRINCIPAL,
      },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "RETD2345",
        signature: sign(wallet, applyReferralMessage(wallet.publicKey.toBase58(), "RETD2345")),
      })
      .expect(200);
    expect(body).toEqual({ applied: true, reason: "referral applied" });

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.principal).toBe(0n);
    expect(referral?.aboveSince).toBeNull();
  });

  it("quietly declines a wallet that already has a Referrer, without overwriting it", async () => {
    const firstReferrer = Keypair.generate();
    const secondReferrer = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referral.create({
      data: {
        referee: wallet.publicKey.toBase58(),
        referrer: firstReferrer.publicKey.toBase58(),
        code: "FIRST111",
        boundAt: 0n,
      },
    });
    await prisma.referralCode.create({
      data: { code: "SECOND22", owner: secondReferrer.publicKey.toBase58(), createdAt: 0n },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "SECOND22",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "SECOND22"),
        ),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.referrer).toBe(firstReferrer.publicKey.toBase58());
    expect(referral?.code).toBe("FIRST111");
  });

  it("quietly declines a self-applied code", async () => {
    const owner = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "SELF2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: owner.publicKey.toBase58(),
        code: "SELF2345",
        signature: sign(owner, applyReferralMessage(owner.publicKey.toBase58(), "SELF2345")),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: owner.publicKey.toBase58() },
    });
    expect(referral).toBeNull();
  });

  it("quietly declines an unknown code", async () => {
    const wallet = Keypair.generate();

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "ZZZZ9999",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "ZZZZ9999"),
        ),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral).toBeNull();
  });
});
