// off-chain-tickets ticket 23, the database half: a signed grant books one
// `grant_admin` row and moves the balance, a resend is a replay, and the route
// is 404 with OPS_WALLETS empty. Shares hexvault_ops with game-config.controller.test.ts.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { grantTickets } from "../admin/grant";
import { ChainService } from "../chain/chain.service";
import { poolAddress } from "../chain/pda";
import { PrismaService } from "../prisma/prisma.service";
import { lockLedger } from "../ledger/ledger-store";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { grantMessage } from "./grants";
import { GrantsController } from "./grants.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n).toBase58();
const TEAM = Keypair.generate();
const STRANGER = Keypair.generate();
const TARGET = Keypair.generate().publicKey.toBase58();
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

function body(over: { keypair?: Keypair; amount?: number; reason?: string; time?: number; wallet?: string } = {}) {
  const keypair = over.keypair ?? TEAM;
  const time = over.time ?? now();
  const amount = over.amount ?? 500;
  const reason = over.reason ?? "launch bonus";
  const wallet = over.wallet ?? TARGET;
  return {
    wallet,
    amount,
    reason,
    signer: keypair.publicKey.toBase58(),
    time,
    signature: sign(keypair, grantMessage(POOL, wallet, BigInt(amount), reason, time)),
  };
}

describe.skipIf(!isDatabaseReachableSync(TEST_DATABASE_URL))("Manual grant route", () => {
  let prisma: PrismaService;
  let app: INestApplication | undefined;

  beforeAll(() => {
    prisma = new PrismaService({ datasourceUrl: TEST_DATABASE_URL });
  });
  beforeEach(async () => {
    await prisma.ticketLedger.deleteMany();
    await prisma.ticketBalance.deleteMany();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(wallets: string[]) {
    const moduleRef = await Test.createTestingModule({
      controllers: [GrantsController],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({ OPS_WALLETS: wallets }) },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
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

  it("books one grant_admin row with signer and signature and moves the balance", async () => {
    const http = await boot(team());
    const signed = body();
    const res = await http.post("/ops/grants").send(signed).expect(201);
    expect(res.body).toMatchObject({
      poolAddress: POOL,
      owner: TARGET,
      delta: "500",
      reason: "grant_admin",
      ref: "launch bonus",
      signer: TEAM.publicKey.toBase58(),
      signature: signed.signature,
    });

    expect(await prisma.ticketLedger.count()).toBe(1);
    expect(await prisma.ticketBalance.findUnique({ where: { poolAddress_owner: { poolAddress: POOL, owner: TARGET } } })).toMatchObject({ tickets: 500n });

    // A second grant to the same wallet adds to the balance.
    await http.post("/ops/grants").send(body({ amount: 25, reason: "make good" })).expect(201);
    const balance = await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner: TARGET } } });
    expect(balance.tickets).toBe(525n);
    expect(await prisma.ticketLedger.count()).toBe(2);
  });

  it("waits for the indexer's ledger lock, so a balance it is rewriting keeps the grant", async () => {
    const http = await boot(team());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // Stands in for bookBatch: read the balance under the lock, write it back absolute.
    const indexer = prisma.$transaction(async (tx) => {
      await lockLedger(tx, POOL);
      locked();
      await held;
      await tx.ticketBalance.create({ data: { poolAddress: POOL, owner: TARGET, tickets: 7n, epochId: 0n } });
    });
    await lockTaken;
    const grant = http.post("/ops/grants").send(body()).then((res) => res.status);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.ticketLedger.count()).toBe(0);
    release();
    await indexer;
    expect(await grant).toBe(201);
    const balance = await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner: TARGET } } });
    expect(balance.tickets).toBe(507n);
  });

  it("refuses the same signed request resent as a replay and moves nothing", async () => {
    const http = await boot(team());
    const signed = body();
    await http.post("/ops/grants").send(signed).expect(201);
    const res = await http.post("/ops/grants").send(signed).expect(409);
    expect(res.body.code).toBe("AlreadyApplied");
    expect(await prisma.ticketLedger.count()).toBe(1);
    const balance = await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner: TARGET } } });
    expect(balance.tickets).toBe(500n);
  });

  it("names each refusal and writes nothing", async () => {
    const http = await boot(team());
    const cases: [number, string, unknown][] = [
      [403, "WalletNotListed", body({ keypair: STRANGER })],
      [403, "RequestStale", body({ time: now() - 130 })],
      [403, "BadSignature", { ...body(), signature: sign(TEAM, "something else") }],
      [400, "AmountOutOfRange", { ...body(), amount: 0 }],
      [400, "AmountOutOfRange", { ...body(), amount: -3 }],
      [400, "ReasonInvalid", body({ reason: "x".repeat(201) })],
    ];
    for (const [status, code, payload] of cases) {
      const res = await http.post("/ops/grants").send(payload as object).expect(status);
      expect(res.body.code).toBe(code);
    }
    expect(await prisma.ticketLedger.count()).toBe(0);
    expect(await prisma.ticketBalance.count()).toBe(0);
  });

  it("is 400 for a malformed body", async () => {
    const http = await boot(team());
    await http.post("/ops/grants").send({}).expect(400);
    await http.post("/ops/grants").send({ ...body(), signature: "0OIl" }).expect(400);
    await http.post("/ops/grants").send({ ...body(), wallet: "nope" }).expect(400);
  });

  it("books the grant the admin CLI posts to a listening backend and prints the row id", async () => {
    await boot(team());
    await app!.listen(0, "127.0.0.1");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let printed: unknown[];
    try {
      await grantTickets(
        { kind: "grant-tickets", owner: new PublicKey(TARGET), amount: 70n, reason: "cli grant", keypair: "unused" },
        TEAM,
        { pool: POOL, backendUrl: await app!.getUrl() },
      );
    } finally {
      printed = stdout.mock.calls.map(([text]) => text);
      vi.restoreAllMocks();
    }
    const row = await prisma.ticketLedger.findFirstOrThrow();
    expect(row).toMatchObject({ owner: TARGET, delta: 70n, reason: "grant_admin", ref: "cli grant", signer: TEAM.publicKey.toBase58() });
    expect(printed).toEqual([`${row.id}\n`]);
  });

  it("is 404 with OPS_WALLETS empty", async () => {
    const http = await boot([]);
    await http.post("/ops/grants").send(body()).expect(404);
    expect(await prisma.ticketLedger.count()).toBe(0);
  });
});
