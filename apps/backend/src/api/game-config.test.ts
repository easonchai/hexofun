// off-chain-tickets ticket 14, the pure half: message builder, field ranges and
// the verdict for a signed change. No Nest, no database.
import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_CONFIG,
  gameConfigMessage,
  parseGameConfigFields,
  verifyGameConfigChange,
  type GameConfigFields,
} from "./game-config";
import { fastPauseMessage } from "./invite-code";

const TEAM = Keypair.generate();
const STRANGER = Keypair.generate();
const POOL = Keypair.generate().publicKey.toBase58();
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

const fields: GameConfigFields = { ...DEFAULT_GAME_CONFIG, roundSeconds: 90, houseCutBps: 700 };

function attempt(over: {
  keypair?: Keypair;
  time?: number;
  fields?: unknown;
  signedFields?: GameConfigFields;
  signedPool?: string;
} = {}) {
  const keypair = over.keypair ?? TEAM;
  const time = over.time ?? NOW;
  const message = gameConfigMessage(over.signedPool ?? POOL, time, over.signedFields ?? fields);
  return verifyGameConfigChange({
    allowed,
    wallet: keypair.publicKey,
    pool: POOL,
    time,
    fields: "fields" in over ? over.fields : fields,
    signature: signWith(keypair, message),
    nowSeconds: NOW,
  });
}

describe("gameConfigMessage", () => {
  it("pins the wire format the web helper must match", () => {
    expect(gameConfigMessage("POOLADDR", 1700000000, DEFAULT_GAME_CONFIG)).toBe(
      'HexVault game-config POOLADDR 1700000000 {"roundSeconds":60,"houseCutBps":600,"ticketsPerUsdc":10,' +
        '"bonusCapBps":500,"referralTiers":[{"tier":4,"min":11,"max":null,"rateBps":500},' +
        '{"tier":3,"min":6,"max":10,"rateBps":400},{"tier":2,"min":3,"max":5,"rateBps":300},' +
        '{"tier":1,"min":1,"max":2,"rateBps":200}],"maxTilesPerBet":36}',
    );
    expect(gameConfigMessage("P", 1, fields)).not.toBe(fastPauseMessage("game", "P", 1));
  });
});

describe("verifyGameConfigChange", () => {
  it("accepts a signed change from a listed wallet and returns the canonical message", () => {
    const verdict = attempt();
    expect(verdict).toEqual({ ok: true, fields, message: gameConfigMessage(POOL, NOW, fields) });
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

  it("refuses a signature over other fields or another pool", () => {
    expect(attempt({ signedFields: { ...fields, houseCutBps: 1 } })).toEqual({
      ok: false,
      code: "BadSignature",
    });
    expect(attempt({ signedPool: Keypair.generate().publicKey.toBase58() })).toEqual({
      ok: false,
      code: "BadSignature",
    });
  });

  it.each<[string, Partial<Record<keyof GameConfigFields, unknown>>]>([
    ["houseCutBps over 10000", { houseCutBps: 10_001 }],
    ["bonusCapBps over 10000", { bonusCapBps: 10_001 }],
    ["roundSeconds under 60", { roundSeconds: 59 }],
    ["maxTilesPerBet zero", { maxTilesPerBet: 0 }],
    ["maxTilesPerBet over 36", { maxTilesPerBet: 37 }],
    ["ticketsPerUsdc zero", { ticketsPerUsdc: 0 }],
    ["a fractional field", { houseCutBps: 6.5 }],
    ["a string field", { roundSeconds: "90" }],
    ["no tiers", { referralTiers: [] }],
    ["tiers not highest first", { referralTiers: [...DEFAULT_GAME_CONFIG.referralTiers].reverse() }],
    ["a tier rate over 10000", { referralTiers: [{ tier: 1, min: 1, max: null, rateBps: 10_001 }] }],
  ])("refuses %s", (_name, bad) => {
    expect(attempt({ fields: { ...fields, ...bad } })).toEqual({ ok: false, code: "FieldOutOfRange" });
  });

  it("refuses a missing field and non-object fields", () => {
    const { maxTilesPerBet: _drop, ...rest } = fields;
    expect(attempt({ fields: rest })).toEqual({ ok: false, code: "FieldOutOfRange" });
    expect(attempt({ fields: null })).toEqual({ ok: false, code: "FieldOutOfRange" });
  });
});

describe("parseGameConfigFields", () => {
  it("takes the boundaries and reads the seed back unchanged", () => {
    expect(parseGameConfigFields(DEFAULT_GAME_CONFIG)).toEqual(DEFAULT_GAME_CONFIG);
    const edge = { ...DEFAULT_GAME_CONFIG, houseCutBps: 10_000, bonusCapBps: 0, roundSeconds: 60, maxTilesPerBet: 1 };
    expect(parseGameConfigFields(edge)).toEqual(edge);
  });

  it("puts keys in canonical order whatever order they arrive in", () => {
    const shuffled = Object.fromEntries(Object.entries(fields).reverse());
    expect(Object.keys(parseGameConfigFields(shuffled)!)).toEqual(Object.keys(fields));
  });
});
