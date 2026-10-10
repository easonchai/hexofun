// Solami ticket 05: the subgraph client against a recording fake `fetch`. No
// live Solami call: Index is not enabled on the account (ticket 01).
import { describe, expect, it } from "vitest";

import { SubgraphClient } from "./subgraph";

const URL = "https://api.solami.dev/index/hexo/graphql";
const KEY = "secret-key-123";
const POOL = "Pool1111111111111111111111111111111111111111";

interface Call {
  url: string;
  init: RequestInit;
}

/** Answers each call with the next body in `bodies`, recording what was asked. */
function recordingFetch(bodies: unknown[], status = 200): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(bodies[calls.length - 1] ?? null), { status });
  }) as unknown as typeof fetch; // SAFETY: the client only passes a string url and an init.
  return { calls, fetch: fake };
}

const row = (id: string, slot: number, pools = [POOL]) => ({
  id,
  slot: String(slot),
  pools,
  logs: [`log ${id}`],
  truncated: false,
  failed: false,
});

describe("SubgraphClient", () => {
  it("reads the synced slot from the deployment record, with the bearer", async () => {
    const { calls, fetch } = recordingFetch([{ synced_slot: 455_279_220, status: "Live", id: "hexo" }]);
    const client = new SubgraphClient(URL, KEY, 1_000, fetch);
    expect(await client.syncedSlot()).toEqual({ slot: 455_279_220, live: true });
    expect(calls[0]?.url).toBe("https://api.solami.dev/index/hexo");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);

    const backfilling = recordingFetch([{ synced_slot: 10, status: "Backfilling" }]);
    expect(await new SubgraphClient(URL, KEY, 1_000, backfilling.fetch).syncedSlot()).toEqual({ slot: 10, live: false });
  });

  it("pages the transactions, keeps the pool's rows and sorts by slot then signature", async () => {
    const { calls, fetch } = recordingFetch([
      { data: { programTransactions: [row("b", 7), row("other", 7, ["SomeOtherPool"])] } },
      { data: { programTransactions: [row("a", 7)] } },
    ]);
    const client = new SubgraphClient(URL, KEY, 1_000, fetch);
    const rows = await client.transactionsSince(5n, POOL, 2);
    expect(rows.map((r) => [r.signature, r.slot])).toEqual([
      ["a", 7n],
      ["b", 7n],
    ]);
    expect(calls.map((c) => JSON.parse(String(c.init.body)).variables)).toEqual([
      { slot: "5", pool: POOL, first: 2, skip: 0 },
      { slot: "5", pool: POOL, first: 2, skip: 2 },
    ]);
    expect(calls[0]?.url).toBe(URL);
  });

  it("throws on GraphQL errors, a malformed row, a non-2xx and a timeout, with the URL and key scrubbed", async () => {
    const graphqlError = recordingFetch([{ errors: [{ message: `bad field near ${URL} ${KEY}` }] }]);
    await expect(new SubgraphClient(URL, KEY, 1_000, graphqlError.fetch).transactionsSince(0n, POOL)).rejects.toThrow(
      /^subgraph query: bad field near <subgraph> <subgraph>$/,
    );

    const malformed = recordingFetch([{ data: { programTransactions: [{ id: "x" }] } }]);
    await expect(new SubgraphClient(URL, KEY, 1_000, malformed.fetch).transactionsSince(0n, POOL)).rejects.toThrow(
      /a row is missing/,
    );

    const refused = recordingFetch([{}], 401);
    await expect(new SubgraphClient(URL, KEY, 1_000, refused.fetch).syncedSlot()).rejects.toThrow(
      /^subgraph status failed: answered 401$/,
    );

    const leaky = (async () => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${URL}?key=${KEY}`) });
    }) as unknown as typeof fetch;
    const error = await new SubgraphClient(URL, KEY, 1_000, leaky).syncedSlot().catch((e: unknown) => e);
    expect(String(error)).toBe("Error: subgraph status failed: fetch failed: connect ECONNREFUSED <subgraph>?key=<subgraph>");
    // No cause chain for a reporter to walk back to the raw text.
    expect((error as Error).cause).toBeUndefined();

    const silent = (() => new Promise<never>(() => {})) as unknown as typeof fetch;
    await expect(new SubgraphClient(URL, KEY, 20, silent).syncedSlot()).rejects.toThrow(/timed out after 20ms/);
  });
});
