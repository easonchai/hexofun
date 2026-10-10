// off-chain-tickets ticket 14, the database half: the seed row, two signed
// changes in order, history, replay and the 404. Shares hexvault_ops with
// ops-summary.test.ts, which never touches GameConfig.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_ops";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { poolAddress } from "../chain/pda";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { DEFAULT_GAME_CONFIG, gameConfigMessage, type GameConfigFields } from "./game-config";
import { GameConfigController } from "./game-config.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const TEAM = Keypair.generate();
const STRANGER = Keypair.generate();
const now = (): number => Math.floor(Date.now() / 1000);

function sign(keypair: Keypair, message: string): string {
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

function body(fields: GameConfigFields, over: { keypair?: Keypair; time?: number } = {}) {
  const keypair = over.keypair ?? TEAM;
  const time = over.time ?? now();
  return {
    wallet: keypair.publicKey.toBase58(),
    time,
    fields,
    signature: sign(keypair, gameConfigMessage(POOL.toBase58(), time, fields)),
  };
}

describe.skipIf(!isDatabaseReachableSync(TEST_DATABASE_URL))("Game config routes", () => {
  let prisma: PrismaService;
  let app: INestApplication | undefined;

  beforeAll(() => {
    prisma = new PrismaService({ datasourceUrl: TEST_DATABASE_URL });
  });
  beforeEach(async () => {
    await prisma.gameConfig.deleteMany();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(wallets: string[]) {
    const moduleRef = await Test.createTestingModule({
      controllers: [GameConfigController],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({ OPS_WALLETS: wallets }) },
        { provide: ChainService, useValue: { poolAddress: () => POOL } },
        { provide: PrismaService, useValue: prisma },
        { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return request(app.getHttpServer());
  }

  const team = () => [TEAM.publicKey.toBase58()];

  it("seeds the defaults once, not on every start", async () => {
    await boot(team());
    await app?.close();
    await boot(team());
    const rows = await prisma.gameConfig.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      poolAddress: POOL.toBase58(),
      roundSeconds: DEFAULT_GAME_CONFIG.roundSeconds,
      houseCutBps: DEFAULT_GAME_CONFIG.houseCutBps,
      signer: null,
      signature: null,
      message: null,
    });
    expect(rows[0]!.referralTiers).toEqual(DEFAULT_GAME_CONFIG.referralTiers);
  });

  it("leaves two rows after two changes and names the second in force", async () => {
    const http = await boot(team());
    const first = { ...DEFAULT_GAME_CONFIG, houseCutBps: 700 };
    const second = { ...DEFAULT_GAME_CONFIG, houseCutBps: 800, maxTilesPerBet: 12 };
    const a = await http.post("/ops/game-config").send(body(first)).expect(201);
    const time = now();
    const b = await http.post("/ops/game-config").send(body(second, { time })).expect(201);
    expect(b.body).toMatchObject({
      houseCutBps: 800,
      maxTilesPerBet: 12,
      signer: TEAM.publicKey.toBase58(),
      message: gameConfigMessage(POOL.toBase58(), time, second),
    });

    expect(await prisma.gameConfig.count()).toBe(3); // seed plus the two changes
    const res = await http.get("/game/config").expect(200);
    expect(res.body.inForce.id).toBe(b.body.id);
    expect(res.body.inForce.houseCutBps).toBe(800);
    expect(res.body.history.map((r: { id: number }) => r.id)).toEqual([b.body.id, a.body.id, expect.any(Number)]);
  });

  it("keeps the admin grant cap in force when a change leaves it out (audit-2026-10-09 08)", async () => {
    const http = await boot(team());
    const { maxAdminGrant: _drop, ...legacy } = DEFAULT_GAME_CONFIG;
    await http.post("/ops/game-config").send(body({ ...legacy, maxAdminGrant: 50_000 })).expect(201);
    const res = await http.post("/ops/game-config").send(body({ ...legacy, houseCutBps: 700 }, { time: now() })).expect(201);
    expect(res.body).toMatchObject({ houseCutBps: 700, maxAdminGrant: 50_000 });
  });

  it("refuses to apply the same signed change twice", async () => {
    const http = await boot(team());
    const signed = body({ ...DEFAULT_GAME_CONFIG, houseCutBps: 700 });
    await http.post("/ops/game-config").send(signed).expect(201);
    const res = await http.post("/ops/game-config").send(signed).expect(409);
    expect(res.body.code).toBe("AlreadyApplied");
    expect(await prisma.gameConfig.count()).toBe(2);
  });

  it("names each refusal and writes nothing", async () => {
    const http = await boot(team());
    const fields = { ...DEFAULT_GAME_CONFIG, houseCutBps: 700 };
    const cases: [number, string, unknown][] = [
      [403, "WalletNotListed", body(fields, { keypair: STRANGER })],
      [403, "RequestStale", body(fields, { time: now() - 130 })],
      [403, "BadSignature", { ...body(fields), signature: sign(TEAM, "something else") }],
      [400, "FieldOutOfRange", body({ ...fields, houseCutBps: 10_001 })],
    ];
    for (const [status, code, payload] of cases) {
      const res = await http.post("/ops/game-config").send(payload as object).expect(status);
      expect(res.body.code).toBe(code);
    }
    expect(await prisma.gameConfig.count()).toBe(1); // the seed only
  });

  it("is 400 for a malformed body", async () => {
    const http = await boot(team());
    await http.post("/ops/game-config").send({}).expect(400);
    await http.post("/ops/game-config").send({ ...body(DEFAULT_GAME_CONFIG), signature: "0OIl" }).expect(400);
  });

  it("is 404 on the change route with OPS_WALLETS empty, and the read still answers", async () => {
    const http = await boot([]);
    await http.post("/ops/game-config").send(body(DEFAULT_GAME_CONFIG)).expect(404);
    expect(await prisma.gameConfig.count()).toBe(1);
    const res = await http.get("/game/config").expect(200);
    expect(res.body.inForce.signer).toBeNull();
  });
});
