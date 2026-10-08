// Off-chain tickets ticket 18: the bet text, and the resend rules of `sendBet`
// with a recording API, real Ed25519 signatures and an in-memory storage.
import { utils as anchorUtils } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  BET_REFUSALS,
  betMessage,
  httpBetApi,
  loadSeq,
  sendBet,
  type BetApi,
  type BetDeps,
  type BetPostResult,
} from "./bet.js";

const bs58 = anchorUtils.bytes.bs58;
const SESSION = Keypair.fromSeed(new Uint8Array(32).fill(7));

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem = (key: string): string | null => this.map.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.map.set(key, value);
}

async function verifies(keypair: Keypair, message: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keypair.publicKey.toBytes()), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, new Uint8Array(signature), new TextEncoder().encode(message));
}

/** Answers from `script` in order, then accepts; keeps every text it was sent. */
function scriptedApi(script: BetPostResult[]) {
  const sent: { message: string; signature: string }[] = [];
  const api: BetApi = {
    postBet: async (message, signature) => {
      sent.push({ message, signature });
      return script.shift() ?? { ok: true, roundId: "9", opened: false, closeAt: "2026-10-08T12:02:00.000Z" };
    },
  };
  return { api, sent };
}

const refusal = (code: string, extra: { nextSeq?: number } = {}): BetPostResult => ({ ok: false, code, message: code, ...extra });

function deps(api: BetApi, storage = new MemoryStorage()): BetDeps & { storage: MemoryStorage } {
  return { api, storage, cluster: "devnet", programId: "PROG", pool: "POOL", session: { id: "s1", keypair: SESSION } };
}

const roundOf = (message: string): string => /^round: (\d+)$/m.exec(message)![1]!;
const seqOf = (message: string): string => /^seq: (\d+)$/m.exec(message)![1]!;

describe("betMessage", () => {
  it("matches the backend's pinned wire format", () => {
    // The same fixture apps/backend/src/api/bet.test.ts pins.
    expect(
      betMessage({ cluster: "devnet", program: "PROG", pool: "POOL", round: 4n, session: "SESS", seq: 2, tiles: [3, 7, 12], stake: 50n }),
    ).toBe(
      [
        "HexVault bet v1",
        "cluster: devnet",
        "program: PROG",
        "pool: POOL",
        "round: 4",
        "session: SESS",
        "seq: 2",
        "tiles: 3,7,12",
        "stake: 50",
      ].join("\n"),
    );
  });
});

describe("sendBet", () => {
  it("signs the sorted tiles with the session key and counts the seq up", async () => {
    const { api, sent } = scriptedApi([]);
    const d = deps(api);
    const first = await sendBet(d, { tiles: [12, 3, 7], stake: 50n, round: 4n });
    expect(first).toEqual({ ok: true, roundId: 9n, opened: false, closeAt: "2026-10-08T12:02:00.000Z" });
    const message = sent[0]!.message;
    expect(message).toContain("tiles: 3,7,12");
    expect(message).toContain("stake: 50");
    expect(message).toContain(`session: ${SESSION.publicKey.toBase58()}`);
    expect(await verifies(SESSION, message, bs58.decode(sent[0]!.signature))).toBe(true);

    await sendBet(d, { tiles: [1], stake: 1n, round: 4n });
    expect([seqOf(sent[0]!.message), seqOf(sent[1]!.message)]).toEqual(["0", "1"]);
    expect(loadSeq(d.storage, "s1")).toBe(2);
  });

  it("resends into the open Round on RoundAlreadyOpen, once and only once", async () => {
    const { api, sent } = scriptedApi([refusal("RoundAlreadyOpen")]);
    const ok = await sendBet(deps(api), { tiles: [1], stake: 1n, round: 5n });
    expect(ok.ok).toBe(true);
    expect(sent.map((s) => roundOf(s.message))).toEqual(["5", "4"]);

    const twice = scriptedApi([refusal("RoundAlreadyOpen"), refusal("RoundAlreadyOpen")]);
    const refused = await sendBet(deps(twice.api), { tiles: [1], stake: 1n, round: 5n });
    expect(refused).toMatchObject({ ok: false, code: "RoundAlreadyOpen" });
    expect(twice.sent.map((s) => roundOf(s.message))).toEqual(["5", "4"]);
  });

  it("does not resend any other refusal", async () => {
    for (const code of BET_REFUSALS.filter((c) => c !== "RoundAlreadyOpen" && c !== "SeqMismatch")) {
      const { api, sent } = scriptedApi([refusal(code)]);
      expect(await sendBet(deps(api), { tiles: [1], stake: 1n, round: 5n })).toMatchObject({ ok: false, code });
      expect(sent).toHaveLength(1);
    }
  });

  it("does not bump the seq for a refused bet", async () => {
    const { api } = scriptedApi([refusal("PositionExists")]);
    const d = deps(api);
    await sendBet(d, { tiles: [1], stake: 1n, round: 5n });
    expect(loadSeq(d.storage, "s1")).toBe(0);
  });

  it("adopts the server's count on SeqMismatch and tries once more", async () => {
    const { api, sent } = scriptedApi([refusal("SeqMismatch", { nextSeq: 6 })]);
    const d = deps(api);
    expect((await sendBet(d, { tiles: [1], stake: 1n, round: 5n })).ok).toBe(true);
    expect(sent.map((s) => seqOf(s.message))).toEqual(["0", "6"]);
    expect(loadSeq(d.storage, "s1")).toBe(7);

    const stuck = scriptedApi([refusal("SeqMismatch", { nextSeq: 6 }), refusal("SeqMismatch", { nextSeq: 7 })]);
    expect(await sendBet(deps(stuck.api), { tiles: [1], stake: 1n, round: 5n })).toMatchObject({ ok: false, code: "SeqMismatch" });
    expect(stuck.sent).toHaveLength(2);
  });

  it("returns a SeqMismatch without a count as it came", async () => {
    const { api, sent } = scriptedApi([refusal("SeqMismatch")]);
    expect(await sendBet(deps(api), { tiles: [1], stake: 1n, round: 5n })).toMatchObject({ ok: false, code: "SeqMismatch" });
    expect(sent).toHaveLength(1);
  });

  it("never resends into Round 0", async () => {
    const { api, sent } = scriptedApi([refusal("RoundAlreadyOpen")]);
    await sendBet(deps(api), { tiles: [1], stake: 1n, round: 1n });
    expect(sent).toHaveLength(1);
  });
});

describe("httpBetApi", () => {
  const reply = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  it("maps an accepted bet", async () => {
    const api = httpBetApi("http://x", reply(201, { roundId: "3", positionId: "1", opened: true, closeAt: "2026-10-08T12:02:00.000Z" }));
    expect(await api.postBet("m", "s")).toEqual({ ok: true, roundId: "3", opened: true, closeAt: "2026-10-08T12:02:00.000Z" });
  });

  it("carries the refusal code, message and seq hint", async () => {
    const api = httpBetApi("http://x", reply(409, { code: "SeqMismatch", message: "out of order", nextSeq: 4 }));
    expect(await api.postBet("m", "s")).toEqual({ ok: false, code: "SeqMismatch", message: "out of order", nextSeq: 4 });
  });

  it("names a throttled and an unreachable server", async () => {
    expect(await httpBetApi("http://x", reply(429, { message: "ThrottlerException" })).postBet("m", "s")).toMatchObject({ code: "Throttled" });
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await httpBetApi("http://x", down).postBet("m", "s")).toMatchObject({ ok: false, code: "network" });
  });
});
