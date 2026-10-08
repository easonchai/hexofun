// Off-chain tickets ticket 15: the delegation text, and the prompt rules of
// `ensureSession` / `revokeSession`, with a fake wallet, storage, clock and API.
import { utils as anchorUtils } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  delegationMessage,
  dropSession,
  ensureSession,
  httpSessionApi,
  loadSession,
  revokeMessage,
  revokeSession,
  LEDGER_COPY,
  REFRESH_BELOW_MS,
  SESSION_SECONDS,
  type SessionApi,
  type SessionDeps,
  type SessionSigner,
  type SignInInput,
} from "./session.js";

const bs58 = anchorUtils.bytes.bs58;
const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const ORIGIN = "https://hexvault.xyz";
const T0 = Date.parse("2026-10-08T12:00:00Z");
const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(1));
const KEY = Keypair.fromSeed(new Uint8Array(32).fill(2));

/** Ed25519 through WebCrypto, so the fake wallet's signatures are real and a
 *  test can verify them against the wallet's address. */
async function signWith(keypair: Keypair, message: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(keypair.secretKey.slice(0, 32), 16);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(message)));
}

async function verifyWith(address: Keypair, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(address.publicKey.toBytes()), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, new Uint8Array(signature), new Uint8Array(message));
}

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem = (key: string): string | null => this.map.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.map.set(key, value);
  removeItem = (key: string): void => void this.map.delete(key);
}

/** A recording backend: hands out sequential nonces, stores nothing. */
function fakeApi(over: Partial<SessionApi> = {}) {
  const calls = { nonce: 0, sessions: [] as { message: string; signature: string }[], revokes: [] as { id: string; time: number; signature: string }[] };
  const api: SessionApi = {
    fetchNonce: async () => ({ ok: true, nonce: `nonce${++calls.nonce}` }),
    postSession: async (message, signature) => {
      calls.sessions.push({ message, signature });
      return { ok: true, id: `session${calls.sessions.length}`, expiresAt: new Date(T0 + SESSION_SECONDS * 1000).toISOString() };
    },
    postRevoke: async (id, time, signature) => {
      calls.revokes.push({ id, time, signature });
      return { ok: true };
    },
    ...over,
  };
  return { api, calls };
}

/** A wallet that counts its prompts. */
function fakeWallet(over: Partial<SessionSigner> = {}) {
  const prompts = { signMessage: 0, signIn: 0 };
  const signer: SessionSigner = {
    wallet: WALLET.publicKey.toBase58(),
    signMessage: async (message) => {
      prompts.signMessage++;
      return signWith(WALLET, message);
    },
    signIn: undefined,
    ...over,
  };
  return { signer, prompts };
}

function setup(over: { now?: number; storage?: MemoryStorage; api?: Partial<SessionApi>; signer?: Partial<SessionSigner> } = {}) {
  const storage = over.storage ?? new MemoryStorage();
  const { api, calls } = fakeApi(over.api);
  const { signer, prompts } = fakeWallet(over.signer);
  const clock = { now: over.now ?? T0 };
  const deps: SessionDeps = {
    storage,
    now: () => clock.now,
    api,
    origin: ORIGIN,
    cluster: "mainnet-beta",
    programId: PROGRAM_ID,
    signer,
    generateKeypair: () => KEY,
  };
  return { deps, storage, calls, prompts, clock };
}

describe("delegationMessage", () => {
  it("is the text apps/backend/src/api/session.test.ts pins", () => {
    expect(
      delegationMessage({
        domain: "hexvault.xyz",
        wallet: WALLET.publicKey.toBase58(),
        uri: ORIGIN,
        chainId: "mainnet-beta",
        nonce: "5HueCGU8rMjxEXxiPuD5BDku",
        issuedAt: "2026-10-08T12:00:00Z",
        expirationTime: "2026-10-09T12:00:00Z",
        sessionPubkey: KEY.publicKey.toBase58(),
        programId: PROGRAM_ID,
      }),
    ).toBe(`hexvault.xyz wants you to sign in with your Solana account:
${WALLET.publicKey.toBase58()}

Authorize a HexVault betting session. This key can place bets in the game and cannot withdraw.

URI: https://hexvault.xyz
Version: 1
Chain ID: mainnet-beta
Nonce: 5HueCGU8rMjxEXxiPuD5BDku
Issued At: 2026-10-08T12:00:00Z
Expiration Time: 2026-10-09T12:00:00Z
Resources:
- hexvault:session:${KEY.publicKey.toBase58()}
- hexvault:program:${PROGRAM_ID}`);
  });
});

describe("ensureSession", () => {
  it("prompts a fresh wallet once and posts what it signed", async () => {
    const { deps, calls, prompts } = setup();
    const result = await ensureSession(deps);
    expect(result).toMatchObject({ ok: true, prompted: true });
    expect(prompts.signMessage).toBe(1);

    const [posted] = calls.sessions;
    expect(posted!.message).toContain(`Nonce: nonce1`);
    expect(posted!.message).toContain(`- hexvault:session:${KEY.publicKey.toBase58()}`);
    expect(posted!.message).toContain("Issued At: 2026-10-08T12:00:00Z");
    expect(posted!.message).toContain("Expiration Time: 2026-10-09T12:00:00Z");
    // The signature is the wallet's, over the raw UTF-8 bytes of the message.
    const bytes = new TextEncoder().encode(posted!.message);
    expect(await verifyWith(WALLET, bytes, bs58.decode(posted!.signature))).toBe(true);
  });

  it("does not prompt again on a reload within 24 hours", async () => {
    const first = setup();
    await ensureSession(first.deps);
    // A reload: new deps and a new wallet object, the same localStorage, an hour later.
    const second = setup({ storage: first.storage, now: T0 + 3_600_000 });
    const result = await ensureSession(second.deps);
    expect(result).toMatchObject({ ok: true, prompted: false });
    expect(second.prompts.signMessage).toBe(0);
    expect(second.calls.nonce).toBe(0);
    expect(second.calls.sessions).toHaveLength(0);
  });

  it("prompts when the live session has under five minutes left, not at five", async () => {
    const first = setup();
    await ensureSession(first.deps);
    const expiresAt = T0 + SESSION_SECONDS * 1000;

    const edge = setup({ storage: first.storage, now: expiresAt - REFRESH_BELOW_MS });
    expect((await ensureSession(edge.deps)).ok && edge.prompts.signMessage).toBe(0);

    const inside = setup({ storage: first.storage, now: expiresAt - REFRESH_BELOW_MS + 1000 });
    expect(await ensureSession(inside.deps)).toMatchObject({ ok: true, prompted: true });
    expect(inside.prompts.signMessage).toBe(1);
  });

  it("prompts after the session expired", async () => {
    const first = setup();
    await ensureSession(first.deps);
    const later = setup({ storage: first.storage, now: T0 + SESSION_SECONDS * 1000 + 1 });
    expect(await ensureSession(later.deps)).toMatchObject({ ok: true, prompted: true });
  });

  it("prompts again after dropSession, which a SessionInvalid refusal triggers", async () => {
    const first = setup();
    await ensureSession(first.deps);
    dropSession(first.deps, first.deps.signer.wallet);
    expect(await ensureSession(first.deps)).toMatchObject({ ok: true, prompted: true });
    expect(first.prompts.signMessage).toBe(2);
  });

  it("keeps a separate key per wallet", async () => {
    const first = setup();
    await ensureSession(first.deps);
    const other = Keypair.generate().publicKey.toBase58();
    expect(loadSession(first.deps, other)).toBeNull();
  });

  it("shows the Ledger copy and never prompts or calls the server", async () => {
    const { deps, calls, prompts } = setup({ signer: { signMessage: undefined, signIn: undefined } });
    expect(await ensureSession(deps)).toEqual({ ok: false, reason: "cannot_sign", message: LEDGER_COPY });
    expect(prompts).toEqual({ signMessage: 0, signIn: 0 });
    expect(calls.nonce).toBe(0);
  });

  it("stores nothing when the wallet refuses or the server refuses", async () => {
    const refused = setup({ signer: { signMessage: async () => { throw new Error("User rejected"); } } });
    expect(await ensureSession(refused.deps)).toMatchObject({ ok: false, reason: "rejected" });
    expect(refused.storage.map.size).toBe(0);

    const server = setup({ api: { postSession: async () => ({ ok: false, code: "NonceInvalid", message: "stale" }) } });
    expect(await ensureSession(server.deps)).toEqual({ ok: false, reason: "refused", message: "stale" });
    expect(server.storage.map.size).toBe(0);

    const down = setup({ api: { fetchNonce: async () => ({ ok: false, message: "offline" }) } });
    expect(await ensureSession(down.deps)).toEqual({ ok: false, reason: "network", message: "offline" });
    expect(down.prompts.signMessage).toBe(0);
  });

  it("prefers signIn, posts the text the wallet signed, and checks the account", async () => {
    let seen: SignInInput | undefined;
    const signIn = async (input: SignInInput) => {
      seen = input;
      const signedMessage = new TextEncoder().encode(
        delegationMessage({
          domain: input.domain,
          wallet: input.address,
          uri: input.uri,
          chainId: input.chainId,
          nonce: input.nonce,
          issuedAt: input.issuedAt,
          expirationTime: input.expirationTime,
          sessionPubkey: KEY.publicKey.toBase58(),
          programId: PROGRAM_ID,
        }),
      );
      return { address: input.address, signedMessage, signature: await signWith(WALLET, signedMessage) };
    };
    const { deps, calls, prompts } = setup({ signer: { signIn } });
    expect(await ensureSession(deps)).toMatchObject({ ok: true, prompted: true });
    expect(prompts.signMessage).toBe(0);
    expect(seen).toMatchObject({
      domain: "hexvault.xyz",
      uri: ORIGIN,
      version: "1",
      chainId: "mainnet-beta",
      resources: [`hexvault:session:${KEY.publicKey.toBase58()}`, `hexvault:program:${PROGRAM_ID}`],
    });
    expect(calls.sessions[0]!.message).toBe(
      delegationMessage({
        domain: "hexvault.xyz",
        wallet: WALLET.publicKey.toBase58(),
        uri: ORIGIN,
        chainId: "mainnet-beta",
        nonce: "nonce1",
        issuedAt: "2026-10-08T12:00:00Z",
        expirationTime: "2026-10-09T12:00:00Z",
        sessionPubkey: KEY.publicKey.toBase58(),
        programId: PROGRAM_ID,
      }),
    );

    const wrong = setup({ signer: { signIn: async (input) => ({ ...(await signIn(input)), address: "someone-else" }) } });
    expect(await ensureSession(wrong.deps)).toMatchObject({ ok: false, reason: "refused" });
    expect(wrong.calls.sessions).toHaveLength(0);
  });
});

describe("revokeSession", () => {
  it("sends the wallet's signature over the revoke text and clears the key", async () => {
    const { deps, calls, storage } = setup();
    await ensureSession(deps);
    expect(storage.map.size).toBe(1);

    expect(await revokeSession(deps)).toEqual({ ok: true, sent: true });
    const [revoke] = calls.revokes;
    expect(revoke).toMatchObject({ id: "session1", time: T0 / 1000 });
    const text = new TextEncoder().encode(revokeMessage(KEY.publicKey.toBase58(), T0 / 1000));
    expect(await verifyWith(WALLET, text, bs58.decode(revoke!.signature))).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it("makes the next ensure prompt again", async () => {
    const { deps, prompts } = setup();
    await ensureSession(deps);
    await revokeSession(deps);
    expect(await ensureSession(deps)).toMatchObject({ ok: true, prompted: true });
    expect(prompts.signMessage).toBe(3);
  });

  it("clears the key even when the server is down, and keeps it when the wallet refuses", async () => {
    const down = setup({ api: { postRevoke: async () => ({ ok: false, message: "offline" }) } });
    await ensureSession(down.deps);
    expect(await revokeSession(down.deps)).toEqual({ ok: true, sent: false });
    expect(down.storage.map.size).toBe(0);

    const kept = setup();
    await ensureSession(kept.deps);
    const refusing = { ...kept.deps, signer: { ...kept.deps.signer, signMessage: async () => { throw new Error("no"); } } };
    expect(await revokeSession(refusing)).toMatchObject({ ok: false, reason: "rejected" });
    expect(kept.storage.map.size).toBe(1);
  });
});

describe("httpSessionApi", () => {
  const reply = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("returns the server's refusal copy and code, and never throws", async () => {
    const refused = httpSessionApi("http://api", reply(409, { code: "NonceInvalid", message: "stale nonce" }));
    expect(await refused.postSession("m", "s")).toEqual({ ok: false, code: "NonceInvalid", message: "stale nonce" });

    const offline = httpSessionApi("http://api", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await offline.fetchNonce()).toMatchObject({ ok: false });
    expect(await offline.postRevoke("id", 1, "s")).toMatchObject({ ok: false });
  });

  it("reads the nonce and the created session", async () => {
    expect(await httpSessionApi("http://api", reply(200, { nonce: "abc" })).fetchNonce()).toEqual({ ok: true, nonce: "abc" });
    const created = httpSessionApi("http://api", reply(201, { id: "x", expiresAt: "2026-10-09T12:00:00.000Z" }));
    expect(await created.postSession("m", "s")).toEqual({ ok: true, id: "x", expiresAt: "2026-10-09T12:00:00.000Z" });
  });
});
