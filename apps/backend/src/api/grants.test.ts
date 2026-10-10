// off-chain-tickets ticket 23, the pure half: the message and the verdict for a
// signed manual grant. No Nest, no database.
import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { GRANT_REASON_MAX, grantMessage, verifyGrant } from "./grants";

const TEAM = Keypair.generate();
const STRANGER = Keypair.generate();
const POOL = Keypair.generate().publicKey.toBase58();
const TARGET = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000;
const allowed = new Set([TEAM.publicKey.toBase58()]);

function signWith(keypair: Keypair, message: string): Uint8Array {
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), key));
}

function attempt(
  over: { keypair?: Keypair; time?: number; amount?: unknown; reason?: unknown; signed?: string; maxAmount?: number } = {},
) {
  const keypair = over.keypair ?? TEAM;
  const time = over.time ?? NOW;
  const amount = "amount" in over ? over.amount : 500;
  const reason = "reason" in over ? over.reason : "launch bonus";
  const message = over.signed ?? grantMessage(POOL, TARGET, BigInt(typeof amount === "number" ? Math.trunc(amount) : 0), String(reason), time);
  return verifyGrant({
    allowed,
    signer: keypair.publicKey,
    pool: POOL,
    wallet: TARGET,
    amount,
    reason,
    time,
    signature: signWith(keypair, message),
    nowSeconds: NOW,
    maxAmount: over.maxAmount ?? 10_000,
  });
}

describe("grantMessage", () => {
  it("pins the wire format the web and CLI builders must match", () => {
    expect(grantMessage("POOLADDR", "WALLET", 500n, "launch bonus", 1700000000)).toBe(
      "HexVault grant POOLADDR WALLET 500 launch bonus 1700000000",
    );
  });
});

describe("verifyGrant", () => {
  it("accepts a listed wallet's signed grant and returns the canonical message", () => {
    expect(attempt()).toEqual({
      ok: true,
      amount: 500n,
      reason: "launch bonus",
      message: grantMessage(POOL, TARGET, 500n, "launch bonus", NOW),
    });
  });

  it("accepts a time 120 seconds off either way and refuses 121", () => {
    expect(attempt({ time: NOW - 120 }).ok).toBe(true);
    expect(attempt({ time: NOW + 120 }).ok).toBe(true);
    expect(attempt({ time: NOW - 121 })).toEqual({ ok: false, code: "RequestStale" });
    expect(attempt({ time: NOW + 121 })).toEqual({ ok: false, code: "RequestStale" });
  });

  it("refuses a wallet off the list", () => {
    expect(attempt({ keypair: STRANGER })).toEqual({ ok: false, code: "WalletNotListed" });
  });

  it("refuses a signature over another amount, reason or pool", () => {
    const bad = { ok: false, code: "BadSignature" };
    expect(attempt({ signed: grantMessage(POOL, TARGET, 501n, "launch bonus", NOW) })).toEqual(bad);
    expect(attempt({ signed: grantMessage(POOL, TARGET, 500n, "other", NOW) })).toEqual(bad);
    expect(attempt({ signed: grantMessage(Keypair.generate().publicKey.toBase58(), TARGET, 500n, "launch bonus", NOW) })).toEqual(bad);
  });

  it.each<[string, unknown]>([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 1.5],
    ["a string", "500"],
    ["past 2^53", 2 ** 53],
    ["missing", undefined],
  ])("refuses an amount that is %s", (_name, amount) => {
    expect(attempt({ amount })).toEqual({ ok: false, code: "AmountOutOfRange" });
  });

  it("takes an amount at the Game config's cap and refuses one above it, before the signature check", () => {
    expect(attempt({ amount: 10_000 }).ok).toBe(true);
    expect(attempt({ amount: 10_001 })).toEqual({ ok: false, code: "AmountOutOfRange" });
    expect(attempt({ amount: 10_001, signed: "not what was sent" })).toEqual({ ok: false, code: "AmountOutOfRange" });
    expect(attempt({ amount: 20_000, maxAmount: 20_000 }).ok).toBe(true);
  });

  it("takes a reason of exactly 200 characters and refuses 201, blank or non-text", () => {
    expect(attempt({ reason: "x".repeat(GRANT_REASON_MAX) }).ok).toBe(true);
    expect(attempt({ reason: "x".repeat(GRANT_REASON_MAX + 1) })).toEqual({ ok: false, code: "ReasonInvalid" });
    expect(attempt({ reason: "   " })).toEqual({ ok: false, code: "ReasonInvalid" });
    expect(attempt({ reason: 7 })).toEqual({ ok: false, code: "ReasonInvalid" });
  });
});
