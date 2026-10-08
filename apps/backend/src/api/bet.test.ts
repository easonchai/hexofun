// off-chain-tickets ticket 16, the pure half: the bet text, the spec's check
// order and the Round's close time. No Nest, no database.
import { createHash, createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  betListHash,
  betMessage,
  checkBet,
  closeAtFor,
  parseBetMessage,
  seedCommitment,
  tileMask,
  type BetFacts,
  type BetFields,
  type BetRefusal,
} from "./bet";

const SESSION = Keypair.generate();
const OTHER = Keypair.generate();
const WALLET = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const PROGRAM = Keypair.generate().publicKey.toBase58();
// 12:00:00 UTC, on the minute.
const NOON = new Date("2026-10-08T12:00:00.000Z");

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

const fields: BetFields = {
  cluster: "devnet",
  program: PROGRAM,
  pool: POOL,
  round: 4n,
  session: SESSION.publicKey.toBase58(),
  seq: 2,
  tiles: [3, 7, 12],
  stake: 50n,
};

/** Facts under which `fields` passes: Round 4 is open, two minutes of the epoch left. */
const facts: BetFacts = {
  now: new Date(NOON.getTime() + 10_000),
  cluster: "devnet",
  program: PROGRAM,
  pool: POOL,
  session: { wallet: WALLET, nextSeq: 2 },
  openRound: { id: 4n, closeAt: new Date(NOON.getTime() + 60_000) },
  nextRoundId: 5n,
  epochEndsAt: BigInt(NOON.getTime() / 1000 + 3600),
  roundSeconds: 60,
  maxTilesPerBet: 36,
  paused: false,
  tickets: 1_000n,
  hasPosition: false,
};

/** A bet text for `over`, signed by `signer`, checked against `factsOver`. */
function attempt(over: Partial<BetFields> = {}, factsOver: Partial<BetFacts> = {}, signer = SESSION) {
  const message = betMessage({ ...fields, ...over });
  return checkBet({ message, signature: signWith(signer, message) }, { ...facts, ...factsOver });
}

const code = (verdict: ReturnType<typeof attempt>): BetRefusal | "ok" => (verdict.ok ? "ok" : verdict.code);

describe("betMessage", () => {
  it("pins the wire format the web helper must match", () => {
    expect(betMessage({ ...fields, program: "PROG", pool: "POOL", session: "SESS" })).toBe(
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

  it("round-trips through parseBetMessage", () => {
    expect(parseBetMessage(betMessage(fields))).toEqual(fields);
  });

  it.each([
    ["a leading zero", (m: string) => m.replace("round: 4", "round: 04")],
    ["a space in the tile list", (m: string) => m.replace("3,7,12", "3, 7,12")],
    ["a trailing newline", (m: string) => `${m}\n`],
    ["another prefix line", (m: string) => m.replace("HexVault bet v1", "HexVault bet v2")],
    ["a swapped line order", (m: string) => m.replace("round: 4\nsession", "session").replace(/\n/, "\nround: 4\n")],
    ["a negative stake", (m: string) => m.replace("stake: 50", "stake: -50")],
  ])("refuses %s", (_name, tamper) => {
    expect(parseBetMessage(tamper(betMessage(fields)))).toBeNull();
  });
});

describe("checkBet", () => {
  it("passes a good bet into the open Round and returns the tile mask", () => {
    expect(attempt()).toEqual({
      ok: true,
      bet: fields,
      wallet: WALLET,
      mask: (1n << 3n) | (1n << 7n) | (1n << 12n),
      opens: null,
    });
  });

  it("passes the first bet of a new Round and says when it closes", () => {
    const verdict = attempt({ round: 5n }, { openRound: null });
    // Opened 10 seconds past the minute, so the first minute mark with a full minute of betting is 12:02.
    expect(verdict.ok && verdict.opens).toEqual({ closeAt: new Date("2026-10-08T12:02:00.000Z") });
  });

  describe("refusals", () => {
    it("SessionInvalid for a key with no live session, even when the signature is also bad", () => {
      expect(code(attempt({}, { session: null }, OTHER))).toBe("SessionInvalid");
    });

    it("BadSignature for text that is not a bet, a wrong key's signature, or another game's text", () => {
      expect(code(checkBet({ message: "hello", signature: new Uint8Array(64) }, facts))).toBe("BadSignature");
      expect(code(attempt({}, {}, OTHER))).toBe("BadSignature");
      expect(code(attempt({ cluster: "mainnet-beta" }))).toBe("BadSignature");
      expect(code(attempt({ program: OTHER.publicKey.toBase58() }))).toBe("BadSignature");
      expect(code(attempt({ pool: OTHER.publicKey.toBase58() }))).toBe("BadSignature");
    });

    it("BadSignature when the text changed after signing", () => {
      const message = betMessage(fields);
      const signature = signWith(SESSION, message);
      expect(code(checkBet({ message: message.replace("stake: 50", "stake: 51"), signature }, facts))).toBe(
        "BadSignature",
      );
    });

    it("SeqMismatch for a replayed or skipped seq", () => {
      expect(code(attempt({ seq: 1 }))).toBe("SeqMismatch");
      expect(code(attempt({ seq: 3 }))).toBe("SeqMismatch");
    });

    it("RoundClosed for a Round that is not the open one, and for a bet past closeAt", () => {
      expect(code(attempt({ round: 3n }))).toBe("RoundClosed");
      expect(code(attempt({ round: 9n }))).toBe("RoundClosed");
      expect(code(attempt({ round: 5n }, { openRound: null, nextRoundId: 5n }))).toBe("ok");
      expect(code(attempt({}, { now: new Date(NOON.getTime() + 60_001) }))).toBe("RoundClosed");
      expect(code(attempt({}, { now: new Date(NOON.getTime() + 60_000) }))).toBe("ok");
    });

    it("RoundAlreadyOpen for the next id while a Round is open", () => {
      expect(code(attempt({ round: 5n }))).toBe("RoundAlreadyOpen");
    });

    it("RoundOutsideEpoch when the new Round would close after the epoch ends", () => {
      const closed = { openRound: null, nextRoundId: 5n };
      // Epoch ends 1 second after the Round that opens now would close.
      const endsAt = (closeAt: Date, slackSeconds: number) => BigInt(closeAt.getTime() / 1000 + slackSeconds);
      const closeAt = closeAtFor(facts.now, 60);
      expect(code(attempt({ round: 5n }, { ...closed, epochEndsAt: endsAt(closeAt, -1) }))).toBe("RoundOutsideEpoch");
      expect(code(attempt({ round: 5n }, { ...closed, epochEndsAt: endsAt(closeAt, 0) }))).toBe("ok");
      expect(code(attempt({ round: 5n }, { ...closed, epochEndsAt: null }))).toBe("RoundOutsideEpoch");
    });

    it("GamePaused when any switch is on", () => {
      expect(code(attempt({}, { paused: true }))).toBe("GamePaused");
    });

    it.each([
      ["no tiles", { tiles: [] }],
      ["a tile past 35", { tiles: [3, 36] }],
      ["a repeated tile", { tiles: [3, 3] }],
      ["tiles out of order", { tiles: [7, 3] }],
      ["a zero stake", { stake: 0n }],
    ])("BadTiles for %s", (_name, over) => {
      expect(code(attempt(over))).toBe("BadTiles");
    });

    it("BadTiles past maxTilesPerBet", () => {
      expect(code(attempt({}, { maxTilesPerBet: 2 }))).toBe("BadTiles");
      expect(code(attempt({}, { maxTilesPerBet: 3 }))).toBe("ok");
    });

    it("InsufficientTickets when tiles times stake exceeds the balance", () => {
      expect(code(attempt({}, { tickets: 149n }))).toBe("InsufficientTickets");
      expect(code(attempt({}, { tickets: 150n }))).toBe("ok");
    });

    it("PositionExists for a wallet already in the Round", () => {
      expect(code(attempt({}, { hasPosition: true }))).toBe("PositionExists");
    });
  });

  it("reports the first failing check in the spec's order", () => {
    // Everything wrong at once: each fix reveals the next code down the list.
    const everything = (over: Partial<BetFacts>) =>
      attempt({ seq: 9, round: 5n, tiles: [] }, { paused: true, tickets: 0n, hasPosition: true, ...over });
    expect(code(everything({ session: null }))).toBe("SessionInvalid");
    expect(code(everything({}))).toBe("SeqMismatch");
    const seqFixed = (over: Partial<BetFacts>) =>
      attempt({ round: 5n, tiles: [] }, { paused: true, tickets: 0n, hasPosition: true, ...over });
    expect(code(seqFixed({}))).toBe("RoundAlreadyOpen");
    expect(code(seqFixed({ openRound: null, epochEndsAt: 1n }))).toBe("RoundOutsideEpoch");
    expect(code(seqFixed({ openRound: null }))).toBe("GamePaused");
    const live = (over: Partial<BetFacts>) => attempt({ tiles: [] }, { tickets: 0n, hasPosition: true, ...over });
    expect(code(live({}))).toBe("BadTiles");
    expect(code(attempt({}, { tickets: 0n, hasPosition: true }))).toBe("InsufficientTickets");
    expect(code(attempt({}, { hasPosition: true }))).toBe("PositionExists");
  });
});

describe("closeAtFor", () => {
  it("is a full round after an open on the minute", () => {
    expect(closeAtFor(NOON, 60)).toEqual(new Date("2026-10-08T12:01:00.000Z"));
  });

  it("skips to the minute after when the open is one second past the minute", () => {
    expect(closeAtFor(new Date(NOON.getTime() + 1000), 60)).toEqual(new Date("2026-10-08T12:02:00.000Z"));
  });

  it("gives at least roundSeconds of betting for any open time", () => {
    for (let offsetMs = 0; offsetMs < 120_000; offsetMs += 997) {
      const openAt = new Date(NOON.getTime() + offsetMs);
      const closeAt = closeAtFor(openAt, 60);
      expect(closeAt.getTime() - openAt.getTime()).toBeGreaterThanOrEqual(60_000);
      expect(closeAt.getTime() % 60_000).toBe(0);
    }
  });

  it("follows roundSeconds, not the minute", () => {
    expect(closeAtFor(NOON, 90)).toEqual(new Date(Math.ceil((NOON.getTime() + 90_000) / 90_000) * 90_000));
  });
});

describe("hashes and masks", () => {
  it("betListHash is sha256 over the signatures concatenated in order", () => {
    const a = new Uint8Array(64).fill(1);
    const b = new Uint8Array(64).fill(2);
    const expected = createHash("sha256").update(Buffer.concat([a, b])).digest("hex");
    expect(betListHash([a, b])).toBe(expected);
    expect(betListHash([b, a])).not.toBe(expected);
    expect(betListHash([])).toBe(createHash("sha256").digest("hex"));
  });

  it("seedCommitment is the hex sha256 of the seed", () => {
    const seed = new Uint8Array(32).fill(7);
    expect(seedCommitment(seed)).toBe(createHash("sha256").update(seed).digest("hex"));
  });

  it("tileMask sets bit n for tile n, up to tile 35", () => {
    expect(tileMask([0, 35])).toBe(1n + (1n << 35n));
  });
});
