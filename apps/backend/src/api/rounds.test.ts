// Against a real Postgres (off-chain-tickets ticket 16): the bet route and the
// Round engine behind it, driven over HTTP where the status or the throttle is
// the point and through the service where the clock must be set.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_rounds";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createHash, createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { countLedgerMismatches } from "../ledger/ledger-store";
import { ensurePoolRow } from "../operator/pool-row.fixture";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { betListHash, betMessage, type BetFields } from "./bet";
import { BetsController } from "./bets.controller";
import { DEFAULT_GAME_CONFIG } from "./game-config";
import { readRoundState } from "./round-state";
import { RoundsService } from "./rounds.service";
import { SerializationInterceptor } from "./serialization.interceptor";
import { SessionsService } from "./sessions.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const POOL = Keypair.generate().publicKey.toBase58();
const EPOCH = 3n;
// 12:00:00 UTC on a minute mark; the service takes its clock as an argument.
const NOON = new Date("2026-10-08T12:00:00.000Z");
const at = (seconds: number): Date => new Date(NOON.getTime() + seconds * 1000);
const FAR_EPOCH_END = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

function signWith(keypair: Keypair, message: string): Uint8Array {
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), key));
}

interface Player {
  wallet: string;
  sessionKey: Keypair;
}

describe.skipIf(!DB_AVAILABLE)("round open and bet acceptance", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rounds: RoundsService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      controllers: [BetsController],
      providers: [
        RoundsService,
        SessionsService,
        { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: ConfigService,
          useValue: new ConfigService({ CORS_ORIGIN: "https://hexvault.xyz", CLUSTER: "devnet", PROGRAM_ID }),
        },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: true }));
    prisma = app.get(PrismaService);
    rounds = app.get(RoundsService);
    await ensurePoolRow(prisma, POOL, 1n);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await wipe();
    await app.close();
  });

  const wipe = async (): Promise<void> => {
    await prisma.position.deleteMany();
    await prisma.round.deleteMany();
    await prisma.ticketLedger.deleteMany();
    await prisma.ticketBalance.deleteMany();
    await prisma.session.deleteMany();
    await prisma.gameConfig.deleteMany();
  };

  beforeEach(async () => {
    await wipe();
    await prisma.pool.update({
      where: { address: POOL },
      data: {
        currentEpochId: EPOCH,
        currentEpochEndsAt: FAR_EPOCH_END,
        paused: false,
        gamePaused: false,
        shutdown: false,
      },
    });
    await prisma.gameConfig.create({ data: { poolAddress: POOL, ...DEFAULT_GAME_CONFIG } });
  });

  /** A wallet with `tickets` Tickets and a live session key. */
  async function player(tickets: bigint): Promise<Player> {
    const wallet = Keypair.generate().publicKey.toBase58();
    const sessionKey = Keypair.generate();
    await prisma.ticketBalance.create({ data: { poolAddress: POOL, owner: wallet, tickets, epochId: EPOCH } });
    await prisma.ticketLedger.create({
      data: { poolAddress: POOL, owner: wallet, epochId: EPOCH, delta: tickets, reason: "reset", ref: "test" },
    });
    await prisma.session.create({
      data: {
        poolAddress: POOL,
        wallet,
        sessionPubkey: sessionKey.publicKey.toBase58(),
        message: "delegation",
        signature: "sig",
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { wallet, sessionKey };
  }

  /** A signed bet text for `p`; defaults bet 3 tiles at 10 Tickets into Round 1. */
  function bet(p: Player, seq: number, over: Partial<BetFields> = {}): { message: string; signature: Uint8Array } {
    const message = betMessage({
      cluster: "devnet",
      program: PROGRAM_ID,
      pool: POOL,
      round: 1n,
      session: p.sessionKey.publicKey.toBase58(),
      seq,
      tiles: [3, 7, 12],
      stake: 10n,
      ...over,
    });
    return { message, signature: signWith(p.sessionKey, message) };
  }

  const place = (p: Player, seq: number, now: Date, over: Partial<BetFields> = {}) => {
    const { message, signature } = bet(p, seq, over);
    return rounds.placeBet(message, signature, now);
  };

  const tickets = async (p: Player): Promise<bigint> =>
    (await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner: p.wallet } } })).tickets;

  it("opens a Round on the first bet and leaves a Position and a stake row", async () => {
    const alice = await player(1_000n);
    const config = await prisma.gameConfig.findFirstOrThrow({ where: { poolAddress: POOL } });

    const result = await place(alice, 0, at(10));
    expect(result).toMatchObject({ ok: true, roundId: 1n, opened: true, closeAt: at(120) });

    const round = await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } });
    expect(round).toMatchObject({
      epochId: EPOCH,
      openAt: at(10),
      closeAt: at(120),
      status: "open",
      configId: config.id,
      pot: 30n,
      seed: null,
      betListHash: null,
    });
    expect(round.seedCommitment).toBe(createHash("sha256").update(Buffer.from(round.seedSecret, "hex")).digest("hex"));
    expect(Buffer.from(round.seedSecret, "hex")).toHaveLength(32);
    const totals = round.tileTotals as string[];
    expect(totals).toHaveLength(36);
    expect([totals[3], totals[7], totals[12], totals[0]]).toEqual(["10", "10", "10", "0"]);

    const { message, signature } = bet(alice, 0);
    const positions = await prisma.position.findMany();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      roundId: 1n,
      owner: alice.wallet,
      seq: 0,
      tiles: (1n << 3n) | (1n << 7n) | (1n << 12n),
      stakePerTile: 10n,
      message,
      receivedAt: at(10),
    });
    expect(bs58.decode(positions[0]!.signature)).toEqual(signature);

    const stakes = await prisma.ticketLedger.findMany({ where: { owner: alice.wallet, reason: "stake" } });
    expect(stakes).toHaveLength(1);
    expect(stakes[0]).toMatchObject({ delta: -30n, ref: "1", epochId: EPOCH, signer: null, signature: null });
    expect(await tickets(alice)).toBe(970n);
    expect((await prisma.session.findUniqueOrThrow({ where: { sessionPubkey: alice.sessionKey.publicKey.toBase58() } })).nextSeq).toBe(1);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("refuses a second bet by the same wallet with PositionExists and stores nothing", async () => {
    const alice = await player(1_000n);
    await place(alice, 0, at(10));
    expect(await place(alice, 1, at(20))).toEqual({ ok: false, code: "PositionExists" });
    expect(await prisma.position.count()).toBe(1);
    expect(await prisma.ticketLedger.count({ where: { reason: "stake" } })).toBe(1);
    expect(await tickets(alice)).toBe(970n);
    expect((await prisma.session.findUniqueOrThrow({ where: { sessionPubkey: alice.sessionKey.publicKey.toBase58() } })).nextSeq).toBe(1);
  });

  it("takes a second wallet into the open Round and sums the tiles", async () => {
    const alice = await player(1_000n);
    const bob = await player(1_000n);
    await place(alice, 0, at(10));
    expect(await place(bob, 0, at(20), { tiles: [3, 4], stake: 5n })).toMatchObject({ ok: true, roundId: 1n, opened: false });
    const round = await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } });
    expect(round.pot).toBe(40n);
    expect((round.tileTotals as string[]).slice(3, 5)).toEqual(["15", "5"]);
  });

  it("names RoundAlreadyOpen for the next id while one is open, and SeqMismatch for a replay", async () => {
    const alice = await player(1_000n);
    const bob = await player(1_000n);
    await place(alice, 0, at(10));
    expect(await place(bob, 0, at(20), { round: 2n })).toEqual({ ok: false, code: "RoundAlreadyOpen" });
    expect(await place(bob, 3, at(20))).toEqual({ ok: false, code: "SeqMismatch" });
    expect(await prisma.position.count()).toBe(1);
  });

  it("excludes stakes in unrevealed Rounds from a wallet's available Tickets", async () => {
    const alice = await player(100n);
    await place(alice, 0, at(10), { tiles: [0, 1], stake: 40n });
    expect(await tickets(alice)).toBe(20n);
    const bob = await player(0n);
    expect(await place(bob, 0, at(11))).toEqual({ ok: false, code: "InsufficientTickets" });
    // With the first Round closed and awaiting its reveal, 21 is more than the 20 left and 20 is not.
    await prisma.round.update({
      where: { poolAddress_id: { poolAddress: POOL, id: 1n } },
      data: { status: "closed" },
    });
    expect(await place(alice, 1, at(130), { round: 2n, tiles: [2], stake: 21n })).toEqual({
      ok: false,
      code: "InsufficientTickets",
    });
    expect(await place(alice, 1, at(131), { round: 2n, tiles: [2], stake: 20n })).toMatchObject({ ok: true, roundId: 2n });
    expect(await tickets(alice)).toBe(0n);
  });

  describe("closing", () => {
    it("refuses a bet received after closeAt and stores nothing", async () => {
      const alice = await player(1_000n);
      const bob = await player(1_000n);
      await place(alice, 0, at(10));
      // closeAt is 12:02:00. One millisecond late is late.
      const late = await place(bob, 0, new Date(at(120).getTime() + 1));
      expect(late).toEqual({ ok: false, code: "RoundClosed" });
      expect(await prisma.position.count()).toBe(1);
      expect(await tickets(bob)).toBe(1_000n);
      expect(await prisma.ticketLedger.count({ where: { owner: bob.wallet, reason: "stake" } })).toBe(0);
    });

    it("writes betListHash over the accepted signatures in order and sets closed", async () => {
      const alice = await player(1_000n);
      const bob = await player(1_000n);
      const carol = await player(1_000n);
      await place(alice, 0, at(10));
      await place(bob, 0, at(20));
      await place(carol, 0, at(30));

      await rounds.closeDue(at(119));
      expect((await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } })).status).toBe("open");

      await rounds.closeDue(at(120));
      const closed = await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } });
      expect(closed.status).toBe("closed");
      expect(closed.betListHash).toBe(betListHash([alice, bob, carol].map((p) => bet(p, 0).signature)));

      await rounds.closeDue(at(500));
      expect((await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } })).betListHash).toBe(
        closed.betListHash,
      );
    });

    it("opens the next Round on a bet after close while the first stays closed", async () => {
      const alice = await player(1_000n);
      const bob = await player(1_000n);
      await place(alice, 0, at(10));
      await rounds.closeDue(at(121));

      expect(await place(bob, 0, at(122), { round: 1n })).toEqual({ ok: false, code: "RoundClosed" });
      const opened = await place(bob, 0, at(125), { round: 2n });
      expect(opened).toMatchObject({ ok: true, roundId: 2n, opened: true });
      // Opened at 12:02:05, so the first minute mark a full minute away is 12:04:00.
      expect(opened.ok && opened.closeAt).toEqual(at(240));

      const [first, second] = await prisma.round.findMany({ orderBy: { id: "asc" } });
      expect([first!.status, second!.status]).toEqual(["closed", "open"]);
      expect(second!.epochId).toBe(EPOCH);
      expect(first!.seedCommitment).not.toBe(second!.seedCommitment);
    });

    it("closes a Round lazily when a late bet arrives before the sweep has run", async () => {
      const alice = await player(1_000n);
      const bob = await player(1_000n);
      await place(alice, 0, at(10));
      expect(await place(bob, 0, at(121), { round: 2n })).toMatchObject({ ok: true, roundId: 2n, opened: true });
      const first = await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } });
      expect(first.status).toBe("closed");
      expect(first.betListHash).toBe(betListHash([bet(alice, 0).signature]));
    });
  });

  describe("switches and the epoch edge", () => {
    it.each([["gamePaused"], ["paused"], ["shutdown"]])("refuses with GamePaused while %s is set", async (flag) => {
      const alice = await player(1_000n);
      await prisma.pool.update({ where: { address: POOL }, data: { [flag]: true } });
      expect(await place(alice, 0, at(10))).toEqual({ ok: false, code: "GamePaused" });
      expect(await prisma.round.count()).toBe(0);
      expect(await prisma.position.count()).toBe(0);
    });

    it("refuses to open a Round that would close after the epoch ends, one second short of it", async () => {
      const alice = await player(1_000n);
      // A bet at 12:00:10 would close at 12:02:00. The epoch ends 12:01:59.
      await prisma.pool.update({ where: { address: POOL }, data: { currentEpochEndsAt: BigInt(at(119).getTime() / 1000) } });
      expect(await place(alice, 0, at(10))).toEqual({ ok: false, code: "RoundOutsideEpoch" });
      await prisma.pool.update({ where: { address: POOL }, data: { currentEpochEndsAt: BigInt(at(120).getTime() / 1000) } });
      expect(await place(alice, 0, at(10))).toMatchObject({ ok: true });
    });
  });

  it("opens one Round when two first bets arrive together", async () => {
    const [alice, bob] = await Promise.all([player(1_000n), player(1_000n)]);
    const results = await Promise.all([place(alice, 0, at(10)), place(bob, 0, at(10))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.opened)).toHaveLength(1);
    expect(await prisma.round.count()).toBe(1);
    expect(await prisma.position.count()).toBe(2);
    expect((await prisma.round.findFirstOrThrow()).pot).toBe(60n);
  });

  it("does not let one session spend the same seq twice under concurrency", async () => {
    const alice = await player(1_000n);
    const same = bet(alice, 0);
    const results = await Promise.all([
      rounds.placeBet(same.message, same.signature, at(10)),
      rounds.placeBet(same.message, same.signature, at(10)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.position.count()).toBe(1);
    expect(await tickets(alice)).toBe(970n);
  });

  describe("/state view", () => {
    it("shows no Round and next id 1 on an idle board", async () => {
      expect(await readRoundState(prisma, POOL, at(0))).toEqual({ nextRoundId: 1n, openRound: null, lastRound: null });
    });

    it("shows the open Round, then the closed one beside the new nextRoundId", async () => {
      const alice = await player(1_000n);
      await place(alice, 0, at(10));
      const open = await readRoundState(prisma, POOL, at(20));
      expect(open.nextRoundId).toBe(2n);
      expect(open.lastRound).toBeNull();
      expect(open.openRound).toMatchObject({ id: 1n, openAt: at(10), closeAt: at(120), status: "open" });
      expect(open.openRound?.tileTotals[3]).toBe("10");
      expect(open.openRound?.seedCommitment).toHaveLength(64);

      await rounds.closeDue(at(121));
      expect(await readRoundState(prisma, POOL, at(121))).toMatchObject({
        nextRoundId: 2n,
        openRound: null,
        lastRound: { id: 1n, status: "closed", tile: null },
      });
      // A result older than two minutes drops off.
      expect((await readRoundState(prisma, POOL, at(120 + 121))).lastRound).toBeNull();
    });

    it("never carries the unrevealed seed", async () => {
      const alice = await player(1_000n);
      await place(alice, 0, at(10));
      const { seedSecret } = await prisma.round.findFirstOrThrow();
      expect(JSON.stringify(await readRoundState(prisma, POOL, at(20)), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(seedSecret);
    });
  });

  describe("POST /game/bets", () => {
    const post = (p: Player, seq: number, over: Partial<BetFields> = {}) => {
      const { message, signature } = bet(p, seq, over);
      return http.post("/game/bets").send({ message, signature: bs58.encode(signature) });
    };

    it("accepts a bet and answers with the Round", async () => {
      const alice = await player(1_000n);
      const { body } = await post(alice, 0).expect(201);
      expect(body).toMatchObject({ roundId: "1", opened: true });
      expect(new Date(body.closeAt).getTime() % 60_000).toBe(0);
    });

    it.each([
      ["SessionInvalid", 401],
      ["BadSignature", 403],
      ["BadTiles", 422],
      ["InsufficientTickets", 422],
      ["SeqMismatch", 409],
    ])("answers %s with %i and a code", async (code, status) => {
      const alice = await player(1_000n);
      const stranger = { wallet: "x", sessionKey: Keypair.generate() };
      const response =
        code === "SessionInvalid"
          ? await post(stranger, 0)
          : code === "BadSignature"
            ? await http.post("/game/bets").send({ message: bet(alice, 0).message, signature: bs58.encode(new Uint8Array(64)) })
            : code === "BadTiles"
              ? await post(alice, 0, { tiles: [] })
              : code === "InsufficientTickets"
                ? await post(alice, 0, { stake: 100_000n })
                : await post(alice, 5);
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    });

    it("answers 400 to a body that is not a bet", async () => {
      await http.post("/game/bets").send({}).expect(400);
      await http.post("/game/bets").send({ message: "x", signature: "not-base58-0" }).expect(400);
      await http.post("/game/bets").send({ message: "x", signature: bs58.encode(new Uint8Array(10)) }).expect(400);
    });

    it("throttles a session at 5 bets in 10 seconds, and only that session", async () => {
      const alice = await player(1_000_000n);
      const bob = await player(1_000_000n);
      // Refusals count: the first bet opens a Round, the next four are PositionExists.
      for (let seq = 0; seq < 5; seq++) {
        const status = (await post(alice, seq)).status;
        expect(status).not.toBe(429);
      }
      expect((await post(alice, 5)).status).toBe(429);
      expect((await post(bob, 0)).status).toBe(201);
    });
  });
});
