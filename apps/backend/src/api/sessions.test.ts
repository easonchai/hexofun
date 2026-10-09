// Against a real Postgres (off-chain-tickets ticket 15), same shape as
// access.test.ts: a dedicated database, the controller driven over HTTP, a
// one-method fake standing in for the chain.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_sessions";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { delegationMessage, revokeMessage } from "./session";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const ORIGIN = "https://hexvault.xyz";
const POOL = Keypair.generate().publicKey;

function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

describe.skipIf(!DB_AVAILABLE)("session delegation", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionsService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [SessionsController],
      providers: [
        SessionsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            CORS_ORIGIN: `http://localhost:5173, ${ORIGIN}`,
            CLUSTER: "mainnet-beta",
            PROGRAM_ID,
          }),
        },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await prisma.session.deleteMany();
    await prisma.sessionNonce.deleteMany();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.sessionNonce.deleteMany();
  });

  /** Asks for a nonce over HTTP and builds a delegation signed by `signer`. */
  async function delegation(wallet = Keypair.generate(), signer = wallet) {
    const { body } = await http.get("/game/sessions/nonce").expect(200);
    const session = Keypair.generate();
    const now = new Date();
    const message = delegationMessage({
      domain: "hexvault.xyz",
      wallet: wallet.publicKey.toBase58(),
      uri: ORIGIN,
      chainId: "mainnet-beta",
      nonce: body.nonce,
      issuedAt: iso(now),
      expirationTime: iso(new Date(now.getTime() + 24 * 3600 * 1000)),
      sessionPubkey: session.publicKey.toBase58(),
      programId: PROGRAM_ID,
    });
    return { wallet, session, message, signature: sign(signer, message), nonce: body.nonce as string };
  }

  describe("GET /game/sessions/nonce", () => {
    it("hands out a 16 byte base58 nonce that lives ten minutes", async () => {
      const { body } = await http.get("/game/sessions/nonce").expect(200);
      expect(bs58.decode(body.nonce)).toHaveLength(16);
      const lifeMs = new Date(body.expiresAt).getTime() - Date.now();
      expect(lifeMs).toBeGreaterThan(9 * 60_000);
      expect(lifeMs).toBeLessThanOrEqual(10 * 60_000);
    });
  });

  describe("POST /game/sessions", () => {
    it("stores the delegation and answers with its id", async () => {
      const d = await delegation();
      const { body } = await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: d.signature })
        .expect(201);
      expect(body).toMatchObject({
        wallet: d.wallet.publicKey.toBase58(),
        sessionPubkey: d.session.publicKey.toBase58(),
      });
      const row = await prisma.session.findUniqueOrThrow({ where: { id: body.id } });
      expect(row).toMatchObject({
        poolAddress: POOL.toBase58(),
        message: d.message,
        signature: d.signature,
        revokedAt: null,
        nextSeq: 0,
      });
    });

    it("spends the nonce: a second post of the same message is refused", async () => {
      const d = await delegation();
      const send = { message: d.message, signature: d.signature };
      await http.post("/game/sessions").set("Origin", ORIGIN).send(send).expect(201);
      const { body } = await http.post("/game/sessions").set("Origin", ORIGIN).send(send).expect(409);
      expect(body.code).toBe("NonceInvalid");
      expect(await prisma.session.count()).toBe(1);
    });

    it("refuses a nonce the server never issued, and an expired one", async () => {
      const d = await delegation();
      await prisma.sessionNonce.deleteMany();
      await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: d.signature })
        .expect(409);

      const stale = await sessions.issueNonce(new Date(Date.now() - 11 * 60_000));
      await prisma.sessionNonce.create({ data: { nonce: d.nonce, expiresAt: stale.expiresAt } });
      await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: d.signature })
        .expect(409);
      expect(await prisma.session.count()).toBe(0);
    });

    it("refuses a signature by another wallet and leaves the nonce unspent", async () => {
      const wallet = Keypair.generate();
      const d = await delegation(wallet, Keypair.generate());
      const { body } = await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: d.signature })
        .expect(403);
      expect(body.code).toBe("BadSignature");
      await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: sign(wallet, d.message) })
        .expect(201);
    });

    it("refuses a signed URI that differs from the Origin header, or a missing header, and keeps the nonce", async () => {
      const d = await delegation();
      const send = { message: d.message, signature: d.signature };
      const other = await http.post("/game/sessions").set("Origin", "http://localhost:5173").send(send).expect(400);
      expect(other.body.code).toBe("BadMessage");
      const missing = await http.post("/game/sessions").send(send).expect(400);
      expect(missing.body.code).toBe("BadMessage");
      await http.post("/game/sessions").set("Origin", ORIGIN).send(send).expect(201);
    });

    it("400s a body with no message or a malformed signature", async () => {
      await http.post("/game/sessions").set("Origin", ORIGIN).send({ signature: "x" }).expect(400);
      await http.post("/game/sessions").set("Origin", ORIGIN).send({ message: "hi", signature: "0OIl" }).expect(400);
      await http.post("/game/sessions").set("Origin", ORIGIN).send({ message: "hi", signature: bs58.encode(Buffer.alloc(8)) }).expect(400);
    });
  });

  describe("checkSession", () => {
    async function created() {
      const d = await delegation();
      await http.post("/game/sessions").set("Origin", ORIGIN).send({ message: d.message, signature: d.signature }).expect(201);
      return { ...d, key: d.session.publicKey.toBase58() };
    }

    it("returns the live Session", async () => {
      const d = await created();
      const result = await sessions.checkSession(d.key);
      expect(result.ok && result.session.wallet).toBe(d.wallet.publicKey.toBase58());
    });

    it("refuses an unknown key, an expired session and a revoked one with SessionInvalid", async () => {
      const d = await created();
      const invalid = { ok: false, code: "SessionInvalid" };
      expect(await sessions.checkSession(Keypair.generate().publicKey.toBase58())).toEqual(invalid);
      expect(await sessions.checkSession(d.key, new Date(Date.now() + 25 * 3600 * 1000))).toEqual(invalid);

      const row = await prisma.session.findUniqueOrThrow({ where: { sessionPubkey: d.key } });
      const time = Math.floor(Date.now() / 1000);
      await http
        .post(`/game/sessions/${row.id}/revoke`)
        .send({ time, signature: sign(d.wallet, revokeMessage(d.key, time)) })
        .expect(201);
      expect(await sessions.checkSession(d.key)).toEqual(invalid);
    });
  });

  describe("POST /game/sessions/:id/revoke", () => {
    async function created() {
      const d = await delegation();
      const { body } = await http
        .post("/game/sessions").set("Origin", ORIGIN)
        .send({ message: d.message, signature: d.signature })
        .expect(201);
      return { ...d, id: body.id as string, key: d.session.publicKey.toBase58() };
    }
    const now = () => Math.floor(Date.now() / 1000);

    it("sets revokedAt, and a repeat keeps the first time", async () => {
      const d = await created();
      const time = now();
      const send = { time, signature: sign(d.wallet, revokeMessage(d.key, time)) };
      const first = await http.post(`/game/sessions/${d.id}/revoke`).send(send).expect(201);
      const second = await http.post(`/game/sessions/${d.id}/revoke`).send(send).expect(201);
      expect(second.body.revokedAt).toBe(first.body.revokedAt);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.revokedAt?.toISOString()).toBe(first.body.revokedAt);
    });

    it("refuses a signature that is not the delegating wallet's", async () => {
      const d = await created();
      const time = now();
      const { body } = await http
        .post(`/game/sessions/${d.id}/revoke`)
        .send({ time, signature: sign(Keypair.generate(), revokeMessage(d.key, time)) })
        .expect(403);
      expect(body.code).toBe("BadSignature");
      expect((await prisma.session.findUniqueOrThrow({ where: { id: d.id } })).revokedAt).toBeNull();
    });

    it("refuses a stale time and an unknown session", async () => {
      const d = await created();
      const old = now() - 3600;
      const { body } = await http
        .post(`/game/sessions/${d.id}/revoke`)
        .send({ time: old, signature: sign(d.wallet, revokeMessage(d.key, old)) })
        .expect(400);
      expect(body.code).toBe("StaleRevoke");
      const time = now();
      await http
        .post("/game/sessions/no-such-id/revoke")
        .send({ time, signature: sign(d.wallet, revokeMessage(d.key, time)) })
        .expect(404);
    });
  });
});
