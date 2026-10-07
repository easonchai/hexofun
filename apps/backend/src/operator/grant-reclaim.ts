import type { Connection } from "@solana/web3.js";

/** A blockhash lives about a minute; this is past it with room to spare. */
export const GRANT_RECLAIM_WINDOW_MS = 120_000;

/** Mainnet-readiness-fixes 07: the marker the tick writes when the program refuses a repeat grant. */
export const ALREADY_GRANTED_MARKER = "already-granted";

export interface GrantReclaimState {
  /** First time this process saw each unconfirmed signature. In memory: a
   *  restart restarts the window, which only delays a resend. */
  firstSeen: Map<string, number>;
  /** Signatures seen confirmed, so they are not asked about again. */
  confirmed: Set<string>;
}

/**
 * `send` records a grant's signature when the transaction is on the wire, so
 * a timeout with a live blockhash cannot cause a resend. If that transaction
 * then never lands, the row would keep the signature and the referrer would
 * never be granted. This asks the cluster about every recorded signature and
 * clears the ones that failed, or that it still does not know after
 * `GRANT_RECLAIM_WINDOW_MS`, so the rows are due again. A landed one stays.
 *
 * ponytail: one `getSignatureStatuses` call, so 256 signatures (2,048
 * referrers at 8 per batch) is the ceiling; chunk it if an epoch ever has more.
 */
export async function reclaimUnlandedGrants(args: {
  rows: { referrer: string; txSig: string }[];
  connection: Pick<Connection, "getSignatureStatuses">;
  clear: (referrers: string[]) => Promise<void>;
  state: GrantReclaimState;
  now: number;
}): Promise<void> {
  const { rows, connection, clear, state, now } = args;
  const open = rows.filter(
    (row) => row.txSig !== ALREADY_GRANTED_MARKER && !state.confirmed.has(row.txSig),
  );
  const sigs = [...new Set(open.map((row) => row.txSig))];
  if (sigs.length === 0) return;
  const { value } = await connection.getSignatureStatuses(sigs, {
    searchTransactionHistory: true,
  });
  const dropped = new Set<string>();
  sigs.forEach((sig, i) => {
    const status = value[i];
    if (status && !status.err) {
      state.confirmed.add(sig);
      state.firstSeen.delete(sig);
      return;
    }
    const first = state.firstSeen.get(sig) ?? now;
    state.firstSeen.set(sig, first);
    // Landed with an error: nothing was granted. Unknown: wait out the blockhash.
    if (status?.err || now - first >= GRANT_RECLAIM_WINDOW_MS) {
      dropped.add(sig);
      state.firstSeen.delete(sig);
    }
  });
  const referrers = open.filter((row) => dropped.has(row.txSig)).map((row) => row.referrer);
  if (referrers.length > 0) await clear(referrers);
}
