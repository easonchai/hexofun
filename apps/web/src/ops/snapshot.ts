/**
 * The snapshot view's logic (off-chain-tickets ticket 25): read every page the
 * backend serves, hash the leaves into a root, and compare it with the root the
 * backend states and the one the Epoch account holds.
 */
import { PublicKey } from "@solana/web3.js";

import { fetchEpochSnapshot } from "../api.js";
import { sumTreeRoot, toHex } from "./sumTree.js";

/**
 * `match` is the only green. `mismatch` is red: the leaves do not hash to the
 * root the backend states, or the chain holds a different one. `uncommitted`
 * means `request_draw` has not run yet (the chain root is all zeros), and
 * `empty` an epoch nobody held Tickets in.
 */
export type RootVerdict = "match" | "mismatch" | "uncommitted" | "empty";

export interface Roots {
  /** Hashed here from the served leaves; null with no leaves. */
  computed: string | null;
  /** The root the backend states for the epoch; null when empty. */
  served: string | null;
  /** The Epoch account's `snapshot_root`; 64 zeros until `request_draw` commits. */
  chain: string;
}

export function rootVerdict({ computed, served, chain }: Roots): RootVerdict {
  if (computed !== served) return "mismatch";
  if (/^0+$/.test(chain)) return computed === null ? "empty" : "uncommitted";
  return computed === chain ? "match" : "mismatch";
}

/** The Epoch account's `snapshotRoot` as the Anchor client decodes it (a byte array), in hex. */
export function chainRootHex(raw: unknown): string {
  const bytes = Array.isArray(raw) || raw instanceof Uint8Array ? Uint8Array.from(raw) : null;
  if (bytes === null || bytes.length !== 32) throw new Error("The Epoch account has no 32-byte snapshot_root. Is the IDL current?");
  return toHex(bytes);
}

export type SnapshotLoad =
  | { ok: true; leafCount: number; totalTickets: string; served: string | null; computed: string | null }
  | { ok: false; reason: string };

/** Pages through `GET /epochs/:id/snapshot` and hashes the leaves. Never throws. */
export async function loadSnapshot(baseUrl: string, epochId: string, signal?: AbortSignal): Promise<SnapshotLoad> {
  try {
    const leaves: { wallet: Uint8Array; tickets: bigint }[] = [];
    let after: number | null = 0;
    let first: { root: string | null; leafCount: number; totalTickets: string } | null = null;
    while (after !== null) {
      const page = await fetchEpochSnapshot(baseUrl, epochId, after, signal);
      if (!page.ok) return { ok: false, reason: page.reason === "HTTP 404" ? "That epoch has no snapshot yet." : page.reason };
      first ??= page.data;
      for (const leaf of page.data.leaves) leaves.push({ wallet: new PublicKey(leaf.owner).toBytes(), tickets: BigInt(leaf.tickets) });
      after = page.data.nextIndex;
    }
    if (first === null || leaves.length !== first.leafCount) {
      return { ok: false, reason: `The backend served ${leaves.length} leaves for a snapshot of ${first?.leafCount ?? 0}.` };
    }
    return { ok: true, leafCount: first.leafCount, totalTickets: first.totalTickets, served: first.root, computed: await sumTreeRoot(leaves) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
