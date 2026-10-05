// The Operator finds a draw's winner by reading the Weight tree itself (ticket
// 13), so the port of weight_tree.rs's reads has to agree with the program: the
// same slot rule, the same idle rule, and Fenwick partial sums per node.
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { EPOCH_STATUS, type EpochState } from "./chain-state";
import { leafHoldingTarget, nodeCount, prefixWeights, readNodes } from "./weight-tree";

const HEADER = 56;
const NODE = 72;

interface NodeSpec {
  principalSum: bigint;
  /** The slot written in epoch 1 (parity 1), or null for a node that sat idle. */
  slot: { stamp: bigint; base: bigint; weight: bigint } | null;
}

function tree(nodes: NodeSpec[]): Buffer {
  const data = Buffer.alloc(HEADER + nodes.length * NODE);
  data.writeUInt8(1, 8); // version
  data.writeBigUInt64LE(BigInt(nodes.length), 16); // node_count
  PublicKey.default.toBuffer().copy(data, 24); // pool
  nodes.forEach((node, i) => {
    const at = HEADER + i * NODE;
    data.writeBigUInt64LE(node.principalSum, at);
    if (node.slot === null) return;
    // Epoch 1 is odd, so it lives in the second slot, 32 bytes after the first.
    const slotAt = at + 8 + 32;
    data.writeBigUInt64LE(node.slot.stamp, slotAt);
    data.writeBigUInt64LE(node.slot.base, slotAt + 8);
    data.writeBigUInt64LE(node.slot.weight & 0xffff_ffff_ffff_ffffn, slotAt + 16);
    data.writeBigUInt64LE(node.slot.weight >> 64n, slotAt + 24);
  });
  return data;
}

const epoch = (target: bigint): EpochState => ({
  epochId: 1n,
  startsAt: 0n,
  endsAt: 100n,
  status: EPOCH_STATUS.DRAWN,
  jackpotAmount: 0n,
  vrfSeed: new Uint8Array(32),
  requestedAt: 0n,
  target,
  drawnAt: 0n,
  endedAt: 0n,
});

describe("leafHoldingTarget", () => {
  // Leaf weights 700, 20, 30. Leaf 1 sat idle at Principal 7 through the
  // 100-second epoch, so the idle rule gives it 7 x 100. Fenwick nodes hold
  // partial sums: node 2 is leaves 1 and 2, node 3 is leaf 3 alone.
  const data = tree([
    { principalSum: 7n, slot: null },
    { principalSum: 9n, slot: { stamp: 1n, base: 9n, weight: 720n } },
    { principalSum: 3n, slot: { stamp: 1n, base: 3n, weight: 30n } },
  ]);
  const nodes = readNodes(data);
  const leafOf = (target: bigint) => leafHoldingTarget(nodes, epoch(target));

  it("reads the node count and every node", () => {
    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.principalSum).toBe(7n);
    expect(nodes[1]?.slots[1].weight).toBe(720n);
  });

  it("finds the leaf whose range holds the target, ends included", () => {
    expect(leafOf(0n)).toBe(1);
    expect(leafOf(699n)).toBe(1);
    expect(leafOf(700n)).toBe(2);
    expect(leafOf(719n)).toBe(2);
    expect(leafOf(720n)).toBe(3);
    expect(leafOf(749n)).toBe(3);
  });

  it("finds no leaf at or past the total", () => {
    expect(leafOf(750n)).toBeNull();
  });

  it("reads a Weight past 2^64, which the u128 slot allows", () => {
    const big = tree([{ principalSum: 1n, slot: { stamp: 1n, base: 1n, weight: 1n << 70n } }]);
    expect(leafHoldingTarget(readNodes(big), epoch((1n << 70n) - 1n))).toBe(1);
    expect(leafHoldingTarget(readNodes(big), epoch(1n << 70n))).toBeNull();
  });

  // The read model's Player Weight is `prefix[i] - prefix[i - 1]` and the
  // root is the last entry (ticket 14).
  it("gives prefix sums, so a leaf is a difference and the root is the last entry", () => {
    const prefix = prefixWeights(nodes, 1n, 100n);
    expect(prefix).toEqual([0n, 700n, 720n, 750n]);
    expect((prefix[2] as bigint) - (prefix[1] as bigint)).toBe(20n);
  });

  it("reads the node count from the header alone", () => {
    expect(nodeCount(data.subarray(0, HEADER))).toBe(3);
    expect(() => nodeCount(data.subarray(0, 10))).toThrow(/truncated/);
  });

  it("refuses an account shorter than its node count says", () => {
    expect(() => readNodes(data.subarray(0, HEADER + NODE))).toThrow(/shorter than its node count/);
  });
});
