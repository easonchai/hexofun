import { utils as anchorUtils } from "@anchor-lang/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";

import { API_URL, POOL_ID, poolAddress } from "../chain.js";
import { classifyGrantError, GRANT_REASON_MAX, parseGrantForm, submitGrant, type GrantRow } from "./grants.js";
import { Panel } from "./ui.js";

import "./admin.css";

/**
 * The manual grant form: signs one grant with the connected team wallet and
 * shows the ledger row the backend stored. Uncapped, House included.
 */
export function GrantsPanel() {
  const { publicKey, signMessage } = useWallet();
  const [values, setValues] = useState({ wallet: "", amount: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GrantRow | null>(null);

  const submit = async (): Promise<void> => {
    if (!publicKey || !signMessage) return;
    setError(null);
    setDone(null);
    const parsed = parseGrantForm(values);
    if (!parsed.ok) return setError(parsed.error);
    setBusy(true);
    const result = await submitGrant({
      baseUrl: API_URL,
      pool: poolAddress(POOL_ID).toBase58(),
      signer: publicKey.toBase58(),
      wallet: parsed.wallet,
      amount: parsed.amount,
      reason: parsed.reason,
      signMessage,
      encodeSignature: anchorUtils.bytes.bs58.encode,
      nowSeconds: Date.now() / 1000,
    });
    setBusy(false);
    if (result.ok) {
      setDone(result.row);
      setValues({ ...values, amount: "", reason: "" });
    } else {
      setError(classifyGrantError(result.status, result.code, result.reason));
    }
  };

  const off = !publicKey
    ? "Connect a team wallet to grant Tickets."
    : !signMessage
      ? "This wallet cannot sign messages. Use a software wallet."
      : null;

  return (
    <Panel id="grants" title="Grant Tickets">
      <p className="ops-sync">
        Books a grant_admin row with your signature on it. Not capped.
      </p>
      <form
        className="ops-admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="ops-admin-fields">
          <label>
            Wallet
            <input data-testid="grant-wallet" value={values.wallet} onChange={(e) => setValues({ ...values, wallet: e.target.value })} />
          </label>
          <label>
            Amount (Tickets)
            <input
              data-testid="grant-amount"
              inputMode="numeric"
              value={values.amount}
              onChange={(e) => setValues({ ...values, amount: e.target.value })}
            />
          </label>
          <label>
            Reason (up to {GRANT_REASON_MAX} characters)
            <input
              data-testid="grant-reason"
              maxLength={GRANT_REASON_MAX}
              value={values.reason}
              onChange={(e) => setValues({ ...values, reason: e.target.value })}
            />
          </label>
        </div>
        <button type="submit" data-testid="grant-submit" disabled={busy || off !== null}>
          Sign and grant
        </button>
        {off && <p className="ops-sync">{off}</p>}
      </form>
      {error && (
        <p className="ops-error" role="alert" data-testid="grant-error">
          {error}
        </p>
      )}
      {done && (
        <p className="ops-sync" role="status" data-testid="grant-done">
          Booked ledger row {done.id}: {done.delta} Tickets to {done.owner}, reason "{done.ref}", signed by {done.signer}.
        </p>
      )}
    </Panel>
  );
}
