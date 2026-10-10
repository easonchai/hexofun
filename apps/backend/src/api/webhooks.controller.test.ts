// No database: the Indexer and the RPC are recording fakes, since what the
// route owes the Indexer is one `ingestPushed` call per verified, finalized
// delivery. Dedup against `onLogs` is covered in indexer.test.ts, against Postgres.
import { createHmac } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChainService } from "../chain/chain.service";
import { IndexerService } from "../indexer/indexer.service";
import {
  FINALITY_CHECKS,
  FINALITY_INTERVAL_MS,
  MAX_BODY_BYTES,
  WebhooksController,
  awaitFinalized,
  webhookLastSlot,
} from "./webhooks.controller";

const SECRET = "whsec_test_only_not_a_real_secret";
const SIGNATURE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOGS = ["Program LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 invoke [1]", "Program log: hi"];
/** The slot the fake RPC reports finality at; differs from the delivery's 77. */
const FINAL_SLOT = 80;

type Pushed = Parameters<IndexerService["ingestPushed"]>[0];

// The Raw envelope as the 2026-10-10 probe saw it, trimmed to the fields read.
const delivery = (overrides: object = {}): string =>
  JSON.stringify({
    payload_kind: "raw",
    signature: SIGNATURE,
    slot: 77,
    status: "succeeded",
    transaction: { signature: SIGNATURE, slot: 77, logs: LOGS },
    ...overrides,
  });

const sign = (body: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const finalized = { getSignatureStatuses: async () => ({ value: [{ slot: FINAL_SLOT, err: null, confirmationStatus: "finalized" }] }) };

async function start(secret: string | undefined, pushed: Pushed[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WebhooksController],
    providers: [
      { provide: IndexerService, useValue: { ingestPushed: (tx: Pushed) => Promise.resolve(void pushed.push(tx)) } },
      { provide: ChainService, useValue: { connection: finalized } },
      { provide: ConfigService, useValue: { get: () => secret } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const post = (app: INestApplication, body: string, signature?: string) => {
  const req = request(app.getHttpServer()).post("/webhooks/solami").set("content-type", "application/json");
  return (signature === undefined ? req : req.set("X-Webhook-Signature", signature)).send(body);
};

describe("POST /webhooks/solami", () => {
  let app: INestApplication;
  let pushed: Pushed[];

  beforeEach(async () => {
    pushed = [];
    app = await start(SECRET, pushed);
  });

  afterEach(async () => {
    await app.close();
  });

  it("hands a signed delivery to the Indexer at its finalized slot", async () => {
    const body = delivery();
    const { body: answer } = await post(app, body, sign(body)).expect(200);
    expect(answer).toEqual({ ok: true });
    await vi.waitFor(() => expect(pushed).toEqual([{ signature: SIGNATURE, slot: BigInt(FINAL_SLOT), logs: LOGS, err: null }]));
    expect(webhookLastSlot()).toBe(FINAL_SLOT);
  });

  it("verifies the bytes as sent, not a re-serialised body", async () => {
    const body = `{ "signature": "${SIGNATURE}",  "slot": 78, "status": "succeeded", "transaction": { "logs": [] } }`;
    await post(app, body, sign(body)).expect(200);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
  });

  it("answers 200 and ingests nothing for a failed transaction", async () => {
    const body = delivery({ status: "failed" });
    await post(app, body, sign(body)).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushed).toEqual([]);
  });

  it("is 401 and ingests nothing on a wrong signature", async () => {
    const body = delivery();
    await post(app, body, sign(body, "whsec_some_other_secret")).expect(401);
    await post(app, body, sign(delivery({ slot: 1 }))).expect(401);
    expect(pushed).toEqual([]);
  });

  it("is 401 and ingests nothing without the header", async () => {
    await post(app, delivery()).expect(401);
    expect(pushed).toEqual([]);
  });

  it("is 400 on a signed delivery without the log lines or status", async () => {
    for (const body of [delivery({ transaction: { signature: SIGNATURE } }), delivery({ status: undefined })]) {
      await post(app, body, sign(body)).expect(400);
    }
    expect(pushed).toEqual([]);
  });

  it("is 413 over the size cap", async () => {
    const body = delivery({ padding: "x".repeat(MAX_BODY_BYTES) });
    await post(app, body, sign(body)).expect(413);
    expect(pushed).toEqual([]);
  });

  it("is 404 with SOLAMI_WEBHOOK_SECRET unset", async () => {
    const off: Pushed[] = [];
    const offApp = await start(undefined, off);
    try {
      const body = delivery();
      await post(offApp, body, sign(body)).expect(404);
      expect(off).toEqual([]);
    } finally {
      await offApp.close();
    }
  });
});

describe("awaitFinalized", () => {
  const noSleep = async () => {};

  it("polls until the RPC reports finalized and returns that slot", async () => {
    const answers = [null, { slot: 9, err: null, confirmationStatus: "confirmed" }, { slot: 10, err: null, confirmationStatus: "finalized" }];
    const sleeps: number[] = [];
    const slot = await awaitFinalized(async () => answers.shift() ?? null, SIGNATURE, async (ms) => void sleeps.push(ms));
    expect(slot).toBe(10);
    expect(sleeps).toEqual([FINALITY_INTERVAL_MS, FINALITY_INTERVAL_MS]);
  });

  it("is null for a transaction that errored", async () => {
    expect(await awaitFinalized(async () => ({ slot: 9, err: { InstructionError: [0, "x"] }, confirmationStatus: "finalized" }), SIGNATURE, noSleep)).toBeNull();
  });

  it("is null after FINALITY_CHECKS reads without finality", async () => {
    let reads = 0;
    const slot = await awaitFinalized(async () => {
      reads += 1;
      return { slot: 9, err: null, confirmationStatus: "confirmed" };
    }, SIGNATURE, noSleep);
    expect(slot).toBeNull();
    expect(reads).toBe(FINALITY_CHECKS);
  });

  it("treats a failed status read as not yet", async () => {
    let reads = 0;
    const slot = await awaitFinalized(async () => {
      reads += 1;
      if (reads === 1) throw new Error("rpc down");
      return { slot: 11, err: null, confirmationStatus: "finalized" };
    }, SIGNATURE, noSleep);
    expect(slot).toBe(11);
  });
});
