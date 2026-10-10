import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyGameConfigError,
  formFromFields,
  gameConfigMessage,
  parseForm,
  submitGameConfig,
  type GameConfigFields,
} from "./gameConfig.js";

const FIELDS: GameConfigFields = {
  roundSeconds: 60,
  houseCutBps: 600,
  ticketsPerUsdc: 10,
  bonusCapBps: 500,
  referralTiers: [
    { tier: 4, min: 11, max: null, rateBps: 500 },
    { tier: 3, min: 6, max: 10, rateBps: 400 },
    { tier: 2, min: 3, max: 5, rateBps: 300 },
    { tier: 1, min: 1, max: 2, rateBps: 200 },
  ],
  maxTilesPerBet: 36,
};

// The same literal apps/backend/src/api/game-config.test.ts pins.
const WIRE =
  'HexVault game-config POOLADDR 1700000000 {"roundSeconds":60,"houseCutBps":600,"ticketsPerUsdc":10,' +
  '"bonusCapBps":500,"referralTiers":[{"tier":4,"min":11,"max":null,"rateBps":500},' +
  '{"tier":3,"min":6,"max":10,"rateBps":400},{"tier":2,"min":3,"max":5,"rateBps":300},' +
  '{"tier":1,"min":1,"max":2,"rateBps":200}],"maxTilesPerBet":36}';

describe("gameConfigMessage", () => {
  it("matches the backend wire format byte for byte", () => {
    expect(gameConfigMessage("POOLADDR", 1700000000, FIELDS)).toBe(WIRE);
  });

  it("fixes the key order whatever order the object was built in", () => {
    const shuffled = Object.fromEntries(Object.entries(FIELDS).reverse()) as unknown as GameConfigFields;
    expect(gameConfigMessage("POOLADDR", 1700000000, shuffled)).toBe(WIRE);
  });
});

describe("parseForm", () => {
  it("reads back the values it was filled with", () => {
    const parsed = parseForm(formFromFields(FIELDS));
    expect(parsed).toEqual({ ok: true, fields: FIELDS });
  });

  it.each([
    ["roundSeconds", "59"],
    ["houseCutBps", "10001"],
    ["ticketsPerUsdc", "0"],
    ["bonusCapBps", "6.5"],
    ["maxTilesPerBet", "37"],
    ["maxTilesPerBet", ""],
  ] as const)("refuses %s = %j", (key, value) => {
    const parsed = parseForm({ ...formFromFields(FIELDS), [key]: value });
    expect(parsed.ok).toBe(false);
  });

  it("refuses tiers that are not a JSON list", () => {
    expect(parseForm({ ...formFromFields(FIELDS), referralTiers: "nope" }).ok).toBe(false);
    expect(parseForm({ ...formFromFields(FIELDS), referralTiers: "[]" }).ok).toBe(false);
  });
});

describe("submitGameConfig", () => {
  afterEach(() => vi.unstubAllGlobals());

  const args = (signMessage: (m: Uint8Array) => Promise<Uint8Array>) => ({
    baseUrl: "http://api.test",
    pool: "POOLADDR",
    wallet: "WALLET",
    fields: FIELDS,
    signMessage,
    encodeSignature: (bytes: Uint8Array) => `sig:${bytes.length}`,
    nowSeconds: 1700000000.9,
  });

  it("signs the canonical message, posts it and returns the stored row", async () => {
    const signed: string[] = [];
    const row = { id: 7, ...FIELDS, signer: "WALLET" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(row), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitGameConfig(
      args(async (m) => {
        signed.push(new TextDecoder().decode(m));
        return new Uint8Array(64);
      }),
    );

    expect(signed).toEqual([WIRE]);
    expect(result).toEqual({ ok: true, row });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/ops/game-config");
    expect(JSON.parse(init.body as string)).toEqual({
      wallet: "WALLET",
      time: 1700000000,
      signature: "sig:64",
      fields: FIELDS,
    });
  });

  it("shows the refusal copy to a wallet that is not listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "WalletNotListed", message: "no" }), { status: 403 }),
      ),
    );
    const result = await submitGameConfig(args(async () => new Uint8Array(64)));
    expect(result).toMatchObject({ ok: false, status: 403, code: "WalletNotListed" });
    if (result.ok) throw new Error("expected a refusal");
    expect(classifyGameConfigError(result.status, result.code, result.reason)).toBe(
      "This wallet is not on the list.",
    );
  });

  it("does not post when the wallet declines to sign", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitGameConfig(
      args(async () => {
        throw new Error("User rejected the request");
      }),
    );
    expect(result).toMatchObject({ ok: false, status: null, reason: "User rejected the request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("classifyGameConfigError", () => {
  it("maps each backend code and the 404", () => {
    expect(classifyGameConfigError(404, null, "")).toMatch(/cannot be changed/);
    expect(classifyGameConfigError(403, "RequestStale", "")).toMatch(/too old/);
    expect(classifyGameConfigError(403, "BadSignature", "")).toMatch(/did not match/);
    expect(classifyGameConfigError(409, "AlreadyApplied", "")).toMatch(/already applied/);
    expect(classifyGameConfigError(400, "FieldOutOfRange", "A field is out of range.")).toBe("A field is out of range.");
    expect(classifyGameConfigError(null, null, "")).toBe("Could not reach the server. Try again.");
  });
});
