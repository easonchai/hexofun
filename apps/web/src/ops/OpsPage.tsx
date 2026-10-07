import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useState } from "react";

import { POOL_ID } from "../chain.js";
import { AdminPanel } from "./AdminPanel.js";
import { AlertsBanner } from "./AlertsBanner.js";
import { CranksPanel } from "./CranksPanel.js";
import { HeadlinePanel } from "./HeadlinePanel.js";
import { PausePanel } from "./PausePanel.js";
import { PoolPanel } from "./PoolPanel.js";
import { RateChartPanel } from "./RateChartPanel.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import { ROLE_LABEL, roleOf } from "./role.js";
import { Section, useStoredFlag } from "./ui.js";
import { useOps } from "./useOps.js";
import { VenuePanel } from "./VenuePanel.js";
import { VenueSwitchStepper } from "./VenueSwitchStepper.js";
import { YieldPanel } from "./YieldPanel.js";

/**
 * Layout only. Each panel is one file that reads `useOps()`. To add a panel,
 * create its file and add one line to the matching slot below. Order, top to
 * bottom: header, banner, headline, pauses, routine cranks, then Details and
 * Advanced collapsed.
 */
export function OpsPage() {
  const { error, summary } = useOps();
  const [raw, setRaw] = useStoredFlag("ops.showRaw");
  const [copied, setCopied] = useState<string | null>(null);
  const { publicKey } = useWallet();
  const role = roleOf(publicKey?.toBase58() ?? null, summary);

  const copyJson = () => {
    if (!summary) return;
    navigator.clipboard.writeText(JSON.stringify(summary, null, 2)).then(
      () => setCopied("Copied"),
      () => setCopied("The browser blocked the clipboard"),
    );
  };

  return (
    <main className="ops-page" data-raw={raw || undefined}>
      <header className="ops-header">
        <h1>Ops console, pool {POOL_ID.toString()}</h1>
        <div className="ops-header-tools">
          <label className="ops-toggle">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            Show raw
          </label>
          <button type="button" disabled={!summary} onClick={copyJson} onBlur={() => setCopied(null)}>
            {copied ?? "Copy JSON"}
          </button>
          {role && (
            <span className="ops-role" data-testid="ops-role">
              {ROLE_LABEL[role]}
            </span>
          )}
          <WalletMultiButton />
        </div>
      </header>
      <AlertsBanner />
      {error && (
        <p className="ops-error" role="status">
          Some reads failed ({error}). Showing the last good figures.
        </p>
      )}
      <HeadlinePanel />

      <PausePanel />
      <CranksPanel />

      <Section id="details" title="Details">
        <PoolPanel />
        <VenuePanel />
        <YieldPanel />
        <RateChartPanel />
      </Section>
      <Section id="advanced" title="Advanced">
        <AdminPanel />
        <RecoveryPanel />
        <VenueSwitchStepper />
      </Section>
    </main>
  );
}
