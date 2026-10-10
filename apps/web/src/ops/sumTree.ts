/**
 * The Epoch snapshot's Merkle sum tree root, computed in the browser from the
 * leaves `GET /epochs/:id/snapshot` serves (off-chain-tickets ticket 25). A port
 * of the root half of apps/backend/src/snapshot/sum-tree.ts, which the web cannot
 * import; sumTree.test.ts pins it to tests/fixtures/sum-tree-vectors.json.
 *
 *   leaf = sha256(0x00 || wallet[32] || tickets u64le)        sum = tickets
 *   node = sha256(0x01 || L.hash || L.sum u64le || R.hash || R.sum u64le)
 *   pad  = leaf(wallet 0, tickets 0) up to 2^depth leaves
 *
 * Only the real leaves are hashed; an all-pad subtree has one value per level.
 */
interface Node {
  hash: Uint8Array;
  sum: bigint;
}

export interface SumLeaf {
  wallet: Uint8Array;
  tickets: bigint;
}

const BATCH = 4_096;

const sha256 = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));

const leafHash = (leaf: SumLeaf): Promise<Uint8Array> => {
  const buf = new Uint8Array(41);
  buf.set(leaf.wallet, 1);
  new DataView(buf.buffer).setBigUint64(33, leaf.tickets, true);
  return sha256(buf);
};

const nodeOf = async (left: Node, right: Node): Promise<Node> => {
  const buf = new Uint8Array(81);
  const view = new DataView(buf.buffer);
  buf[0] = 1;
  buf.set(left.hash, 1);
  view.setBigUint64(33, left.sum, true);
  buf.set(right.hash, 41);
  view.setBigUint64(73, right.sum, true);
  return { hash: await sha256(buf), sum: left.sum + right.sum };
};

/** Runs `fn` over `items` a batch at a time, so 260,000 digests are not 260,000 pending promises. */
async function mapBatched<T, R>(items: readonly T[], fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += BATCH) {
    out.push(...(await Promise.all(items.slice(start, start + BATCH).map((item, i) => fn(item, start + i)))));
  }
  return out;
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The root as lowercase hex, or null for no leaves (an empty snapshot has no tree). Leaves must already be in wallet-byte order. */
export async function sumTreeRoot(leaves: readonly SumLeaf[]): Promise<string | null> {
  if (leaves.length === 0) return null;
  let depth = 1;
  while (2 ** depth < leaves.length) depth += 1;
  let pad: Node = { hash: await leafHash({ wallet: new Uint8Array(32), tickets: 0n }), sum: 0n };
  let level: Node[] = await mapBatched(leaves, async (leaf) => ({ hash: await leafHash(leaf), sum: leaf.tickets }));
  for (let l = 0; l < depth; l += 1) {
    const padNode = pad;
    const pairs = Array.from({ length: Math.ceil(level.length / 2) }, (_, i) => i);
    level = await mapBatched(pairs, (i) => nodeOf(level[2 * i] as Node, level[2 * i + 1] ?? padNode)); // SAFETY: i < ceil(length / 2), so the left child exists.
    pad = await nodeOf(padNode, padNode);
  }
  return toHex((level[0] as Node).hash); // SAFETY: after `depth` halvings of 1..2^depth nodes exactly one remains.
}
