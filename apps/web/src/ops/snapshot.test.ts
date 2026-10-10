import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chainRootHex, loadSnapshot, rootVerdict } from "./snapshot.js";
import { sumTreeRoot } from "./sumTree.js";

const ROOT = "ab".repeat(32);
const ZEROS = "00".repeat(32);

describe("rootVerdict", () => {
  it("is match only when the leaves, the backend and the chain agree", () => {
    expect(rootVerdict({ computed: ROOT, served: ROOT, chain: ROOT })).toBe("match");
  });

  it("is a mismatch when the chain holds another root, as a stale epoch's does", () => {
    expect(rootVerdict({ computed: ROOT, served: ROOT, chain: "cd".repeat(32) })).toBe("mismatch");
  });

  it("is a mismatch when the served leaves do not hash to the root the backend states", () => {
    expect(rootVerdict({ computed: "cd".repeat(32), served: ROOT, chain: ROOT })).toBe("mismatch");
    expect(rootVerdict({ computed: "cd".repeat(32), served: ROOT, chain: ZEROS })).toBe("mismatch");
  });

  it("waits for request_draw while the chain root is zero, and calls an empty snapshot empty", () => {
    expect(rootVerdict({ computed: ROOT, served: ROOT, chain: ZEROS })).toBe("uncommitted");
    expect(rootVerdict({ computed: null, served: null, chain: ZEROS })).toBe("empty");
  });
});

describe("chainRootHex", () => {
  it("reads the 32 bytes Anchor decodes and refuses anything else", () => {
    expect(chainRootHex(Array.from({ length: 32 }, () => 0xab))).toBe(ROOT);
    expect(() => chainRootHex(undefined)).toThrow(/snapshot_root/);
    expect(() => chainRootHex([1, 2])).toThrow(/snapshot_root/);
  });
});

describe("loadSnapshot", () => {
  afterEach(() => vi.unstubAllGlobals());

  const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey]
    .sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const leaves = owners.map((o, index) => ({ index, owner: o.toBase58(), tickets: String(10 * (index + 1)) }));

  const serve = (pages: Record<string, unknown>) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const page = pages[new URL(url).searchParams.get("after") ?? "0"];
      return page === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(page));
    });

  it("follows nextIndex across pages and hashes every leaf", async () => {
    const expected = await sumTreeRoot(owners.map((o, i) => ({ wallet: o.toBytes(), tickets: BigInt(10 * (i + 1)) })));
    const base = { root: expected, depth: 2, leafCount: 3, totalTickets: "60" };
    serve({
      "0": { ...base, leaves: leaves.slice(0, 2), nextIndex: 2 },
      "2": { ...base, leaves: leaves.slice(2), nextIndex: null },
    });
    expect(await loadSnapshot("http://api", "6")).toEqual({ ok: true, leafCount: 3, totalTickets: "60", served: expected, computed: expected });
  });

  it("shows a changed leaf as a root that differs from the backend's", async () => {
    const served = await sumTreeRoot(owners.map((o, i) => ({ wallet: o.toBytes(), tickets: BigInt(10 * (i + 1)) })));
    serve({ "0": { root: served, depth: 2, leafCount: 3, totalTickets: "60", leaves: leaves.map((l, i) => (i === 1 ? { ...l, tickets: "21" } : l)), nextIndex: null } });
    const result = await loadSnapshot("http://api", "6");
    expect(result).toMatchObject({ ok: true, served });
    expect(result.ok && rootVerdict({ computed: result.computed, served: result.served, chain: ROOT })).toBe("mismatch");
  });

  it("says so when the epoch has no snapshot", async () => {
    serve({});
    expect(await loadSnapshot("http://api", "99")).toEqual({ ok: false, reason: "That epoch has no snapshot yet." });
  });
});
