import { useState } from "react";

import { fetchLedger, type LedgerRowDto } from "../api.js";
import { API_URL } from "../chain.js";
import { Panel } from "./ui.js";

import "./admin.css";

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The Ticket ledger for one wallet, newest first, 100 rows a page. */
export function LedgerPanel() {
  const [wallet, setWallet] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRowDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (owner: string, before: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await fetchLedger(API_URL, owner, before);
    setBusy(false);
    if (!result.ok) return setError(result.reason);
    setShown(owner);
    setRows((old) => (before === null ? result.data.rows : [...old, ...result.data.rows]));
    setNext(result.data.nextBefore);
  };

  const start = (): void => {
    const owner = wallet.trim();
    if (!WALLET.test(owner)) return setError("Wallet must be a Solana address.");
    void load(owner, null);
  };

  return (
    <Panel id="ledger" title="Wallet ledger">
      <form
        className="ops-admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="ops-admin-fields">
          <label>
            Wallet
            <input data-testid="ledger-wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} />
          </label>
        </div>
        <button type="submit" data-testid="ledger-load" disabled={busy}>
          Show ledger
        </button>
      </form>
      {error && (
        <p className="ops-error" role="alert" data-testid="ledger-error">
          {error}
        </p>
      )}
      {shown && (
        <>
          <p className="ops-sync" data-testid="ledger-count">
            {rows.length} rows loaded for {shown}
            {next === null ? ", the whole ledger." : "."}
          </p>
          <table className="ops-admin-diff" data-testid="ledger-rows">
            <thead>
              <tr>
                <th>Epoch</th>
                <th>Reason</th>
                <th>Delta</th>
                <th>Ref</th>
                <th>Signer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.epochId}</td>
                  <td>{row.reason}</td>
                  <td>{row.delta}</td>
                  <td>{row.ref}</td>
                  <td>{row.signer ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next !== null && (
            <button type="button" data-testid="ledger-more" disabled={busy} onClick={() => void load(shown, next)}>
              Load 100 more
            </button>
          )}
        </>
      )}
    </Panel>
  );
}
