// Ticket ops-console/06. The controller runs without a database: the chain
// service is a recording fake, and the instructions it receives are the real
// ones, decoded back out of what the route sent.
import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { AnchorProvider, BorshInstructionCoder, Program, Wallet, type Idl } from "@anchor-lang/core";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { poolAddress } from "../chain/pda";
import { validateEnv } from "../config/env";
import { FastPauseController } from "./fast-pause.controller";
import { accessMessage, applyReferralMessage, fastPauseMessage } from "./invite-code";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const OPERATOR = Keypair.generate();
const TEAM = Keypair.generate();
const STRANGER = Keypair.generate();

const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(OPERATOR), {}),
);
const coder = new BorshInstructionCoder(idl);

function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

const now = (): number => Math.floor(Date.now() / 1000);

interface Sent {
  instructions: TransactionInstruction[];
}

describe("POST /ops/fast-pause", () => {
  let app: INestApplication | undefined;
  const sent: Sent[] = [];
  let failSend = false;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    sent.length = 0;
    failSend = false;
  });

  async function boot(wallets: string[] | undefined) {
    const chain = {
      poolAddress: () => POOL,
      program,
      programId: PROGRAM_ID,
      keypair: OPERATOR,
      send: async (instructions: TransactionInstruction[]) => {
        if (failSend) throw new Error("rpc https://secret.example/?key=abc down");
        sent.push({ instructions });
        return "SIG123";
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [FastPauseController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService(wallets === undefined ? {} : { OPS_WALLETS: wallets }),
        },
        { provide: ChainService, useValue: chain },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return request(app.getHttpServer());
  }

  const body = (
    over: { feature?: string; keypair?: Keypair; time?: number; pool?: string; signature?: string } = {},
  ) => {
    const keypair = over.keypair ?? TEAM;
    const feature = over.feature ?? "pool";
    const time = over.time ?? now();
    const message = fastPauseMessage(feature as never, over.pool ?? POOL.toBase58(), time);
    return {
      switch: feature,
      wallet: keypair.publicKey.toBase58(),
      time,
      signature: over.signature ?? sign(keypair, message),
    };
  };

  const team = [TEAM.publicKey.toBase58()];

  it("pins the message format", () => {
    expect(fastPauseMessage("game", "POOLADDR", 1700000000)).toBe(
      "HEXO fast pause: game POOLADDR 1700000000",
    );
    expect(fastPauseMessage("game", "P", 1)).not.toBe(accessMessage("W", "game"));
    expect(fastPauseMessage("game", "P", 1).startsWith(applyReferralMessage("", ""))).toBe(false);
  });

  it("is 404 with the allowlist unset or empty", async () => {
    await (await boot(undefined)).post("/ops/fast-pause").send(body()).expect(404);
    await app?.close();
    await (await boot([])).post("/ops/fast-pause").send(body()).expect(404);
    expect(sent).toHaveLength(0);
  });

  it("is 400 for a bad switch, wallet, time or signature", async () => {
    const http = await boot(team);
    const good = body();
    for (const bad of [
      { ...good, switch: "shutdown" },
      { ...good, wallet: "nope" },
      { ...good, time: "now" },
      { ...good, time: 1.5 },
      { ...good, signature: "0OIl" },
      { ...good, signature: bs58.encode(Buffer.alloc(10)) },
    ]) {
      const res = await http.post("/ops/fast-pause").send(bad).expect(400);
      expect(res.body.message).toMatch(/`(switch|wallet|time|signature)`/);
    }
    await http.post("/ops/fast-pause").send({}).expect(400);
    expect(sent).toHaveLength(0);
  });

  it("is 403 for a wallet off the list", async () => {
    const http = await boot(team);
    await http.post("/ops/fast-pause").send(body({ keypair: STRANGER })).expect(403);
    expect(sent).toHaveLength(0);
  });

  it("is 403 for a bad signature", async () => {
    const http = await boot(team);
    const other = sign(TEAM, "something else");
    await http.post("/ops/fast-pause").send(body({ signature: other })).expect(403);
    expect(sent).toHaveLength(0);
  });

  it("is 403 for a time more than 120 seconds off, either way", async () => {
    const http = await boot(team);
    await http.post("/ops/fast-pause").send(body({ time: now() - 130 })).expect(403);
    await http.post("/ops/fast-pause").send(body({ time: now() + 130 })).expect(403);
    expect(sent).toHaveLength(0);
  });

  it("is 403 for a message naming another pool", async () => {
    const http = await boot(team);
    const other = poolAddress(PROGRAM_ID, 2n).toBase58();
    await http.post("/ops/fast-pause").send(body({ pool: other })).expect(403);
    expect(sent).toHaveLength(0);
  });

  it("is 403 for a signature over another switch", async () => {
    const http = await boot(team);
    const time = now();
    const signature = sign(TEAM, fastPauseMessage("game", POOL.toBase58(), time));
    await http
      .post("/ops/fast-pause")
      .send({ ...body({ feature: "jackpot", time }), signature })
      .expect(403);
    expect(sent).toHaveLength(0);
  });

  const cases: [string, string, unknown[]][] = [
    ["pool", "setPause", [true]],
    ["game", "setFeaturePause", [{ Game: {} }, true]],
    ["jackpot", "setFeaturePause", [{ Jackpot: {} }, true]],
    ["deploy", "setDeployPause", [true]],
  ];
  it.each(cases)("accepts %s and sends %s with true", async (feature, name, args) => {
    const http = await boot(team);
    const res = await http.post("/ops/fast-pause").send(body({ feature })).expect(201);
    expect(res.body).toEqual({ signature: "SIG123" });
    expect(sent).toHaveLength(1);
    const ixs = sent[0]!.instructions;
    expect(ixs).toHaveLength(1);
    const decoded = coder.decode(ixs[0]!.data);
    expect(decoded?.name.replace(/_/g, "").toLowerCase()).toBe(name.toLowerCase());
    expect(decoded?.data).toEqual(
      name === "setFeaturePause"
        ? { feature: args[0], paused: true }
        : { paused: true },
    );
    // Accounts: operator signs, pool is writable.
    expect(ixs[0]!.keys[0]!.pubkey.equals(OPERATOR.publicKey)).toBe(true);
    expect(ixs[0]!.keys[1]!.pubkey.equals(POOL)).toBe(true);
  });

  it("is 502 telling the caller to use the CLI when the send fails, without leaking the cause", async () => {
    const http = await boot(team);
    failSend = true;
    const res = await http.post("/ops/fast-pause").send(body()).expect(502);
    expect(res.body.message).toMatch(/did not land/);
    expect(res.body.message).toMatch(/CLI/);
    expect(JSON.stringify(res.body)).not.toContain("secret.example");
  });
});

describe("OPS_WALLETS env", () => {
  const base = {
    DATABASE_URL: "x",
    RPC_URL: "x",
    OPERATOR_KEYPAIR: "x",
    ACCEPTED_MINT: "x",
    CORS_ORIGIN: "x",
    PROGRAM_ID: "x",
    POOL_ID: "1",
    CLUSTER: "devnet",
  };
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();

  it("is empty when unset or blank", () => {
    expect(validateEnv(base).OPS_WALLETS).toEqual([]);
    expect(validateEnv({ ...base, OPS_WALLETS: "  " }).OPS_WALLETS).toEqual([]);
  });
  it("parses a comma separated list, trimming spaces", () => {
    expect(validateEnv({ ...base, OPS_WALLETS: ` ${a} , ${b},` }).OPS_WALLETS).toEqual([a, b]);
  });
  it("refuses to boot on a bad entry", () => {
    expect(() => validateEnv({ ...base, OPS_WALLETS: `${a},nope` })).toThrow(/OPS_WALLETS/);
  });
});
