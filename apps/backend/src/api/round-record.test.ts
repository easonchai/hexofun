// Against a real Postgres (off-chain-tickets ticket 19): the Round record route
// and scripts/verify-round.mjs run against it. Rounds are played through the
// engine with stub relays serving recorded quicknet beacons; the script is run
// as a child process against the live HTTP route, and against a mutated copy
// of the record for each tamper.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_round_record";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { execFile } from "node:child_process";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { ChainClient } from "drand-client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { ensurePoolRow } from "../operator/pool-row.fixture";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { betMessage, seedCommitment } from "./bet";
import { beaconTime, QUICKNET, VOID_AFTER_MS } from "./drand";
import { DEFAULT_GAME_CONFIG } from "./game-config";
import { RoundRecordController } from "./round-record.controller";
import { deriveTile } from "./round-settle";
import { RoundsService } from "./rounds.service";
import { SerializationInterceptor } from "./serialization.interceptor";
import { delegationMessage } from "./session";
import { SessionsService } from "./sessions.service";
import { SparringService, STAKE_PER_TILE } from "./sparring.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);
const SCRIPT = resolve(__dirname, "../../../../scripts/verify-round.mjs");

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const POOL = Keypair.generate().publicKey.toBase58();
const HOUSE = Keypair.generate().publicKey.toBase58();
const SPARRING = Keypair.generate();
const EPOCH = 3n;
const FAR_EPOCH_END = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

// Recorded from api.drand.sh on 2026-10-08; the same beacons round-reveal.test.ts uses.
const BEACONS: Record<number, { round: number; randomness: string; signature: string }> = {
  32883574: {
    round: 32883574,
    randomness: "6495b2994b01e83d2dd91bf0161a7af462f1cb4dbd4b45d863d0eb3d33d24046",
    signature:
      "af6f10b205b36992236d019792d58af67ddf06ecc90f23c41d639afa492e90b18135c3a9333bd26782dc584a3b297223",
  },
  32883614: {
    round: 32883614,
    randomness: "a027f3dcaef1d5437e29052c6970f80f67dae86d6b173c07c3051fecf7d9410d",
    signature:
      "ab37130da7e78d14632710d22a4d0bcfd47a9a402920b65fe9c29b94b3d9ce0e0d0fe3126132fb29c399cd35dad69757",
  },
};

// Round 1 opens at 10:06:30 UTC and closes on the 10:08:00 mark.
const BASE_S = 1791453990;
const at = (seconds: number): Date => new Date((BASE_S + seconds) * 1000);
const CLOSE1 = at(90);
const SEED = Buffer.alloc(32, 7);
const iso = (date: Date): string => date.toISOString().replace(".000Z", "Z");

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

function relay(answer: (round: number) => unknown): ChainClient {
  const chain = { baseUrl: "stub", info: async () => QUICKNET };
  return {
    options: { disableBeaconVerification: false, noCache: false },
    chain: () => chain,
    get: async (round: number) => answer(round) as never,
    latest: async () => {
      throw new Error("unused");
    },
  };
}
const goodRelay = (): ChainClient =>
  relay((round) => {
    const beacon = BEACONS[round];
    if (beacon === undefined) throw new Error(`relay answered 404 for round ${round}`);
    return beacon;
  });
const deadRelay = (): ChainClient =>
  relay(() => {
    throw new Error("relay timed out");
  });

interface Player {
  wallet: Keypair;
  sessionKey: Keypair;
}

/** Runs the script and resolves with its exit code and output. */
const runScript = (...args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((done) => {
    execFile("node", [SCRIPT, ...args], (error, stdout, stderr) =>
      done({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, out: stdout + stderr }),
    );
  });

describe.skipIf(!DB_AVAILABLE)("Round record", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rounds: RoundsService;
  let sessions: SessionsService;
  let base: string;
  const mirrors: Server[] = [];

  const config = new ConfigService({
    CORS_ORIGIN: "https://hexvault.xyz",
    CLUSTER: "devnet",
    PROGRAM_ID,
    SPARRING_ENABLED: true,
    SPARRING_KEYPAIR: bs58.encode(SPARRING.secretKey),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [RoundRecordController],
      providers: [
        RoundsService,
        SessionsService,
        { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
        { provide: ConfigService, useValue: config },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    rounds = app.get(RoundsService);
    sessions = app.get(SessionsService);
    await ensurePoolRow(prisma, POOL, 1n);
    await app.init();
    // These Rounds run on a 2026 test clock; the engine's own sweep must not close or reveal them.
    rounds.onModuleDestroy();
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });

  afterAll(async () => {
    await wipe();
    await Promise.all(mirrors.map((server) => new Promise((done) => server.close(done))));
    await app.close();
  });

  const wipe = async (): Promise<void> => {
    await prisma.position.deleteMany();
    await prisma.round.deleteMany();
    await prisma.ticketLedger.deleteMany();
    await prisma.ticketBalance.deleteMany();
    await prisma.session.deleteMany();
    await prisma.sessionNonce.deleteMany();
    await prisma.gameConfig.deleteMany();
    await prisma.player.deleteMany();
    await prisma.cursor.deleteMany();
  };

  beforeEach(async () => {
    await wipe();
    await prisma.pool.update({
      where: { address: POOL },
      data: { currentEpochId: EPOCH, currentEpochEndsAt: FAR_EPOCH_END, paused: false, gamePaused: false, shutdown: false },
    });
    await prisma.gameConfig.create({ data: { poolAddress: POOL, ...DEFAULT_GAME_CONFIG } });
    await prisma.player.create({
      data: {
        poolAddress: POOL,
        owner: HOUSE,
        principal: 0n,
        epochId: EPOCH,
        isHouse: true,
        pendingWithdraw: 0n,
        pendingEpoch: 0n,
        boughtEpoch: 0n,
        boughtAmount: 0n,
      },
    });
    rounds.relays = [goodRelay()];
  });

  const fund = async (owner: string, tickets: bigint): Promise<void> => {
    await prisma.ticketBalance.create({ data: { poolAddress: POOL, owner, tickets, epochId: EPOCH } });
    await prisma.ticketLedger.create({
      data: { poolAddress: POOL, owner, epochId: EPOCH, delta: tickets, reason: "reset", ref: "test" },
    });
  };

  /** A wallet with Tickets and a session key whose delegation the wallet really signed. */
  async function player(tickets: bigint): Promise<Player> {
    const wallet = Keypair.generate();
    const sessionKey = Keypair.generate();
    const issuedAt = at(-60);
    const expiresAt = at(-60 + 86_400);
    const message = delegationMessage({
      domain: "hexvault.xyz",
      wallet: wallet.publicKey.toBase58(),
      uri: "https://hexvault.xyz",
      chainId: "devnet",
      nonce: bs58.encode(Keypair.generate().publicKey.toBytes().subarray(0, 16)),
      issuedAt: iso(issuedAt),
      expirationTime: iso(expiresAt),
      sessionPubkey: sessionKey.publicKey.toBase58(),
      programId: PROGRAM_ID,
    });
    await fund(wallet.publicKey.toBase58(), tickets);
    await prisma.session.create({
      data: {
        poolAddress: POOL,
        wallet: wallet.publicKey.toBase58(),
        sessionPubkey: sessionKey.publicKey.toBase58(),
        message,
        signature: bs58.encode(signWith(wallet, message)),
        issuedAt,
        expiresAt,
      },
    });
    return { wallet, sessionKey };
  }

  async function bet(p: Player, tiles: number[], stake: bigint, seconds: number, seq = 0) {
    const message = betMessage({
      cluster: "devnet",
      program: PROGRAM_ID,
      pool: POOL,
      round: 1n,
      session: p.sessionKey.publicKey.toBase58(),
      seq,
      tiles,
      stake,
    });
    expect(await rounds.placeBet(message, signWith(p.sessionKey, message), at(seconds))).toMatchObject({ ok: true });
  }

  /** Round 1: alice and bob cover the winning tile T, carol does not, and the Sparring player takes every tile. The seed is fixed so T is known. */
  async function playRound1(): Promise<{ alice: Player; bob: Player }> {
    const T = deriveTile(SEED, Buffer.from(BEACONS[32883574]!.signature, "hex"), 1n).tile;
    await fund(SPARRING.publicKey.toBase58(), 100n * STAKE_PER_TILE);
    const [alice, bob, carol] = [await player(1_000n), await player(1_000n), await player(1_000n)];
    await bet(alice, [T, (T + 1) % 36].sort((a, b) => a - b), 10n, 0);
    await prisma.round.update({
      where: { poolAddress_id: { poolAddress: POOL, id: 1n } },
      data: { seedSecret: SEED.toString("hex"), seedCommitment: seedCommitment(SEED) },
    });
    await bet(bob, [T], 30n, 5);
    await bet(carol, [(T + 2) % 36], 50n, 10);
    await new SparringService(prisma, sessions, rounds, app.get(ChainService), config as never).tick(at(12));
    await rounds.closeDue(CLOSE1);
    return { alice, bob };
  }

  const getRecord = async (id: number | string = 1) => (await request(base).get(`/rounds/${id}/record`).expect(200)).body;

  /** Serves `record` at /record so the script can be pointed at an edited copy. */
  async function mirror(record: unknown): Promise<string> {
    const server = createServer((_, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(record));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    mirrors.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/record`;
  }

  it("serves every section of a settled Round in the spec's order", async () => {
    const { alice, bob } = await playRound1();
    await rounds.revealDue(beaconTime(32883574));

    const record = await getRecord();

    expect(Object.keys(record)).toEqual([
      "version", "cluster", "program", "pool", "round", "status", "epochId",
      "config", "commitment", "delegations", "positions", "close", "beacon", "settle", "revocations",
    ]);
    expect(record).toMatchObject({ status: "settled", round: "1", cluster: "devnet", program: PROGRAM_ID, pool: POOL });
    expect(record.config).toMatchObject({ houseCutBps: DEFAULT_GAME_CONFIG.houseCutBps, maxTilesPerBet: 36 });
    expect(Object.keys(record.commitment)).toEqual(["seedCommitment", "openAt"]);
    expect(record.commitment.openAt).toBe(at(0).toISOString());
    // Four bettors: three humans and the Sparring player, in the order their bets were accepted.
    expect(record.positions.map((p: { owner: string }) => p.owner)).toEqual([
      alice.wallet.publicKey.toBase58(),
      bob.wallet.publicKey.toBase58(),
      expect.any(String),
      SPARRING.publicKey.toBase58(),
    ]);
    expect(Object.keys(record.positions[0])).toEqual(["owner", "message", "signature", "receivedAt"]);
    expect(record.delegations).toHaveLength(4);
    expect(Object.keys(record.delegations[0])).toEqual(["wallet", "sessionPubkey", "message", "signature", "issuedAt", "expiresAt"]);
    expect(record.close).toEqual({ closeAt: CLOSE1.toISOString(), betListHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(record.beacon).toMatchObject({
      chainHash: QUICKNET.hash,
      drandRound: "32883574",
      drandSignature: BEACONS[32883574]!.signature,
      seed: SEED.toString("hex"),
      ctr: 0,
    });
    expect(record.beacon.tile).toBeGreaterThanOrEqual(0);
    expect(record.settle.length).toBeGreaterThan(0);
    // Rows add up to the pot: 20 + 30 + 50 from the humans and 36 tiles from the Sparring player, no EpochBegan reset.
    const pot = 20n + 30n + 50n + 36n * STAKE_PER_TILE;
    expect(record.settle.reduce((sum: bigint, row: { delta: string }) => sum + BigInt(row.delta), 0n)).toBe(pot);
    expect(record.revocations).toEqual([]);
  });

  it("lists a revocation dated inside the Round and keeps the unrevealed seed out of an open Round", async () => {
    const alice = await player(1_000n);
    await bet(alice, [1], 5n, 0);
    const open = await getRecord();
    expect(open).toMatchObject({ status: "open", close: { betListHash: null }, beacon: { seed: null, tile: null } });
    expect(JSON.stringify(open)).not.toContain(
      (await prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } } })).seedSecret,
    );

    await prisma.session.update({
      where: { sessionPubkey: alice.sessionKey.publicKey.toBase58() },
      data: { revokedAt: at(30) },
    });
    expect((await getRecord()).revocations).toEqual([
      { sessionPubkey: alice.sessionKey.publicKey.toBase58(), wallet: alice.wallet.publicKey.toBase58(), revokedAt: at(30).toISOString() },
    ]);
    // A revocation after the close is not "inside the Round".
    await prisma.session.update({
      where: { sessionPubkey: alice.sessionKey.publicKey.toBase58() },
      data: { revokedAt: at(120) },
    });
    expect((await getRecord()).revocations).toEqual([]);
  });

  it("answers 404 for a Round that does not exist and 400 for a bad id", async () => {
    await request(base).get("/rounds/9/record").expect(404);
    await request(base).get("/rounds/abc/record").expect(400);
  });

  it("serves a voided Round with its refund rows and no tile, seed or beacon", async () => {
    await playRound1();
    rounds.relays = [deadRelay()];
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + VOID_AFTER_MS));

    const record = await getRecord();

    expect(record).toMatchObject({ status: "voided", beacon: { drandRound: null, drandSignature: null, seed: null, ctr: null, tile: null } });
    expect(record.settle.map((row: { reason: string }) => row.reason)).toEqual(["refund", "refund", "refund", "refund"]);
    expect(record.settle.map((row: { delta: string }) => row.delta)).toEqual(["20", "30", "50", String(36n * STAKE_PER_TILE)]);
    const verdict = await runScript(`${base}/rounds/1/record`);
    expect(verdict).toMatchObject({ code: 0 });
    expect(verdict.out).toContain("VERIFIED Round 1: voided");
  });

  describe("scripts/verify-round.mjs", () => {
    it("verifies a settled Round from the running backend, Sparring bet included", async () => {
      await playRound1();
      await rounds.revealDue(beaconTime(32883574));

      const verdict = await runScript(`${base}/rounds/1/record`);

      expect(verdict.out).toContain("VERIFIED Round 1: settled");
      for (const step of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "B1", "B2", "B3", "B4", "B5", "B6"]) {
        expect(verdict.out).toContain(`ok   ${step} `);
      }
      expect(verdict.code).toBe(0);
    });

    it("verifies a Round where an EpochBegan reset already returned a winner's stake", async () => {
      const { alice } = await playRound1();
      await rounds.revealDue(new Date(beaconTime(32883574).getTime() - 1)); // not out yet: stays closed
      const wallet = alice.wallet.publicKey.toBase58();
      await prisma.ticketLedger.create({
        data: { poolAddress: POOL, owner: wallet, epochId: EPOCH + 1n, delta: 20n, reason: "reset", ref: "sig:0" },
      });
      await prisma.ticketBalance.update({
        where: { poolAddress_owner: { poolAddress: POOL, owner: wallet } },
        data: { tickets: { increment: 20n } },
      });
      await rounds.revealDue(beaconTime(32883574));

      expect((await runScript(`${base}/rounds/1/record`)).out).toContain("VERIFIED Round 1: settled");
    });

    describe("fails with a named step", () => {
      const cases: [string, string, (record: any) => void][] = [
        ["a Position signature altered", "S4 bet signature", (r) => void (r.positions[1].signature = bs58.encode(Buffer.alloc(64, 1)))],
        ["a delegation signature altered", "S1 delegation signature", (r) => void (r.delegations[0].signature = bs58.encode(Buffer.alloc(64, 1)))],
        ["a Position moved to another wallet", "S3 session key", (r) => void (r.positions[0].owner = r.positions[1].owner)],
        ["a bet received after close", "S6 bet timing", (r) => void (r.positions[3].receivedAt = new Date(CLOSE1.getTime() + 1).toISOString())],
        ["a revocation before a bet", "S6 bet timing", (r) => {
          const bob = r.delegations.find((d: { wallet: string }) => d.wallet === r.positions[1].owner);
          r.revocations.push({ sessionPubkey: bob.sessionPubkey, wallet: bob.wallet, revokedAt: at(1).toISOString() });
        }],
        ["a betListHash off by one byte", "S7 bet list", (r) => void (r.close.betListHash = `${r.close.betListHash.slice(0, 62)}${r.close.betListHash.endsWith("00") ? "01" : "00"}`)],
        ["a seed that is not the commitment", "B1 seed commitment", (r) => void (r.beacon.seed = "11".repeat(32))],
        ["a beacon from the wrong round", "B3 beacon round", (r) => {
          r.beacon.drandRound = "32883614";
          r.beacon.drandSignature = BEACONS[32883614]!.signature;
        }],
        ["a beacon signature that does not verify", "B4 beacon signature", (r) => void (r.beacon.drandSignature = BEACONS[32883614]!.signature)],
        ["a tile the seed does not give", "B5 tile", (r) => void (r.beacon.tile = (r.beacon.tile + 1) % 36)],
        ["a reward short by one Ticket", "B6 settle", (r) => {
          const row = r.settle.find((x: { reason: string }) => x.reason === "reward");
          row.delta = String(BigInt(row.delta) - 1n);
        }],
      ];

      for (const [name, step, tamper] of cases) {
        it(`${name}: ${step}`, async () => {
          await playRound1();
          await rounds.revealDue(beaconTime(32883574));
          const record = await getRecord();
          tamper(record);

          const verdict = await runScript(await mirror(record));

          expect(verdict.out).toContain(`FAIL ${step}`);
          expect(verdict.code).toBe(1);
        });
      }
    });

    /** A drand relay answering every path with beacon 32883574. */
    async function beaconRelay(): Promise<string> {
      const server = createServer((_, res) => res.end(JSON.stringify(BEACONS[32883574])));
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      mirrors.push(server);
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }

    it("compares the beacon with a relay when asked", async () => {
      await playRound1();
      await rounds.revealDue(beaconTime(32883574));
      const verdict = await runScript(`${base}/rounds/1/record`, "--relay", await beaconRelay());
      expect(verdict.out).toContain("matches the relay");
      expect(verdict.code).toBe(0);
    });

    it("calls out a void whose beacon the relay serves", async () => {
      await playRound1();
      rounds.relays = [deadRelay()];
      await rounds.revealDue(new Date(beaconTime(32883574).getTime() + VOID_AFTER_MS));
      const verdict = await runScript(`${base}/rounds/1/record`, "--relay", await beaconRelay());
      expect(verdict.out).toContain("FAIL B4 beacon signature");
      expect(verdict.code).toBe(1);
    });

    it("exits 2 when the Round has no result yet", async () => {
      await playRound1();
      expect(await runScript(`${base}/rounds/1/record`)).toMatchObject({ code: 2 });
    });
  });
});
