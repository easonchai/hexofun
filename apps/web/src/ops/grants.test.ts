import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyGrantError, grantMessage, parseGrantForm, submitGrant } from "./grants.js";

const WALLET = "11111111111111111111111111111112";

describe("grantMessage", () => {
  it("matches the backend wire format byte for byte", () => {
    // The same literal apps/backend/src/api/grants.test.ts pins.
    expect(grantMessage("POOLADDR", "WALLET", 500, "launch bonus", 1700000000)).toBe(
      "HexVault grant POOLADDR WALLET 500 launch bonus 1700000000",
    );
  });
});

describe("parseGrantForm", () => {
  const ok = { wallet: WALLET, amount: "500", reason: "launch bonus" };

  it("reads the values back", () => {
    expect(parseGrantForm(ok)).toEqual({ ok: true, wallet: WALLET, amount: 500, reason: "launch bonus" });
  });

  it.each([
    ["a short wallet", { wallet: "abc" }],
    ["zero", { amount: "0" }],
    ["a negative amount", { amount: "-5" }],
    ["a fractional amount", { amount: "1.5" }],
    ["a blank reason", { reason: "  " }],
    ["a reason over 200", { reason: "x".repeat(201) }],
  ])("refuses %s", (_name, over) => {
    expect(parseGrantForm({ ...ok, ...over }).ok).toBe(false);
  });
});

describe("submitGrant", () => {
  afterEach(() => vi.unstubAllGlobals());

  const args = (signMessage: (m: Uint8Array) => Promise<Uint8Array>) => ({
    baseUrl: "http://api.test",
    pool: "POOLADDR",
    signer: "TEAM",
    wallet: "WALLET",
    amount: 500,
    reason: "launch bonus",
    signMessage,
    encodeSignature: (bytes: Uint8Array) => `sig:${bytes.length}`,
    nowSeconds: 1700000000.9,
  });

  it("signs the canonical message, posts it and returns the stored row", async () => {
    const signed: string[] = [];
    const row = { id: "9", owner: "WALLET", delta: "500", ref: "launch bonus", signer: "TEAM" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(row), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitGrant(
      args(async (m) => {
        signed.push(new TextDecoder().decode(m));
        return new Uint8Array(64);
      }),
    );

    expect(signed).toEqual(["HexVault grant POOLADDR WALLET 500 launch bonus 1700000000"]);
    expect(result).toEqual({ ok: true, row });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/ops/grants");
    expect(JSON.parse(init.body as string)).toEqual({
      wallet: "WALLET",
      amount: 500,
      reason: "launch bonus",
      signer: "TEAM",
      time: 1700000000,
      signature: "sig:64",
    });
  });

  it("returns the backend's named refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "WalletNotListed", message: "no" }), { status: 403 })),
    );
    const result = await submitGrant(args(async () => new Uint8Array(64)));
    expect(result).toMatchObject({ ok: false, status: 403, code: "WalletNotListed" });
  });

  it("does not post when the wallet declines to sign", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitGrant(
      args(async () => {
        throw new Error("User rejected the request");
      }),
    );
    expect(result).toMatchObject({ ok: false, status: null, reason: "User rejected the request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("classifyGrantError", () => {
  it("maps each backend code and the 404", () => {
    expect(classifyGrantError(404, null, "")).toMatch(/not enabled/);
    expect(classifyGrantError(403, "WalletNotListed", "")).toBe("This wallet is not on the list.");
    expect(classifyGrantError(403, "RequestStale", "")).toMatch(/too old/);
    expect(classifyGrantError(403, "BadSignature", "")).toMatch(/did not match/);
    expect(classifyGrantError(409, "AlreadyApplied", "")).toMatch(/already applied/);
    expect(classifyGrantError(400, "AmountOutOfRange", "Bad amount.")).toBe("Bad amount.");
    expect(classifyGrantError(null, null, "")).toBe("Could not reach the server. Try again.");
  });
});
