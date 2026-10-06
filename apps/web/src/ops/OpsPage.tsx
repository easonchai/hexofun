import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { POOL_ID } from "../chain.js";
import { AlertsBanner } from "./AlertsBanner.js";
import { CranksPanel } from "./CranksPanel.js";
import { FastPausePanel } from "./FastPausePanel.js";
import { PoolPanel } from "./PoolPanel.js";
import { RateChartPanel } from "./RateChartPanel.js";
import { useOps } from "./useOps.js";
import { VenuePanel } from "./VenuePanel.js";
import { YieldPanel } from "./YieldPanel.js";

/**
 * Layout only. Each panel is one file that reads `useOps()`. To add a panel,
 * create its file and add one line to the matching slot below.
 */
export function OpsPage() {
  const { error } = useOps();
  return (
    <main className="ops-page">
      <header className="ops-header">
        <h1>Ops console, pool {POOL_ID.toString()}</h1>
        <WalletMultiButton />
      </header>
      <AlertsBanner />
      {error && (
        <p className="ops-error" role="status">
          Some reads failed ({error}). Showing the last good figures.
        </p>
      )}

      <FastPausePanel />

      <div className="ops-grid">
        <PoolPanel />
        <VenuePanel />
        <YieldPanel />
        <RateChartPanel />
        <CranksPanel />
        {/* Slot, ticket 05: <AdminPanel /> (pause switches, parameter forms, Squads paste). */}
      </div>
    </main>
  );
}
