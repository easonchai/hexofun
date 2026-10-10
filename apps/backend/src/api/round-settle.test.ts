// Pure tests for the reveal and settle math (off-chain-tickets ticket 17).
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deriveTile, potOf, settleRows, voidRows, type SettlePosition, type SettleRow } from "./round-settle";

// Quicknet round 32883570, recorded from api.drand.sh (also served by Cloudflare).
const SIGNATURE = Buffer.from(
  "a49c5c706f30491753d7c9542f6cb1bee6342dadcb360a497a73875b4884584618d6062fafbb0ce0a9f4a13f012b6b22",
  "hex",
);

const mask = (...tiles: number[]): bigint => tiles.reduce((m, t) => m | (1n << BigInt(t)), 0n);
const sum = (rows: readonly SettleRow[]): bigint => rows.reduce((total, r) => total + r.delta, 0n);
const HOUSE = "house";

describe("deriveTile", () => {
  it("matches a hand-built preimage for a fixed seed and the recorded beacon", () => {
    const seed = Buffer.alloc(32, 0x11);
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(42n);
    const x = createHash("sha256")
      .update(Buffer.concat([Buffer.from("hexvault/round/v1"), seed, SIGNATURE, id, Buffer.alloc(4)]))
      .digest();
    const result = deriveTile(seed, SIGNATURE, 42n);
    expect(result.ctr).toBe(0);
    expect(result.tile).toBe(x.readUInt32LE(0) % 36);
    // Pinned so a change to the preimage or the byte order fails here.
    expect(result).toEqual({ tile: PINNED.tile, ctr: 0 });
  });

  it("bumps ctr when the sample falls in the rejected tail", () => {
    const seed = Buffer.from(REJECTED_SEED, "hex");
    const result = deriveTile(seed, SIGNATURE, 7n);
    expect(result.ctr).toBeGreaterThan(0);
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(7n);
    const sample = (ctr: number): number => {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(ctr);
      return createHash("sha256")
        .update(Buffer.concat([Buffer.from("hexvault/round/v1"), seed, SIGNATURE, id, c]))
        .digest()
        .readUInt32LE(0);
    };
    expect(sample(0)).toBeGreaterThanOrEqual(2 ** 32 - (2 ** 32 % 36));
    expect(result.tile).toBe(sample(result.ctr) % 36);
    expect(result).toEqual(REJECTED_RESULT);
  });

  it("depends on the Round id", () => {
    const seed = Buffer.alloc(32, 0x11);
    const tiles = new Set(Array.from({ length: 40 }, (_, i) => deriveTile(seed, SIGNATURE, BigInt(i)).tile));
    expect(tiles.size).toBeGreaterThan(10);
  });
});

describe("settleRows", () => {
  // Pot 100: A stakes 10 on tiles 3 and 7, B 30 on tile 3, C 50 on tile 12.
  const A = { owner: "A", tiles: mask(3, 7), stakePerTile: 10n, restored: false };
  const B = { owner: "B", tiles: mask(3), stakePerTile: 30n, restored: false };
  const C = { owner: "C", tiles: mask(12), stakePerTile: 50n, restored: false };
  const round: SettlePosition[] = [A, B, C];

  it("pays covering Positions their stake plus a share of the losers' pot after the cut", () => {
    expect(potOf(round)).toBe(100n);
    const { houseCut, rows } = settleRows(round, 3, 600, HOUSE);
    // Tile 3 holds 40; the losers' pot is 60; the cut is 3; 57 is shared 10:30.
    expect(houseCut).toBe(3n);
    expect(rows).toEqual([
      { owner: "A", reason: "reward", delta: 10n + 14n },
      { owner: "B", reason: "reward", delta: 30n + 42n },
      // The cut plus the one Ticket the shares rounded away.
      { owner: HOUSE, reason: "house_credit", delta: 4n },
    ]);
    expect(sum(rows)).toBe(100n);
  });

  it("forfeits the whole pot to the House when nobody covered the tile", () => {
    const { houseCut, rows } = settleRows(round, 20, 600, HOUSE);
    expect(houseCut).toBe(0n);
    expect(rows).toEqual([{ owner: HOUSE, reason: "house_credit", delta: 100n }]);
    expect(sum(rows)).toBe(potOf(round));
  });

  it("books no House row when the cut is zero and the shares divide evenly", () => {
    const even = [
      { owner: "A", tiles: mask(1), stakePerTile: 10n, restored: false },
      { owner: "B", tiles: mask(2), stakePerTile: 10n, restored: false },
    ];
    const { rows } = settleRows(even, 1, 0, HOUSE);
    expect(rows).toEqual([{ owner: "A", reason: "reward", delta: 20n }]);
  });

  it("books only the share for a winner a reset already restored", () => {
    const { rows } = settleRows([{ ...A, restored: true }, B, C], 3, 600, HOUSE);
    expect(rows).toEqual([
      { owner: "A", reason: "reward", delta: 14n },
      { owner: "B", reason: "reward", delta: 72n },
      { owner: HOUSE, reason: "house_credit", delta: 4n },
    ]);
    // The restored winner's 10 on the tile came back through the reset, not through a row.
    expect(sum(rows) + 10n).toBe(potOf(round));
  });

  it("splits by stake when several Positions cover the tile and never pays out more than the pot", () => {
    let state = 12345;
    const next = (n: number): number => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state % n;
    };
    for (let run = 0; run < 200; run++) {
      const positions: SettlePosition[] = Array.from({ length: 1 + next(8) }, (_, i) => ({
        owner: `P${i}`,
        tiles: mask(...Array.from({ length: 1 + next(4) }, () => next(6))),
        stakePerTile: BigInt(1 + next(1000)),
        restored: false,
      }));
      const tile = next(6);
      const { rows } = settleRows(positions, tile, next(10_001), HOUSE);
      expect(sum(rows)).toBe(potOf(positions));
      expect(rows.every((r) => r.delta > 0n)).toBe(true);
    }
  });
});

describe("voidRows", () => {
  it("refunds every stake whole and gives the House nothing", () => {
    const positions: SettlePosition[] = [
      { owner: "A", tiles: mask(3, 7), stakePerTile: 10n, restored: false },
      { owner: "B", tiles: mask(3), stakePerTile: 30n, restored: false },
    ];
    const rows = voidRows(positions);
    expect(rows).toEqual([
      { owner: "A", reason: "refund", delta: 20n },
      { owner: "B", reason: "refund", delta: 30n },
    ]);
    expect(sum(rows)).toBe(potOf(positions));
  });

  it("books nothing for a stake a reset already restored", () => {
    const positions: SettlePosition[] = [
      { owner: "A", tiles: mask(3, 7), stakePerTile: 10n, restored: true },
      { owner: "B", tiles: mask(3), stakePerTile: 30n, restored: false },
    ];
    const rows = voidRows(positions);
    expect(rows).toEqual([{ owner: "B", reason: "refund", delta: 30n }]);
    // The restored 20 plus the refunded 30 is the pot.
    expect(sum(rows) + 20n).toBe(potOf(positions));
    expect(voidRows(positions.map((p) => ({ ...p, restored: true })))).toEqual([]);
  });
});

// Both expectations were computed with a separate Python implementation of the rule.
const PINNED = { tile: 19 };
// Found by brute force over 188 million seeds: its first sample, 4294967293, is in the rejected tail.
const REJECTED_SEED = "efdb360b00000000000000000000000000000000000000000000000000000000";
const REJECTED_RESULT = { tile: 20, ctr: 1 };
