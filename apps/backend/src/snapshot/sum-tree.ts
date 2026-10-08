// Merkle sum tree over an Epoch snapshot (ADR 0025, research 01). Pure: no
// Prisma, no Nest. The program's `snapshot.rs` verifier hashes the same bytes,
// and tests/fixtures/sum-tree-vectors.json pins both sides.
//
//   leaf = sha256(0x00 || wallet[32] || tickets u64le)        sum = tickets
//   node = sha256(0x01 || L.hash || L.sum u64le || R.hash || R.sum u64le)
//   pad  = leaf(wallet 0, tickets 0) up to 2^depth leaves
import { createHash } from "node:crypto";

export const MAX_SNAPSHOT_DEPTH = 18;
const U64_MAX = (1n << 64n) - 1n;

export interface SnapshotLeaf {
  readonly wallet: Uint8Array;
  readonly tickets: bigint;
}

/** One proof step: the sibling's hash and subtree sum. */
export interface SumNode {
  readonly hash: Buffer;
  readonly sum: bigint;
}

/** The four values `request_draw` commits to the Epoch. */
export interface SnapshotCommitment {
  readonly root: Buffer;
  readonly depth: number;
  readonly leafCount: number;
  readonly total: bigint;
}

export interface Winner {
  readonly index: number;
  readonly wallet: Buffer;
  readonly tickets: bigint;
  /** Tickets held by every leaf before this one; the range is [prefix, prefix + tickets). */
  readonly prefix: bigint;
}

export interface SumTree extends SnapshotCommitment {
  /** Siblings from the leaf up, `depth` long. */
  proof(index: number): SumNode[];
  /** The leaf whose range holds `target`; throws unless `target < total`. */
  findWinner(target: bigint): Winner;
}

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

export function leafHash(wallet: Uint8Array, tickets: bigint): Buffer {
  const buf = Buffer.alloc(41);
  buf[0] = 0x00;
  buf.set(wallet, 1);
  buf.writeBigUInt64LE(tickets, 33);
  return sha256(buf);
}

export function nodeHash(left: SumNode, right: SumNode): Buffer {
  const buf = Buffer.alloc(81);
  buf[0] = 0x01;
  left.hash.copy(buf, 1);
  buf.writeBigUInt64LE(left.sum, 33);
  right.hash.copy(buf, 41);
  buf.writeBigUInt64LE(right.sum, 73);
  return sha256(buf);
}

/** Bounds-checked read; the tsconfig makes plain indexing `T | undefined`. */
export function at<T>(items: ArrayLike<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new RangeError(`index ${i} is out of bounds`);
  return v;
}

function checkedAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  if (sum > U64_MAX) throw new RangeError("ticket sum overflows u64");
  return sum;
}

/** Smallest depth that fits `count` leaves: at least 1, at most MAX_SNAPSHOT_DEPTH. */
function depthFor(count: number): number {
  let depth = 1;
  while (2 ** depth < count) depth += 1;
  return depth;
}

/** `leaves` must be sorted strictly ascending by wallet bytes, every `tickets` in 1..u64 max. */
export function buildSumTree(leaves: readonly SnapshotLeaf[]): SumTree {
  const leafCount = leaves.length;
  if (leafCount === 0) throw new RangeError("snapshot has no leaves");
  if (leafCount > 2 ** MAX_SNAPSHOT_DEPTH) {
    throw new RangeError(`snapshot has ${leafCount} leaves, more than 2^${MAX_SNAPSHOT_DEPTH}`);
  }
  const depth = depthFor(leafCount);
  const width = 2 ** depth;

  const wallets = Buffer.alloc(leafCount * 32);
  const prefixes = new BigUint64Array(leafCount);
  const base = { hashes: Buffer.alloc(width * 32), sums: new BigUint64Array(width) };
  const levels = [base];
  let total = 0n;
  leaves.forEach((leaf, i) => {
    if (leaf.wallet.length !== 32) throw new RangeError(`leaf ${i} wallet is not 32 bytes`);
    if (leaf.tickets < 1n || leaf.tickets > U64_MAX) {
      throw new RangeError(`leaf ${i} tickets are outside 1..u64 max`);
    }
    if (i > 0 && Buffer.compare(wallets.subarray((i - 1) * 32, i * 32), leaf.wallet) >= 0) {
      throw new RangeError(`leaf ${i} is not in strictly ascending wallet order`);
    }
    wallets.set(leaf.wallet, i * 32);
    prefixes[i] = total;
    total = checkedAdd(total, leaf.tickets);
    leafHash(leaf.wallet, leaf.tickets).copy(base.hashes, i * 32);
    base.sums[i] = leaf.tickets;
  });
  const pad = leafHash(Buffer.alloc(32), 0n);
  for (let i = leafCount; i < width; i += 1) pad.copy(base.hashes, i * 32);

  for (let level = 1; level <= depth; level += 1) {
    const size = width >> level;
    const below = at(levels, level - 1);
    const up = { hashes: Buffer.alloc(size * 32), sums: new BigUint64Array(size) };
    for (let i = 0; i < size; i += 1) {
      const l = { hash: below.hashes.subarray(2 * i * 32, (2 * i + 1) * 32), sum: at(below.sums, 2 * i) };
      const r = { hash: below.hashes.subarray((2 * i + 1) * 32, (2 * i + 2) * 32), sum: at(below.sums, 2 * i + 1) };
      nodeHash(l, r).copy(up.hashes, i * 32);
      up.sums[i] = checkedAdd(l.sum, r.sum);
    }
    levels.push(up);
  }

  return {
    root: Buffer.from(at(levels, depth).hashes),
    depth,
    leafCount,
    total,
    proof(index) {
      if (!Number.isInteger(index) || index < 0 || index >= leafCount) {
        throw new RangeError(`no leaf at index ${index}`);
      }
      const siblings: SumNode[] = [];
      for (let level = 0; level < depth; level += 1) {
        const sib = (index >> level) ^ 1;
        const lv = at(levels, level);
        siblings.push({
          hash: Buffer.from(lv.hashes.subarray(sib * 32, (sib + 1) * 32)),
          sum: at(lv.sums, sib),
        });
      }
      return siblings;
    },
    findWinner(target) {
      if (target < 0n || target >= total) throw new RangeError("target is outside 0..total");
      // Prefixes are strictly increasing (every leaf holds at least one Ticket),
      // so the winner is the last leaf whose prefix is at most the target.
      let lo = 0;
      let hi = leafCount - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (at(prefixes, mid) <= target) lo = mid;
        else hi = mid - 1;
      }
      return {
        index: lo,
        wallet: Buffer.from(wallets.subarray(lo * 32, (lo + 1) * 32)),
        tickets: at(base.sums, lo),
        prefix: at(prefixes, lo),
      };
    },
  };
}

/**
 * The program's `payout` walk (research 01) in TypeScript. True when the proof
 * reaches the committed root and total and `target` falls in the leaf's range.
 * Also rejects `index >= leafCount`, which the walk alone would accept as an
 * alias when it only differs above bit `depth`.
 */
export function verifyPayout(
  commitment: SnapshotCommitment,
  target: bigint,
  index: number,
  wallet: Uint8Array,
  tickets: bigint,
  siblings: readonly SumNode[],
): boolean {
  if (siblings.length !== commitment.depth) return false;
  if (!Number.isInteger(index) || index < 0 || index >= commitment.leafCount) return false;
  let cur: SumNode = { hash: leafHash(wallet, tickets), sum: tickets };
  let prefix = 0n;
  try {
    for (let i = 0; i < commitment.depth; i += 1) {
      const sib = at(siblings, i);
      if ((index >> i) & 1) {
        prefix = checkedAdd(prefix, sib.sum);
        cur = { hash: nodeHash(sib, cur), sum: checkedAdd(sib.sum, cur.sum) };
      } else {
        cur = { hash: nodeHash(cur, sib), sum: checkedAdd(cur.sum, sib.sum) };
      }
    }
  } catch {
    return false; // u64 overflow along the walk
  }
  return (
    cur.hash.equals(commitment.root) &&
    cur.sum === commitment.total &&
    prefix <= target &&
    target < prefix + tickets
  );
}
