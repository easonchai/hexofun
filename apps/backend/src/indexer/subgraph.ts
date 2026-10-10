// Solami ticket 05: the hexo subgraph as a catch-up source. It stores every
// program transaction with its raw log lines, so the Indexer's catch-up can
// read a backlog in one query instead of one `getTransaction` per signature.
// The Indexer still decodes the logs itself (spec "One decoder").
import { ConfigService } from "@nestjs/config";

import { withTimeout } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";

// The GraphQL dialect is unconfirmed (ticket 01 Findings), so this is The
// Graph's shape. `pnpm --filter @hexvault/backend subgraph:schema` lists the
// live root fields and their arguments; a dialect change is an edit here only.
const ROOT = "programTransactions";
const TRANSACTIONS_QUERY = `query ($slot: BigInt!, $pool: String!, $first: Int!, $skip: Int!) {
  ${ROOT}(first: $first, skip: $skip, where: { slot_gte: $slot, pools_contains: [$pool] }, orderBy: slot, orderDirection: asc) {
    id slot pools logs truncated failed
  }
}`;
export const SCHEMA_QUERY = "{ __schema { queryType { fields { name args { name } } } } }";
/** The deployment record's `status` once backfill is done and it keeps pace. */
const LIVE = "Live";
const PAGE_SIZE = 1_000;

/** Nest token for the subgraph client, or null when it is not configured. */
export const SUBGRAPH_CLIENT = Symbol("SUBGRAPH_CLIENT");

/** One `ProgramTransaction` row that touched the asked-for pool. */
export interface SubgraphTransaction {
  signature: string;
  slot: bigint;
  logs: string[];
  truncated: boolean;
  failed: boolean;
}

/** What the Indexer and `/status` read. Tests swap in a fake. */
export interface SubgraphSource {
  /** `synced_slot` and whether `status` is `Live`, from `GET /index/<id>`. */
  syncedSlot(): Promise<{ slot: number; live: boolean }>;
  /** Rows at or after `slot` whose `pools` hold `pool`, slot ascending then signature. */
  transactionsSince(slot: bigint, pool: string, pageSize?: number): Promise<SubgraphTransaction[]>;
}

export class SubgraphClient implements SubgraphSource {
  private readonly statusUrl: string;

  constructor(
    /** The GraphQL endpoint, `https://<host>/index/<id>/graphql`. */
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const status = new URL(url);
    status.pathname = status.pathname.replace(/\/graphql$/, "");
    this.statusUrl = status.toString();
  }

  async syncedSlot(): Promise<{ slot: number; live: boolean }> {
    const body = await this.request("subgraph status", this.statusUrl, { method: "GET" });
    const slot = isRecord(body) ? body.synced_slot : undefined;
    const status = isRecord(body) ? body.status : undefined;
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0 || typeof status !== "string") {
      throw new Error("subgraph status: no synced_slot and status in the response");
    }
    return { slot, live: status === LIVE };
  }

  // shortcut: `skip` paging, which The Graph caps at 5,000. A longer backlog
  // fails the query and that tick runs the RPC walk; switch to keyset paging
  // once the live dialect is known.
  async transactionsSince(slot: bigint, pool: string, pageSize = PAGE_SIZE): Promise<SubgraphTransaction[]> {
    const rows = new Map<string, SubgraphTransaction>();
    for (let skip = 0; ; skip += pageSize) {
      const data = await this.query(TRANSACTIONS_QUERY, { slot: slot.toString(), pool, first: pageSize, skip });
      const page = isRecord(data) ? data[ROOT] : undefined;
      if (!Array.isArray(page)) throw new Error(`subgraph query: no ${ROOT} in the response`);
      for (const raw of page) {
        const row = parseRow(raw);
        if (row.pools.includes(pool)) {
          rows.set(row.signature, {
            signature: row.signature,
            slot: row.slot,
            logs: row.logs,
            truncated: row.truncated,
            failed: row.failed,
          });
        }
      }
      if (page.length < pageSize) break;
    }
    return [...rows.values()].sort((a, b) =>
      a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0,
    );
  }

  /** One GraphQL request; `data` from the response, or a throw on `errors`. */
  async query(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    const body = await this.request("subgraph query", this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!isRecord(body)) throw new Error("subgraph query: the response is not an object");
    const errors = body.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first: unknown = errors[0];
      const message = isRecord(first) && typeof first.message === "string" ? first.message : "unknown error";
      throw this.scrub(`subgraph query: ${message}`);
    }
    return body.data;
  }

  /** Every request carries the bearer and the `RPC_TIMEOUT_MS` bound, and a
   *  failure leaves here with the URL and key scrubbed. */
  private async request(label: string, url: string, init: RequestInit): Promise<unknown> {
    try {
      return await withTimeout(
        (async () => {
          const response = await this.fetchImpl(url, {
            ...init,
            headers: { ...init.headers, authorization: `Bearer ${this.apiKey}` },
          });
          if (!response.ok) throw new Error(`answered ${response.status}`);
          return (await response.json()) as unknown;
        })(),
        this.timeoutMs,
        label,
      );
    } catch (cause) {
      // undici's "fetch failed" says why only in its own cause.
      const inner = cause instanceof Error && cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
      throw this.scrub(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}${inner}`);
    }
  }

  /** rpc-fallback.ts's split-and-join redaction, but with no `cause`: the
   *  raw error (undici's names the host) must not reach a reporter that walks
   *  the chain (docs/standards/ops.md "Secrets"). Longest first, since the
   *  status URL is a prefix of the query URL. */
  private scrub(message: string): Error {
    let text = message;
    for (const secret of [this.url, this.statusUrl, this.apiKey]) text = text.split(secret).join("<subgraph>");
    return new Error(text);
  }
}

/** Unset (either var missing) is null: catch-up stays on the RPC walk. */
export const subgraphProvider = {
  provide: SUBGRAPH_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<HexVaultEnv, true>): SubgraphSource | null => {
    const url = config.get("SUBGRAPH_URL", { infer: true });
    const apiKey = config.get("SUBGRAPH_API_KEY", { infer: true });
    if (!url || !apiKey) return null;
    return new SubgraphClient(url, apiKey, config.get("RPC_TIMEOUT_MS", { infer: true }));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One row as the subgraph serves it. `slot` is a GraphQL BigInt, a string. */
function parseRow(raw: unknown): SubgraphTransaction & { pools: string[] } {
  const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (
    isRecord(raw) &&
    typeof raw.id === "string" &&
    (typeof raw.slot === "string" || typeof raw.slot === "number") &&
    /^\d+$/.test(String(raw.slot)) &&
    isStrings(raw.pools) &&
    isStrings(raw.logs) &&
    typeof raw.truncated === "boolean" &&
    typeof raw.failed === "boolean"
  ) {
    return {
      signature: raw.id,
      slot: BigInt(raw.slot),
      pools: raw.pools,
      logs: raw.logs,
      truncated: raw.truncated,
      failed: raw.failed,
    };
  }
  throw new Error("subgraph query: a row is missing id, slot, pools, logs, truncated or failed");
}
