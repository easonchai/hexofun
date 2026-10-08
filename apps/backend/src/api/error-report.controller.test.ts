// Against a real Postgres (same shape as access.test.ts and api.test.ts): a
// dedicated database so a rerun, or another agent's suite, cannot collide
// with these rows. ErrorReportController is exercised directly — it needs no
// ChainService, so there is nothing to fake.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_error_reports";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { type INestApplication, Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { ErrorReportController, MAX_ROWS } from "./error-report.controller";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

describe.skipIf(!DB_AVAILABLE)("POST /error-reports", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [ErrorReportController],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await prisma.errorReport.deleteMany();

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await prisma.errorReport.deleteMany();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.errorReport.deleteMany();
  });

  it("stores a decoded send failure and answers ok", async () => {
    const { body } = await http
      .post("/error-reports")
      .send({
        code: "program_error_6012",
        message: '{"InstructionError":[0,{"Custom":6012}]}',
        signature: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        page: "#VAULT",
      })
      .expect(201);
    expect(body).toEqual({ ok: true });

    const rows = await prisma.errorReport.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "program_error_6012",
      message: '{"InstructionError":[0,{"Custom":6012}]}',
      signature: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      page: "#VAULT",
    });
  });

  it("stores a boundary catch with no signature or wallet", async () => {
    const { body } = await http
      .post("/error-reports")
      .send({ code: "render_error", message: "Cannot read properties of undefined" })
      .expect(201);
    expect(body).toEqual({ ok: true });

    const rows = await prisma.errorReport.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signature).toBeNull();
    expect(rows[0]?.wallet).toBeNull();
    expect(rows[0]?.page).toBeNull();
  });

  it("is 400 without a code", async () => {
    await http.post("/error-reports").send({ message: "oops" }).expect(400);
  });

  it("is 400 without a message", async () => {
    await http.post("/error-reports").send({ code: "render_error" }).expect(400);
  });

  it("logs a message with newlines on one line", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await http
        .post("/error-reports")
        .send({ code: "x\ny", message: "first\r\nWARN [Operator] forged line" })
        .expect(201);
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/[\r\n]/);
      expect(lines[0]).toContain("forged line");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps only the newest MAX_ROWS rows", async () => {
    // Seed MAX_ROWS rows, then one more through the route: the oldest goes.
    await prisma.errorReport.createMany({
      data: Array.from({ length: MAX_ROWS }, () => ({ code: "seed", message: "m" })),
    });
    await http.post("/error-reports").send({ code: "new", message: "m" }).expect(201);
    expect(await prisma.errorReport.count()).toBe(MAX_ROWS);
    expect(await prisma.errorReport.count({ where: { code: "new" } })).toBe(1);
  });
});
