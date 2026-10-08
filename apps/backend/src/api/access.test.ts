// Against a real Postgres (docs/plan/hexo-referrals ticket 06), same shape as
// api.test.ts and indexer.test.ts: a dedicated database so a rerun, or
// another agent's suite, cannot collide with these rows. AccessController is
// exercised directly, not through the whole ApiModule: its only ChainService
// call is `poolAddress()`, so a one-method fake stands in.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_access";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Player, Pool } from "@prisma/client";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_PLAYER_DEFAULTS, LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { AccessController } from "./access.controller";
import { accessMessage, INVITE_CIRCULATION_CAP } from "./invite-code";
import { REFERRAL_QUALIFY_PRINCIPAL } from "./referral";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const ADMIN_KEY = "k".repeat(32);

const DEPOSITOR = Keypair.generate().publicKey.toBase58();

/** Signs with a Solana keypair's own seed, mirroring what a wallet's
 *  `signMessage` does (see invite-code.test.ts). */
function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "InviteCode", "InviteRedemption", "Pool", "Player", "Referral", "ReferralCode" CASCADE',
  );
}

/** Two pools, as after a Pool cutover (ADR 0016). `GET /access/:wallet`'s
 *  "has this wallet deposited" check looks across every pool, so each Player
 *  below lives only in the retired one unless a test says otherwise. */
const ACTIVE_POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const RETIRED_POOL_ADDRESS = Keypair.generate().publicKey.toBase58();

/** Makes ACTIVE_POOL_ADDRESS the Active pool. */
const fakeChain = {
  provide: ChainService,
  useValue: { poolAddress: () => new PublicKey(ACTIVE_POOL_ADDRESS) },
};

const emptyPool = (address: string): Pool => ({
  address,
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
  currentEpochId: 1n,
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
});

const emptyPlayer = (owner: string, poolAddress: string = RETIRED_POOL_ADDRESS): Player => ({
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

describe.skipIf(!DB_AVAILABLE)("access routes", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [AccessController],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({ INVITE_ADMIN_KEY: ADMIN_KEY }) },
        fakeChain,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);
    await prisma.pool.createMany({
      data: [emptyPool(ACTIVE_POOL_ADDRESS), emptyPool(RETIRED_POOL_ADDRESS)],
    });
    await prisma.player.create({ data: emptyPlayer(DEPOSITOR) });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.inviteCode.deleteMany();
    await prisma.inviteRedemption.deleteMany();
    await prisma.referral.deleteMany();
    await prisma.referralCode.deleteMany();
  });

  describe("GET /access/:wallet", () => {
    it("is not allowed for a wallet with no redemption and no Player", async () => {
      const { body } = await http
        .get(`/access/${Keypair.generate().publicKey.toBase58()}`)
        .expect(200);
      expect(body).toEqual({ allowed: false, reason: "no invite code redeemed" });
    });

    it("allows an existing depositor with no invite redeemed, whose only Player is in the retired pool", async () => {
      const { body } = await http.get(`/access/${DEPOSITOR}`).expect(200);
      expect(body).toEqual({ allowed: true, reason: "existing depositor" });
    });

    it("is 400 for a malformed wallet", async () => {
      await http.get("/access/not-a-wallet").expect(400);
    });
  });

  describe("POST /access/invites", () => {
    it("401s a missing or wrong key and writes nothing", async () => {
      await http.post("/access/invites").send({ maxUses: 5 }).expect(401);
      await http
        .post("/access/invites")
        .set("x-admin-key", "wrong")
        .send({ maxUses: 5 })
        .expect(401);
      expect(await prisma.inviteCode.count()).toBe(0);
    });

    it("creates `count` owned codes that redeem binds as a referral", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const { body } = await http
        .post("/access/invites")
        .set("x-admin-key", ADMIN_KEY)
        .send({ maxUses: 3, owner, count: 2 })
        .expect(201);
      expect(body.codes).toHaveLength(2);
      const rows = await prisma.inviteCode.findMany();
      expect(rows.map((row) => row.code).sort()).toEqual([...body.codes].sort());
      expect(rows.every((row) => row.maxUses === 3 && row.ownerWallet === owner)).toBe(true);

      const wallet = Keypair.generate();
      const address = wallet.publicKey.toBase58();
      const signature = sign(wallet, accessMessage(address, body.codes[0]));
      await http
        .post("/access/redeem")
        .send({ wallet: address, code: body.codes[0], signature })
        .expect(201);
      expect(await prisma.referral.findUnique({ where: { referee: address } })).toMatchObject({
        referrer: owner,
      });
    });

    it("400s a bad body", async () => {
      for (const bad of [
        { maxUses: 0 },
        { maxUses: 1, count: 101 },
        { maxUses: 1, owner: "x" },
      ]) {
        await http.post("/access/invites").set("x-admin-key", ADMIN_KEY).send(bad).expect(400);
      }
    });

    it("defaults maxUses to 1 when omitted (ticket 07: single use from now on)", async () => {
      const { body } = await http
        .post("/access/invites")
        .set("x-admin-key", ADMIN_KEY)
        .send({})
        .expect(201);
      expect(body).toMatchObject({ maxUses: 1, owner: null });
      expect(body.codes).toHaveLength(1);
      const row = await prisma.inviteCode.findUnique({ where: { code: body.codes[0] } });
      expect(row).toMatchObject({ maxUses: 1, uses: 0, ownerWallet: null });
    });
  });

  describe("GET /access/invites", () => {
    it("401s without the key", async () => {
      await http.get("/access/invites").expect(401);
    });

    it("lists every code with its redemptions", async () => {
      await prisma.inviteCode.createMany({
        data: [
          { code: "AAAA2222", maxUses: 1, uses: 0, createdAt: 1n, ownerWallet: null },
          { code: "BBBB3333", maxUses: 2, uses: 1, createdAt: 2n, ownerWallet: null },
        ],
      });
      await prisma.inviteRedemption.create({
        data: { wallet: DEPOSITOR, code: "BBBB3333", redeemedAt: 5n },
      });
      const { body } = await http.get("/access/invites").set("x-admin-key", ADMIN_KEY).expect(200);
      expect(body.invites).toEqual([
        {
          code: "BBBB3333",
          owner: null,
          maxUses: 2,
          uses: 1,
          createdAt: "1970-01-01T00:00:02.000Z",
          redeemed: false,
          redemptions: [{ wallet: DEPOSITOR, redeemedAt: "1970-01-01T00:00:05.000Z" }],
        },
        { code: "AAAA2222", owner: null, maxUses: 1, uses: 0, createdAt: "1970-01-01T00:00:01.000Z", redeemed: false, redemptions: [] },
      ]);
    });
  });

  describe("POST /access/redeem", () => {
    it("400s a signature that does not match the wallet and code", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "ABCD2345", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      const signature = sign(wallet, "not the right message");
      await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "ABCD2345", signature })
        .expect(400);
    });

    it("404s a code that does not exist", async () => {
      const wallet = Keypair.generate();
      const signature = sign(
        wallet,
        accessMessage(wallet.publicKey.toBase58(), "ZZZZ9999"),
      );
      await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "ZZZZ9999", signature })
        .expect(404);
    });

    it("redeems a valid code, is case-insensitive, and updates uses", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "ABCD2345", maxUses: 5, uses: 2, createdAt: 0n, ownerWallet: null },
      });
      // The client normalizes the code to upper case before signing (same
      // rule the server applies), so a lower-case `code` field still matches.
      const signature = sign(
        wallet,
        accessMessage(wallet.publicKey.toBase58(), "ABCD2345"),
      );
      const { body } = await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "abcd2345", signature })
        .expect(201);
      expect(body).toEqual({ allowed: true, reason: "invite code redeemed" });

      const code = await prisma.inviteCode.findUnique({ where: { code: "ABCD2345" } });
      expect(code?.uses).toBe(3);
      const redemption = await prisma.inviteRedemption.findUnique({
        where: { wallet: wallet.publicKey.toBase58() },
      });
      expect(redemption?.code).toBe("ABCD2345");

      const { body: access } = await http
        .get(`/access/${wallet.publicKey.toBase58()}`)
        .expect(200);
      expect(access).toEqual({ allowed: true, reason: "invite code redeemed" });
    });

    it("409s a wallet redeeming a second time", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.createMany({
        data: [
          { code: "AAAA2222", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
          { code: "BBBB3333", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
        ],
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "AAAA2222",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "AAAA2222")),
        })
        .expect(201);
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "BBBB3333",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "BBBB3333")),
        })
        .expect(409);
    });

    it("409s a code with no uses left", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "USEDUP22", maxUses: 1, uses: 1, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "USEDUP22",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "USEDUP22")),
        })
        .expect(409);
    });

    it("only lets one of two concurrent redeemers take the last use", async () => {
      await prisma.inviteCode.create({
        data: { code: "LASTONE1", maxUses: 1, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      const wallets = [Keypair.generate(), Keypair.generate()];
      const responses = await Promise.all(
        wallets.map((wallet) =>
          http.post("/access/redeem").send({
            wallet: wallet.publicKey.toBase58(),
            code: "LASTONE1",
            signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "LASTONE1")),
          }),
        ),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 409]);

      const code = await prisma.inviteCode.findUnique({ where: { code: "LASTONE1" } });
      expect(code?.uses).toBe(1);
    });
  });

  describe("referral binding (ticket 07)", () => {
    it("binds the code owner as referrer, unqualified until Principal holds", async () => {
      const owner = Keypair.generate();
      const referee = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "OWNR2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: referee.publicKey.toBase58(),
          code: "OWNR2345",
          signature: sign(referee, accessMessage(referee.publicKey.toBase58(), "OWNR2345")),
        })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: referee.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(owner.publicKey.toBase58());
      expect(referral?.code).toBe("OWNR2345");
      expect(referral?.aboveSince).toBeNull();
      expect(referral?.principal).toBe(0n);
    });

    it("does not bind a referral for a code with no owner", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "NOOWN123", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "NOOWN123",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "NOOWN123")),
        })
        .expect(201);
      const referral = await prisma.referral.findUnique({
        where: { referee: wallet.publicKey.toBase58() },
      });
      expect(referral).toBeNull();
    });

    it("does not bind a self-redeemed code", async () => {
      const owner = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "SELF2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: owner.publicKey.toBase58(),
          code: "SELF2345",
          signature: sign(owner, accessMessage(owner.publicKey.toBase58(), "SELF2345")),
        })
        .expect(201);
      const referral = await prisma.referral.findUnique({
        where: { referee: owner.publicKey.toBase58() },
      });
      expect(referral).toBeNull();
    });

    it("binds a wallet that already has a Player, seeding the clock from the Active pool's Principal", async () => {
      const owner = Keypair.generate();
      const existingDepositor = Keypair.generate();
      await prisma.player.create({
        data: {
          ...emptyPlayer(existingDepositor.publicKey.toBase58(), ACTIVE_POOL_ADDRESS),
          principal: REFERRAL_QUALIFY_PRINCIPAL,
        },
      });
      await prisma.inviteCode.create({
        data: {
          code: "PLYR2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      try {
        await http
          .post("/access/redeem")
          .send({
            wallet: existingDepositor.publicKey.toBase58(),
            code: "PLYR2345",
            signature: sign(
              existingDepositor,
              accessMessage(existingDepositor.publicKey.toBase58(), "PLYR2345"),
            ),
          })
          .expect(201);
        const referral = await prisma.referral.findUnique({
          where: { referee: existingDepositor.publicKey.toBase58() },
        });
        expect(referral?.referrer).toBe(owner.publicKey.toBase58());
        expect(referral?.principal).toBe(REFERRAL_QUALIFY_PRINCIPAL);
        expect(referral?.aboveSince).toBe(referral?.boundAt);
      } finally {
        await prisma.player.delete({
          where: {
            poolAddress_owner: {
              poolAddress: ACTIVE_POOL_ADDRESS,
              owner: existingDepositor.publicKey.toBase58(),
            },
          },
        });
      }
    });
  });

  describe("referral code precedence (referral-page ticket 02)", () => {
    it("binds via a valid referral code, not the invite code's owner", async () => {
      const inviteOwner = Keypair.generate();
      const referralOwner = Keypair.generate();
      const referee = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "INVT2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: inviteOwner.publicKey.toBase58(),
        },
      });
      await prisma.referralCode.create({
        data: { code: "REFC2345", owner: referralOwner.publicKey.toBase58(), createdAt: 0n },
      });
      const signature = sign(
        referee,
        accessMessage(referee.publicKey.toBase58(), "INVT2345", "REFC2345"),
      );
      await http
        .post("/access/redeem")
        .send({
          wallet: referee.publicKey.toBase58(),
          code: "INVT2345",
          referralCode: "REFC2345",
          signature,
        })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: referee.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(referralOwner.publicKey.toBase58());
      expect(referral?.code).toBe("REFC2345");
    });

    it("falls back to the invite owner when the referral code is self-owned", async () => {
      const inviteOwner = Keypair.generate();
      const referee = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "INVT6789",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: inviteOwner.publicKey.toBase58(),
        },
      });
      // A referral code the referee itself owns: not a valid Referrer (no
      // self-referral), so precedence falls through to the invite owner.
      await prisma.referralCode.create({
        data: { code: "SELFOWNR", owner: referee.publicKey.toBase58(), createdAt: 0n },
      });
      const signature = sign(
        referee,
        accessMessage(referee.publicKey.toBase58(), "INVT6789", "SELFOWNR"),
      );
      await http
        .post("/access/redeem")
        .send({
          wallet: referee.publicKey.toBase58(),
          code: "INVT6789",
          referralCode: "SELFOWNR",
          signature,
        })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: referee.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(inviteOwner.publicKey.toBase58());
      expect(referral?.code).toBe("INVT6789");
    });

    // beta-launch-fixes ticket 13: a wallet that opened a `?ref=CODE` link
    // and called POST /referrals/apply before ever redeeming an invite
    // already has a Referral row by the time it redeems. Redeem must not
    // try to insert a second one (which would hit the unique `referee` and
    // fail the whole redemption over a binding that already succeeded).
    it("keeps the earlier Referrer when a Referral already exists from /referrals/apply", async () => {
      const inviteOwner = Keypair.generate();
      const earlierReferrer = Keypair.generate();
      const referee = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "APLY2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: inviteOwner.publicKey.toBase58(),
        },
      });
      await prisma.referral.create({
        data: {
          referee: referee.publicKey.toBase58(),
          referrer: earlierReferrer.publicKey.toBase58(),
          code: "PRE00001",
          boundAt: 0n,
        },
      });

      const signature = sign(
        referee,
        accessMessage(referee.publicKey.toBase58(), "APLY2345"),
      );
      await http
        .post("/access/redeem")
        .send({ wallet: referee.publicKey.toBase58(), code: "APLY2345", signature })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: referee.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(earlierReferrer.publicKey.toBase58());
      expect(referral?.code).toBe("PRE00001");
      const redemption = await prisma.inviteRedemption.findUnique({
        where: { wallet: referee.publicKey.toBase58() },
      });
      expect(redemption?.code).toBe("APLY2345");
    });
  });

  describe("invite code quota (ticket 07)", () => {
    /** Summed remaining uses (maxUses − uses) across every Invite code,
     *  the same "in circulation" figure access.controller.ts computes. */
    async function circulation(): Promise<number> {
      const rows = await prisma.inviteCode.findMany({ select: { maxUses: true, uses: true } });
      return rows.reduce((sum, row) => sum + (row.maxUses - row.uses), 0);
    }

    /** Seeds enough remaining uses on codes nobody redeems in this test so
     *  circulation sits at `target` before the code under test is created. */
    async function padCirculationTo(target: number): Promise<void> {
      if (target <= 0) return;
      await prisma.inviteCode.create({
        data: { code: `PAD${target}`.padEnd(8, "9"), maxUses: target, uses: 0, createdAt: 0n, ownerWallet: null },
      });
    }

    it("grants the redeemer 2 new codes of its own when circulation has room", async () => {
      expect(await circulation()).toBe(0);
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "QUOTA001", maxUses: 1, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "QUOTA001",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "QUOTA001")),
        })
        .expect(201);

      const granted = await prisma.inviteCode.findMany({
        where: { ownerWallet: wallet.publicKey.toBase58() },
      });
      expect(granted).toHaveLength(2);
      expect(granted.every((row) => row.maxUses === 1 && row.uses === 0)).toBe(true);
      expect(await circulation()).toBe(2);
    });

    it("grants 0 once redeeming would put circulation at the cap, and circulation drops", async () => {
      // Padded to the cap itself, plus the redeemed code's own 1 remaining
      // use: after that use is spent, circulation lands exactly at the cap.
      await padCirculationTo(INVITE_CIRCULATION_CAP);
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "QUOTA050", maxUses: 1, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      expect(await circulation()).toBe(INVITE_CIRCULATION_CAP + 1);

      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "QUOTA050",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "QUOTA050")),
        })
        .expect(201);

      const granted = await prisma.inviteCode.findMany({
        where: { ownerWallet: wallet.publicKey.toBase58() },
      });
      expect(granted).toHaveLength(0);
      // Circulation dropped by exactly the redeemed code's spent use, since
      // no grant refilled it: the cap is never topped up later.
      expect(await circulation()).toBe(INVITE_CIRCULATION_CAP);
    });

    it("never lets concurrent redeems push circulation over the cap", async () => {
      const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
      // Padded so each of the 3 codes below, read in isolation of the
      // others' still-uncommitted redemptions, looks like it has room for a
      // full grant of 2: without the advisory lock serializing them, all 3
      // would grant 2 each and circulation would land at 52, over the cap.
      await padCirculationTo(INVITE_CIRCULATION_CAP - 1 - wallets.length);
      await prisma.inviteCode.createMany({
        data: wallets.map((_, index) => ({
          code: `RACE000${index}`,
          maxUses: 1,
          uses: 0,
          createdAt: 0n,
          ownerWallet: null,
        })),
      });

      const responses = await Promise.all(
        wallets.map((wallet, index) =>
          http.post("/access/redeem").send({
            wallet: wallet.publicKey.toBase58(),
            code: `RACE000${index}`,
            signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), `RACE000${index}`)),
          }),
        ),
      );
      expect(responses.every((response) => response.status === 201)).toBe(true);
      expect(await circulation()).toBeLessThanOrEqual(INVITE_CIRCULATION_CAP);
    });

    it("makes a granted code's owner the fallback Referrer once redeemed", async () => {
      const first = Keypair.generate();
      const second = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "CHAIN001", maxUses: 1, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: first.publicKey.toBase58(),
          code: "CHAIN001",
          signature: sign(first, accessMessage(first.publicKey.toBase58(), "CHAIN001")),
        })
        .expect(201);

      const granted = await prisma.inviteCode.findMany({
        where: { ownerWallet: first.publicKey.toBase58() },
      });
      expect(granted).toHaveLength(2);
      const grantedCode = granted[0]?.code as string;

      await http
        .post("/access/redeem")
        .send({
          wallet: second.publicKey.toBase58(),
          code: grantedCode,
          signature: sign(second, accessMessage(second.publicKey.toBase58(), grantedCode)),
        })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: second.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(first.publicKey.toBase58());
      expect(referral?.code).toBe(grantedCode);
    });
  });
});
