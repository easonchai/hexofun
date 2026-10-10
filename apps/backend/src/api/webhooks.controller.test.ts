// No database: the Indexer is a recording fake, since what the route owes it
// is one `ingestPushed` call per verified delivery. Dedup against `onLogs` is
// covered in indexer.test.ts, against Postgres.
import { createHmac } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexerService } from "../indexer/indexer.service";
import { MAX_BODY_BYTES, WebhooksController, webhookLastSlot } from "./webhooks.controller";

const SECRET = "whsec_test_only_not_a_real_secret";
const SIGNATURE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOGS = ["Program LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6 invoke [1]", "Program log: hi"];

type Pushed = Parameters<IndexerService["ingestPushed"]>[0];

const delivery = (overrides: object = {}): string =>
  JSON.stringify({
    payload_kind: "raw",
    signature: SIGNATURE,
    slot: 77,
    transaction: { meta: { err: null, logMessages: LOGS } },
    ...overrides,
  });

const sign = (body: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(body).digest("hex");

async function start(secret: string | undefined, pushed: Pushed[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WebhooksController],
    providers: [
      { provide: IndexerService, useValue: { ingestPushed: (tx: Pushed) => Promise.resolve(void pushed.push(tx)) } },
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

  it("hands a signed delivery to the Indexer and reports its slot", async () => {
    const body = delivery();
    const { body: answer } = await post(app, body, sign(body)).expect(200);
    expect(answer).toEqual({ ok: true });
    expect(pushed).toEqual([{ signature: SIGNATURE, slot: 77n, logs: LOGS, err: null }]);
    expect(webhookLastSlot()).toBe(77);
  });

  it("verifies the bytes as sent, not a re-serialised body", async () => {
    const body = `{ "signature": "${SIGNATURE}",  "slot": 78, "transaction": { "meta": { "logMessages": [] } } }`;
    await post(app, body, sign(body)).expect(200);
    expect(pushed).toHaveLength(1);
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

  it("is 400 on a signed delivery without the log lines", async () => {
    const body = delivery({ transaction: { meta: { err: null } } });
    await post(app, body, sign(body)).expect(400);
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
