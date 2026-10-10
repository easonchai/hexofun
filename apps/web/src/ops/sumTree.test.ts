import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sumTreeRoot, type SumLeaf } from "./sumTree.js";

interface Vector {
  name: string;
  leaves?: { wallet: string; tickets: string }[];
  generator?: string;
  root: string;
}

// The same vectors the backend builder and the program's verifier are pinned to.
const vectors = (
  JSON.parse(readFileSync(new URL("../../../../tests/fixtures/sum-tree-vectors.json", import.meta.url), "utf8")) as { cases: Vector[] }
).cases;

/** Leaf i of the generated case, by the rule the fixture's `generator` field states. */
function generated(i: number): SumLeaf {
  const index = Buffer.alloc(4);
  index.writeUInt32BE(i);
  const h = createHash("sha256").update("hexvault-sum-tree-vectors").update(index).digest();
  return { wallet: Buffer.concat([index, h.subarray(0, 28)]), tickets: 1n + BigInt(h.readUInt32LE(28) % 1000) };
}

describe("sumTreeRoot", () => {
  it.each(vectors.filter((v) => v.leaves))("hashes the $name vector to the pinned root", async (vector) => {
    const leaves = (vector.leaves ?? []).map((l) => ({ wallet: Buffer.from(l.wallet, "hex"), tickets: BigInt(l.tickets) }));
    expect(await sumTreeRoot(leaves)).toBe(vector.root);
  });

  it("hashes the 200,000-leaf vector to the pinned root", async () => {
    const vector = vectors.find((v) => v.generator);
    expect(await sumTreeRoot(Array.from({ length: 200_000 }, (_, i) => generated(i)))).toBe(vector?.root);
  }, 60_000);

  it("has no root for no leaves", async () => {
    expect(await sumTreeRoot([])).toBeNull();
  });
});
