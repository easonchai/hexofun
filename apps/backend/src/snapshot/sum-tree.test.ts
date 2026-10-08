import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  at,
  buildSumTree,
  leafHash,
  nodeHash,
  verifyPayout,
  type SnapshotLeaf,
  type SumNode,
} from "./sum-tree";

const VECTORS = resolve(__dirname, "../../../../tests/fixtures/sum-tree-vectors.json");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

/** Wallet whose first byte is `n`, so ascending `n` is ascending wallet order. */
const wallet = (n: number) => Buffer.from([n, ...new Array(31).fill(n)]);
const leaves = (...tickets: number[]): SnapshotLeaf[] =>
  tickets.map((t, i) => ({ wallet: wallet(i + 1), tickets: BigInt(t) }));

/** Spec formula written the slow, recursive way, independent of the builder's level arrays. */
function naiveRoot(rows: readonly SnapshotLeaf[], depth: number): SumNode {
  const at = (from: number, size: number): SumNode => {
    if (size === 1) {
      const row = rows[from]; // undefined past the end is the padding
      return row
        ? { hash: leafHash(row.wallet, row.tickets), sum: row.tickets }
        : { hash: leafHash(Buffer.alloc(32), 0n), sum: 0n };
    }
    const l = at(from, size / 2);
    const r = at(from + size / 2, size / 2);
    return { hash: nodeHash(l, r), sum: l.sum + r.sum };
  };
  return at(0, 2 ** depth);
}

describe("buildSumTree", () => {
  it("refuses an empty list", () => {
    expect(() => buildSumTree([])).toThrow(/no leaves/);
  });

  it("refuses unsorted, duplicate, zero-ticket, overflowing and malformed leaves", () => {
    const a = at(leaves(1), 0);
    const b = { wallet: wallet(2), tickets: 1n };
    expect(() => buildSumTree([b, a])).toThrow(/ascending/);
    expect(() => buildSumTree([a, a])).toThrow(/ascending/);
    expect(() => buildSumTree([{ ...a, tickets: 0n }])).toThrow(/1\.\.u64/);
    expect(() => buildSumTree([{ ...a, tickets: 1n << 64n }])).toThrow(/1\.\.u64/);
    expect(() => buildSumTree([{ ...a, wallet: Buffer.alloc(31, 1) }])).toThrow(/32 bytes/);
    const max = (1n << 64n) - 1n;
    expect(() => buildSumTree([{ ...a, tickets: max }, { ...b, tickets: 1n }])).toThrow(/overflows/);
  });

  it("puts one leaf at depth 1 beside a pad leaf", () => {
    const rows = leaves(7);
    const tree = buildSumTree(rows);
    expect(tree).toMatchObject({ depth: 1, leafCount: 1, total: 7n });
    const pad = { hash: leafHash(Buffer.alloc(32), 0n), sum: 0n };
    const leaf = { hash: leafHash(at(rows, 0).wallet, 7n), sum: 7n };
    expect(tree.root.equals(nodeHash(leaf, pad))).toBe(true);
    expect(tree.proof(0)).toEqual([pad]);
  });

  it("pads a non-power-of-two count to the next power", () => {
    const rows = leaves(3, 1, 4, 1, 5);
    const tree = buildSumTree(rows);
    expect(tree).toMatchObject({ depth: 3, leafCount: 5, total: 14n });
    expect(tree.root.equals(naiveRoot(rows, 3).hash)).toBe(true);
    expect(buildSumTree(leaves(1, 1, 1, 1)).depth).toBe(2);
  });

  it("builds 2^18 leaves in budget and refuses one more", () => {
    const n = 2 ** 18;
    const rows = Array.from({ length: n }, (_, i) => {
      const w = Buffer.alloc(32);
      w.writeUInt32BE(i, 0);
      return { wallet: w, tickets: 1n + BigInt(i % 7) };
    });
    const started = Date.now();
    const tree = buildSumTree(rows);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(tree).toMatchObject({ depth: 18, leafCount: n });
    expect(tree.proof(n - 1)).toHaveLength(18);
    expect(() => buildSumTree([...rows, { wallet: Buffer.alloc(32, 255), tickets: 1n }])).toThrow(
      /more than 2\^18/,
    );
  }, 60_000);
});

describe("proofs", () => {
  const rows = leaves(3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5);
  const tree = buildSumTree(rows);
  const commitment = tree;
  const row4 = at(rows, 4);
  const prefixOf = (i: number) => rows.slice(0, i).reduce((s, r) => s + r.tickets, 0n);

  it("verifies for every leaf against the payout walk", () => {
    rows.forEach((row, i) => {
      const target = prefixOf(i);
      expect(verifyPayout(commitment, target, i, row.wallet, row.tickets, tree.proof(i))).toBe(true);
    });
  });

  it("rejects a tampered sibling hash or sum", () => {
    const sibs = tree.proof(4);
    const { wallet: w, tickets: t } = row4;
    const hash = Buffer.from(at(sibs, 1).hash);
    hash[0] = at(hash, 0) ^ 1;
    const bad = sibs.map((s, i) => (i === 1 ? { ...s, hash } : s));
    const target = prefixOf(4);
    expect(verifyPayout(commitment, target, 4, w, t, bad)).toBe(false);
    const badSum = sibs.map((s, i) => (i === 0 ? { ...s, sum: s.sum + 1n } : s));
    expect(verifyPayout(commitment, target, 4, w, t, badSum)).toBe(false);
  });

  it("rejects a wrong-length proof", () => {
    const sibs = tree.proof(4);
    const target = prefixOf(4);
    const { wallet: w, tickets: t } = row4;
    expect(verifyPayout(commitment, target, 4, w, t, sibs.slice(1))).toBe(false);
    expect(verifyPayout(commitment, target, 4, w, t, [...sibs, at(sibs, 0)])).toBe(false);
  });

  it("rejects a wrong index, a wrong leaf and a target outside the range", () => {
    const sibs = tree.proof(4);
    const { wallet: w, tickets: t } = row4;
    const target = prefixOf(4);
    expect(verifyPayout(commitment, target, 5, w, t, sibs)).toBe(false);
    expect(verifyPayout(commitment, target, 4 + 2 ** tree.depth, w, t, sibs)).toBe(false);
    expect(verifyPayout(commitment, target, 4, w, t + 1n, sibs)).toBe(false);
    expect(verifyPayout(commitment, target - 1n, 4, w, t, sibs)).toBe(false);
    expect(verifyPayout(commitment, target + t, 4, w, t, sibs)).toBe(false);
  });

  it("rejects a wrong root or total", () => {
    const sibs = tree.proof(0);
    const args = [0n, 0, at(rows, 0).wallet, at(rows, 0).tickets, sibs] as const;
    expect(verifyPayout({ ...commitment, total: commitment.total + 1n }, ...args)).toBe(false);
    expect(verifyPayout({ ...commitment, root: sha256(Buffer.from("x")) }, ...args)).toBe(false);
  });

  it("rejects an out-of-range proof request", () => {
    expect(() => tree.proof(rows.length)).toThrow(/no leaf/);
    expect(() => tree.proof(-1)).toThrow(/no leaf/);
  });
});

describe("findWinner", () => {
  const rows = leaves(3, 1, 4, 1, 5, 9, 2, 6);
  const tree = buildSumTree(rows);

  it("returns the leaf holding the target at both edges of every range", () => {
    let prefix = 0n;
    rows.forEach((row, i) => {
      for (const target of [prefix, prefix + row.tickets - 1n]) {
        expect(tree.findWinner(target)).toMatchObject({ index: i, tickets: row.tickets, prefix });
      }
      expect(tree.findWinner(prefix).wallet.equals(row.wallet)).toBe(true);
      prefix += row.tickets;
    });
  });

  it("never returns a zero-Ticket leaf, padding included", () => {
    for (let t = 0n; t < tree.total; t += 1n) {
      const winner = tree.findWinner(t);
      expect(winner.tickets).toBeGreaterThan(0n);
      expect(winner.index).toBeLessThan(tree.leafCount);
    }
  });

  it("refuses a target at or past the total", () => {
    expect(() => tree.findWinner(tree.total)).toThrow(/outside/);
    expect(() => tree.findWinner(-1n)).toThrow(/outside/);
  });
});

// --- shared vectors ---------------------------------------------------------

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Spec {
  name: string;
  /** Explicit leaves, or a generator description the 200k case uses. */
  leaves: SnapshotLeaf[];
  generator?: string;
}

/**
 * Leaf i of the generated case: h = sha256("hexvault-sum-tree-vectors" || u32be(i)),
 * wallet = u32be(i) || h[0..28], tickets = 1 + u32le(h[28..32]) mod 1000.
 * The leading index keeps wallets in ascending order, so index == position.
 */
function generatedLeaf(i: number): SnapshotLeaf {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(i);
  const h = sha256(Buffer.concat([Buffer.from("hexvault-sum-tree-vectors"), idx]));
  return {
    wallet: Buffer.concat([idx, h.subarray(0, 28)]),
    tickets: 1n + BigInt(h.readUInt32LE(28) % 1000),
  };
}

const GENERATOR =
  'leaf i (0-based, i < 200000): h = sha256("hexvault-sum-tree-vectors" || u32be(i)); ' +
  "wallet = u32be(i) || h[0..28]; tickets = 1 + (u32le(h[28..32]) mod 1000)";

const SPECS: Spec[] = [
  { name: "one-leaf", leaves: [{ wallet: wallet(9), tickets: 5n }] },
  {
    name: "two-leaves-u64-max",
    leaves: [
      { wallet: wallet(1), tickets: 1n << 63n },
      { wallet: wallet(2), tickets: (1n << 63n) - 1n },
    ],
  },
  {
    name: "eleven-leaves",
    leaves: leaves(3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5),
  },
  {
    name: "two-hundred-thousand-leaves",
    leaves: Array.from({ length: 200_000 }, (_, i) => generatedLeaf(i)),
    generator: GENERATOR,
  },
];

function buildVectors() {
  const cases = SPECS.map((spec) => {
    const tree = buildSumTree(spec.leaves);
    const n = tree.leafCount;
    const proofIndexes = [...new Set([0, n >> 1, n - 1])];
    const proofs = proofIndexes.map((index) => ({
      index,
      wallet: hex(at(spec.leaves, index).wallet),
      tickets: at(spec.leaves, index).tickets.toString(),
      siblings: tree.proof(index).map((s) => ({ hash: hex(s.hash), sum: s.sum.toString() })),
    }));
    let midPrefix = 0n;
    for (let i = 0; i < n >> 1; i += 1) midPrefix += at(spec.leaves, i).tickets;
    const targets = [0n, midPrefix, tree.total - 1n].map((target) => {
      const w = tree.findWinner(target);
      return {
        target: target.toString(),
        winnerIndex: w.index,
        winnerWallet: hex(w.wallet),
        winnerTickets: w.tickets.toString(),
        winnerPrefix: w.prefix.toString(),
      };
    });
    return {
      name: spec.name,
      ...(spec.generator ? { generator: spec.generator } : { leaves: spec.leaves.map((l) => ({ wallet: hex(l.wallet), tickets: l.tickets.toString() })) }),
      depth: tree.depth,
      leafCount: n,
      total: tree.total.toString(),
      root: hex(tree.root),
      proofs,
      targets,
    };
  });
  return {
    format:
      "Merkle sum tree vectors for apps/backend/src/snapshot/sum-tree.ts and the program's snapshot.rs. " +
      "Hashes and wallets are lowercase hex with no prefix. tickets, sums, total, target and prefix are u64 decimal " +
      "strings; depth, leafCount, index and winnerIndex are JSON numbers. " +
      "leaf = sha256(0x00 || wallet[32] || tickets u64le); node = sha256(0x01 || L.hash || L.sum u64le || R.hash || R.sum u64le); " +
      "pad to 2^depth with leaf(wallet 0, tickets 0). proofs[].siblings run from the leaf up. " +
      "Each target's winner is the leaf whose [winnerPrefix, winnerPrefix + winnerTickets) holds it. " +
      "Regenerate with UPDATE_VECTORS=1 pnpm --filter @hexvault/backend test sum-tree.",
    cases,
  };
}

describe("shared vectors", () => {
  if (process.env.UPDATE_VECTORS) {
    writeFileSync(VECTORS, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  }

  it("match a fresh regeneration", () => {
    expect(JSON.parse(readFileSync(VECTORS, "utf8"))).toEqual(buildVectors());
  }, 60_000);

  it("verify through the payout walk, read straight from the file", () => {
    const file = JSON.parse(readFileSync(VECTORS, "utf8"));
    expect(file.cases.map((c: { depth: number }) => c.depth)).toEqual(
      expect.arrayContaining([1, 4, 18]),
    );
    for (const c of file.cases) {
      const commitment = {
        root: Buffer.from(c.root, "hex"),
        depth: c.depth,
        leafCount: c.leafCount,
        total: BigInt(c.total),
      };
      const byIndex = new Map<number, (typeof c.proofs)[number]>(c.proofs.map((p: { index: number }) => [p.index, p]));
      for (const t of c.targets) {
        const p = byIndex.get(t.winnerIndex);
        expect(p, `${c.name}: proof for winner ${t.winnerIndex}`).toBeDefined();
        const siblings = p.siblings.map((s: { hash: string; sum: string }) => ({
          hash: Buffer.from(s.hash, "hex"),
          sum: BigInt(s.sum),
        }));
        expect(
          verifyPayout(commitment, BigInt(t.target), p.index, Buffer.from(p.wallet, "hex"), BigInt(p.tickets), siblings),
          `${c.name}: target ${t.target}`,
        ).toBe(true);
      }
    }
  });
});
