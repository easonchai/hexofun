// Pure checks for the session delegation and revoke verifiers (off-chain-tickets
// ticket 15). No database: the nonce store is a Set.
import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  delegationMessage,
  revokeMessage,
  verifyDelegation,
  verifyRevoke,
  type DelegationContext,
  type DelegationFields,
} from "./session";

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const ORIGIN = "https://hexvault.xyz";
const NOW = new Date("2026-10-08T12:00:00Z");

/** Fixed seeds, so the message below is the same text apps/web/src/session.test.ts
 *  pins. These sign in software; a real Phantom signature is the open device
 *  check in ticket 15. */
const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(1));
const SESSION = Keypair.fromSeed(new Uint8Array(32).fill(2));
const NONCE = "5HueCGU8rMjxEXxiPuD5BDku";

function sign(keypair: Keypair, message: string): Uint8Array {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), key));
}

const fields = (over: Partial<DelegationFields> = {}): DelegationFields => ({
  domain: "hexvault.xyz",
  wallet: WALLET.publicKey.toBase58(),
  uri: ORIGIN,
  chainId: "mainnet-beta",
  nonce: NONCE,
  issuedAt: "2026-10-08T12:00:00Z",
  expirationTime: "2026-10-09T12:00:00Z",
  sessionPubkey: SESSION.publicKey.toBase58(),
  programId: PROGRAM_ID,
  ...over,
});

/** A context whose nonce store accepts each nonce in `live` once. */
function context(live: string[] = [NONCE], over: Partial<DelegationContext> = {}): DelegationContext {
  const store = new Set(live);
  return {
    now: NOW,
    allowedOrigins: [ORIGIN],
    chainId: "mainnet-beta",
    programId: PROGRAM_ID,
    consumeNonce: async (nonce) => store.delete(nonce),
    ...over,
  };
}

const signed = (message: string, signer: Keypair = WALLET) => ({
  message,
  signature: sign(signer, message),
});

describe("delegationMessage", () => {
  it("is research 02's text, byte for byte", () => {
    expect(delegationMessage(fields())).toBe(`hexvault.xyz wants you to sign in with your Solana account:
${WALLET.publicKey.toBase58()}

Authorize a HexVault betting session. This key can place bets in the game and cannot withdraw.

URI: https://hexvault.xyz
Version: 1
Chain ID: mainnet-beta
Nonce: ${NONCE}
Issued At: 2026-10-08T12:00:00Z
Expiration Time: 2026-10-09T12:00:00Z
Resources:
- hexvault:session:${SESSION.publicKey.toBase58()}
- hexvault:program:${PROGRAM_ID}`);
  });
});

describe("verifyDelegation", () => {
  it("accepts a wallet's raw-bytes signature and returns the delegation", async () => {
    const result = await verifyDelegation(signed(delegationMessage(fields())), context());
    expect(result).toEqual({
      ok: true,
      delegation: {
        wallet: WALLET.publicKey.toBase58(),
        sessionPubkey: SESSION.publicKey.toBase58(),
        nonce: NONCE,
        issuedAt: new Date("2026-10-08T12:00:00Z"),
        expiresAt: new Date("2026-10-09T12:00:00Z"),
      },
    });
  });

  it("refuses a signature by a wallet the message does not name", async () => {
    const other = Keypair.generate();
    const result = await verifyDelegation(signed(delegationMessage(fields()), other), context());
    expect(result).toEqual({ ok: false, code: "BadSignature" });
  });

  it("refuses a reused nonce", async () => {
    const ctx = context();
    const request = signed(delegationMessage(fields()));
    expect((await verifyDelegation(request, ctx)).ok).toBe(true);
    expect(await verifyDelegation(request, ctx)).toEqual({ ok: false, code: "NonceInvalid" });
  });

  it("refuses an expiry more than 24 hours out", async () => {
    const message = delegationMessage(fields({ expirationTime: "2026-10-09T13:00:00Z" }));
    expect(await verifyDelegation(signed(message), context())).toEqual({
      ok: false,
      code: "ExpiryTooLong",
    });
  });

  it("refuses a session pubkey swapped after signing", async () => {
    const request = signed(delegationMessage(fields()));
    const swapped = delegationMessage(fields({ sessionPubkey: Keypair.generate().publicKey.toBase58() }));
    expect(await verifyDelegation({ ...request, message: swapped }, context())).toEqual({
      ok: false,
      code: "BadSignature",
    });
  });

  it("leaves the nonce alone when another check fails", async () => {
    const ctx = context();
    const other = Keypair.generate();
    await verifyDelegation(signed(delegationMessage(fields()), other), ctx);
    expect((await verifyDelegation(signed(delegationMessage(fields())), ctx)).ok).toBe(true);
  });

  it("refuses a message built for another origin, cluster, program or wording", async () => {
    const cases: Partial<DelegationFields>[] = [
      { uri: "https://evil.example", domain: "evil.example" },
      { domain: "evil.example" },
      { chainId: "devnet" },
      { programId: Keypair.generate().publicKey.toBase58() },
    ];
    for (const over of cases) {
      const result = await verifyDelegation(signed(delegationMessage(fields(over))), context());
      expect(result, JSON.stringify(over)).toEqual({ ok: false, code: "BadMessage" });
    }
    const reworded = delegationMessage(fields()).replace("cannot withdraw", "can withdraw");
    expect(await verifyDelegation(signed(reworded), context())).toEqual({ ok: false, code: "BadMessage" });
    expect(await verifyDelegation(signed("hello"), context())).toEqual({ ok: false, code: "BadMessage" });
  });

  it("refuses an Issued At far from the server clock, and an expired session", async () => {
    const late = delegationMessage(
      fields({ issuedAt: "2026-10-08T11:40:00Z", expirationTime: "2026-10-09T11:40:00Z" }),
    );
    expect(await verifyDelegation(signed(late), context())).toEqual({
      ok: false,
      code: "IssuedAtOutOfRange",
    });
    const stale = delegationMessage(
      fields({ issuedAt: "2026-10-08T11:55:00Z", expirationTime: "2026-10-08T11:58:00Z" }),
    );
    expect(await verifyDelegation(signed(stale), context())).toEqual({
      ok: false,
      code: "AlreadyExpired",
    });
  });

  it("tolerates a client clock a few minutes fast", async () => {
    const fast = delegationMessage(
      fields({ issuedAt: "2026-10-08T12:04:00Z", expirationTime: "2026-10-09T12:04:00Z" }),
    );
    expect((await verifyDelegation(signed(fast), context())).ok).toBe(true);
  });
});

describe("verifyRevoke", () => {
  const session = {
    wallet: WALLET.publicKey.toBase58(),
    sessionPubkey: SESSION.publicKey.toBase58(),
  };
  const time = Math.floor(NOW.getTime() / 1000);
  const message = revokeMessage(session.sessionPubkey, time);

  it("builds the ticket's text", () => {
    expect(message).toBe(`HexVault revoke session ${session.sessionPubkey} ${time}`);
  });

  it("accepts the delegating wallet's signature", () => {
    expect(verifyRevoke(session, { time, signature: sign(WALLET, message) }, NOW)).toEqual({ ok: true });
  });

  it("refuses another wallet's signature", () => {
    const signature = sign(Keypair.generate(), message);
    expect(verifyRevoke(session, { time, signature }, NOW)).toEqual({ ok: false, code: "BadSignature" });
  });

  it("refuses a signature over another session's key or another time", () => {
    const otherKey = revokeMessage(Keypair.generate().publicKey.toBase58(), time);
    expect(verifyRevoke(session, { time, signature: sign(WALLET, otherKey) }, NOW)).toEqual({
      ok: false,
      code: "BadSignature",
    });
    expect(verifyRevoke(session, { time: time + 1, signature: sign(WALLET, message) }, NOW)).toEqual({
      ok: false,
      code: "BadSignature",
    });
  });

  it("refuses a request far from the server clock", () => {
    const old = time - 3600;
    const signature = sign(WALLET, revokeMessage(session.sessionPubkey, old));
    expect(verifyRevoke(session, { time: old, signature }, NOW)).toEqual({ ok: false, code: "StaleRevoke" });
  });
});
