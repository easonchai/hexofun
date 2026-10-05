// A read-only TypeScript port of weight_tree.rs's reads, so the Operator can
// find a draw's winner without any registration table. Same slot and idle
// rules as the program and as `fetchTree` in tests/helpers/hx.ts, which this
// mirrors. Nothing writes the tree from here.
import type { EpochState } from "./chain-state";

const TREE_HEADER = 56;
const TREE_NODE = 56;
/** `node_count` follows the discriminator, version, padding and node size. */
const NODE_COUNT_AT = 16;

interface Slot {
  readonly stamp: bigint;
  readonly base: bigint;
  readonly tickets: bigint;
}

interface Node {
  readonly principalSum: bigint;
  readonly slots: readonly [Slot, Slot];
}

function readSlot(data: Buffer, at: number): Slot {
  return {
    stamp: data.readBigUInt64LE(at),
    base: data.readBigUInt64LE(at + 8),
    tickets: data.readBigUInt64LE(at + 16),
  };
}

export function readNodes(data: Buffer): Node[] {
  if (data.length < TREE_HEADER) throw new Error("weight tree account is truncated");
  const count = Number(data.readBigUInt64LE(NODE_COUNT_AT));
  if (data.length < TREE_HEADER + count * TREE_NODE) {
    throw new Error("weight tree account is shorter than its node count");
  }
  const nodes: Node[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = TREE_HEADER + i * TREE_NODE;
    nodes.push({
      principalSum: data.readBigUInt64LE(at),
      slots: [readSlot(data, at + 8), readSlot(data, at + 32)],
    });
  }
  return nodes;
}

/** One node's Tickets in epoch `e`: its slot if stamped for `e`, else it sat
 *  idle through `e` at the Principal it had then. */
function nodeTickets(node: Node, e: bigint): bigint {
  const slot = node.slots[Number(e % 2n)] as Slot;
  if (slot.stamp === e) return slot.tickets;
  const next = node.slots[Number((e + 1n) % 2n)] as Slot;
  return next.stamp === e + 1n ? next.base : node.principalSum;
}

/** The Fenwick tree's header: how many leaves it holds. */
export function nodeCount(data: Buffer): number {
  if (data.length < TREE_HEADER) throw new Error("weight tree account is truncated");
  return Number(data.readBigUInt64LE(NODE_COUNT_AT));
}

/**
 * `prefix[i]` is the Tickets of leaves 1..i in epoch `epochId`, `prefix[0]` is
 * 0, and the last entry is the root. Leaf `i` is `prefix[i] - prefix[i - 1]`.
 */
export function prefixWeights(nodes: readonly Node[], epochId: bigint): bigint[] {
  const prefix: bigint[] = [0n];
  for (let i = 1; i <= nodes.length; i += 1) {
    const low = i & -i;
    prefix.push((prefix[i - low] as bigint) + nodeTickets(nodes[i - 1] as Node, epochId));
  }
  return prefix;
}

/**
 * The 1-based leaf whose range holds `epoch.target`, or null when none does.
 * `epoch` must still be readable on chain, which a Drawn epoch always is.
 *
 * ponytail: linear in the node count, one pass per payout. At the 145,000
 * node ceiling that is still milliseconds; replace with binary lifting only
 * if it ever shows up in a tick's timing.
 */
export function leafHoldingTarget(nodes: readonly Node[], epoch: EpochState): number | null {
  const prefix = prefixWeights(nodes, epoch.epochId);
  let start = 0n;
  for (let i = 1; i <= nodes.length; i += 1) {
    const end = prefix[i] as bigint;
    const leafEnd = end - (prefix[i - 1] as bigint) + start;
    if (epoch.target >= start && epoch.target < leafEnd) return i;
    start = leafEnd;
  }
  return null;
}
