import { useState } from "react";

import { accountOf, API_URL, epochAddress, POOL_ID, poolAddress } from "../chain.js";
import { Panel, Row } from "./ui.js";
import { chainRootHex, loadSnapshot, rootVerdict, type RootVerdict, type Roots } from "./snapshot.js";
import { useOps } from "./useOps.js";
import { useSendTx } from "./tx.js";

import "./admin.css";

const VERDICT_TEXT: Record<RootVerdict, string> = {
  match: "Match. The leaves hash to the root on the chain.",
  mismatch: "Mismatch. The leaves, the backend and the chain do not agree on the root.",
  uncommitted: "Not committed yet. The chain holds no root until request_draw runs.",
  empty: "Empty snapshot. Nobody held Tickets, so there is no root.",
};

interface Checked {
  epochId: string;
  leafCount: number;
  totalTickets: string;
  roots: Roots;
}

/**
 * The first check for a `SNAPSHOT_MISMATCH` alert: hashes the epoch's served
 * leaves here, in the browser, and sets that root beside the backend's and the
 * Epoch account's `snapshot_root`.
 */
export function SnapshotPanel() {
  const { pool } = useOps();
  const { program } = useSendTx();
  const latest = pool ? (BigInt(pool.pool.currentEpochId) - 1n).toString() : "";
  const [typed, setTyped] = useState<string | null>(null);
  const epochId = typed ?? latest;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);

  const check = async (): Promise<void> => {
    if (!/^\d+$/.test(epochId)) return setError("Epoch must be a whole number.");
    setBusy(true);
    setError(null);
    setChecked(null);
    const [snapshot, chain] = await Promise.all([
      loadSnapshot(API_URL, epochId),
      accountOf(program, "epoch")
        .fetch(epochAddress(poolAddress(POOL_ID), BigInt(epochId)))
        .then((raw) => ({ ok: true as const, root: chainRootHex((raw as Record<string, unknown>).snapshotRoot) })) // SAFETY: Anchor decodes the Epoch account to an object keyed by the IDL's camelCase field names.
        .catch((cause: unknown) => ({ ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) })),
    ]);
    setBusy(false);
    if (!snapshot.ok) return setError(`Backend: ${snapshot.reason}`);
    if (!chain.ok) return setError(`Chain: ${chain.reason}`);
    setChecked({
      epochId,
      leafCount: snapshot.leafCount,
      totalTickets: snapshot.totalTickets,
      roots: { computed: snapshot.computed, served: snapshot.served, chain: chain.root },
    });
  };

  const verdict = checked ? rootVerdict(checked.roots) : null;
  return (
    <Panel id="snapshot" title="Epoch snapshot">
      <p className="ops-sync">Hashes the served leaves in this browser and compares the root with the chain's.</p>
      <form
        className="ops-admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <div className="ops-admin-fields">
          <label>
            Epoch
            <input data-testid="snapshot-epoch" inputMode="numeric" value={epochId} onChange={(e) => setTyped(e.target.value.trim())} />
          </label>
        </div>
        <button type="submit" data-testid="snapshot-check" disabled={busy || epochId === ""}>
          {busy ? "Checking" : "Check root"}
        </button>
      </form>
      {error && (
        <p className="ops-error" role="alert" data-testid="snapshot-error">
          {error}
        </p>
      )}
      {checked && verdict && (
        <>
          <dl>
            <Row label="Leaves" value={checked.leafCount.toString()} />
            <Row label="Total Tickets" value={checked.totalTickets} />
            <Row label="Computed here" value={checked.roots.computed ?? "none"} />
            <Row label="Backend" value={checked.roots.served ?? "none"} />
            <Row label="Chain snapshot_root" value={checked.roots.chain} />
          </dl>
          <p className="ops-verdict" data-testid="snapshot-verdict" data-verdict={verdict}>
            Epoch {checked.epochId}: {VERDICT_TEXT[verdict]}
          </p>
        </>
      )}
    </Panel>
  );
}
