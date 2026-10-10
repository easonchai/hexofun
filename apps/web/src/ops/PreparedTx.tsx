import { useState } from "react";

/** The base58 transaction Squads imports, with a Copy button. Remount it to reset "Copied". */
export function PreparedTx({
  title,
  base58,
  adminKey,
}: {
  title: string;
  base58: string;
  adminKey: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="ops-admin-prepared" data-testid="admin-prepared">
      <p className="ops-sync">
        {title}: unsigned legacy transaction, signer and fee payer {adminKey}. Paste it into Squads with
        Import base58 encoded tx. The blockhash expires in about a minute.
      </p>
      <textarea readOnly rows={5} value={base58} aria-label="Base58 transaction" />
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(base58).then(
            () => setCopied(true),
            () => setError("The browser blocked the clipboard. Select the text and copy it by hand."),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {error && (
        <p className="ops-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
