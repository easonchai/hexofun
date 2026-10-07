import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TodoItem } from "../api.js";
import { ALERT_CODES, bannerOf, dueFor, entryOf, OPS_MAP } from "./opsMap.js";

const repo = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

const todo = (code: TodoItem["code"], due: TodoItem["due"], extra: Partial<TodoItem> = {}): TodoItem => ({
  code,
  message: code,
  due,
  ...extra,
});

describe("opsMap", () => {
  it("lists the backend's AlertCode exactly", () => {
    const union = /export type AlertCode =([^;]+);/.exec(repo("apps/backend/src/api/alerts.controller.ts"))?.[1] ?? "";
    const backend = [...union.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect([...ALERT_CODES].sort()).toEqual(backend.sort());
  });

  it("has an entry for every alert code, and red for the nine the spec names", () => {
    const red = ALERT_CODES.filter((c) => OPS_MAP[c].severity === "red").sort();
    expect(red).toEqual(
      [
        "SOLVENCY_NEGATIVE",
        "POOL_IMPAIRED",
        "WITHDRAW_SHORTFALL",
        "OPERATOR_STALE",
        "OPERATOR_FAILING",
        "RPC_DOWN",
        "INDEXER_STALE",
        "DRAWN_UNPAID",
        "EPOCH_NO_PROGRESS",
      ].sort(),
    );
  });

  it("treats an unknown code as amber with no button", () => {
    expect(entryOf("SOMETHING_NEW")).toEqual({ severity: "amber", action: null });
  });
});

describe("bannerOf", () => {
  it("is green with no alerts and only bot todos", () => {
    const b = bannerOf([], [todo("DEPLOY_DUE", "bot")]);
    expect(b.state).toBe("green");
    expect(b.lines).toEqual([]);
    expect(b.bot.map((t) => t.code)).toEqual(["DEPLOY_DUE"]);
  });

  it("is amber with an amber alert or a todo due now", () => {
    expect(bannerOf([{ code: "DEPLOY_PAUSED", message: "m" }], []).state).toBe("amber");
    const b = bannerOf([], [todo("STUCK_EPOCH", "now")]);
    expect(b.state).toBe("amber");
    expect(b.lines[0]).toMatchObject({ code: "STUCK_EPOCH", action: "rollover" });
  });

  it("is red when any red alert fires, red lines first, then amber, then todos", () => {
    const b = bannerOf(
      [
        { code: "FREE_IDLE_LOW", message: "m" },
        { code: "OPERATOR_STALE", message: "m" },
      ],
      [todo("RECALL_DUE", "now")],
    );
    expect(b.state).toBe("red");
    expect(b.lines.map((l) => l.code)).toEqual(["OPERATOR_STALE", "FREE_IDLE_LOW", "RECALL_DUE"]);
  });

  it("is not green when the chain read failed", () => {
    const b = bannerOf([], [], false);
    expect(b.state).toBe("amber");
    expect(b.lines[0]).toMatchObject({ code: "CHAIN_UNREAD", playbook: "RPC_DOWN" });
  });

  it("lights a button only for a todo due now", () => {
    expect(dueFor([todo("HARVEST_DUE", "bot")], "harvest")).toBeUndefined();
    expect(dueFor([todo("HARVEST_DUE", "now")], "harvest")?.code).toBe("HARVEST_DUE");
  });
});
