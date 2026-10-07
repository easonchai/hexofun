/**
 * The venue switch as runbook.md's eight "Migration" steps, the current one
 * marked. CLI steps name the command; page steps carry their control inline
 * (Drain, Migrate) or jump to it (Set venue params, the Deployment switch).
 */
import { useEffect, useState } from "react";

import { POOL_ID } from "../chain.js";
import { formatAtomic } from "../lib/money.js";
import { TxStatus, useCrank, wrap } from "./crank.js";
import { usdc, USDC_DECIMALS } from "./format.js";
import { drainVenue, migrateVenue, parseUsdcAmount } from "./instructions.js";
import { drainConfirm, migrateConfirm } from "./opsCopy.js";
import { dueFor, goToAction } from "./opsMap.js";
import { Panel, useNow } from "./ui.js";
import { useOps } from "./useOps.js";
import { drainAccess, migrateAccess, proposalView, venueStep } from "./venueProposal.js";

const STEPS = [
  "Prepare the target",
  "Propose",
  "Lower the dust line",
  "Wait out the lock",
  "Drain",
  "Migrate",
  "Resume deploys",
  "Restore the dust line",
] as const;

const CLI = "pnpm --filter @hexvault/backend admin";

export function VenueSwitchStepper() {
  const { summary: s } = useOps();
  const now = useNow();
  const crank = useCrank();
  const { tx, run, off } = crank;
  const [amount, setAmount] = useState("");

  const drainDue = dueFor(s?.todo ?? [], "venueSwitch")?.amount;
  useEffect(() => {
    if (drainDue) setAmount((a) => (a === "" ? formatAtomic(BigInt(drainDue), USDC_DECIMALS) : a));
  }, [drainDue]);

  const parsed = parseUsdcAmount(amount);
  const current = s ? venueStep(s, now) : null;
  const view = s ? proposalView(s, now) : null;
  const drain = s ? drainAccess(s, tx.publicKey?.toBase58() ?? null) : null;
  const migrate = s ? migrateAccess(s, now) : null;
  const pool = POOL_ID.toString();

  const body = (n: number) => {
    switch (n) {
      case 1:
        return <p className="ops-sync">CLI. For a kVault, create the pool's shares account first: spl-token create-account.</p>;
      case 2:
        return <p className="ops-sync">CLI, Admin: {CLI} propose-venue --kind ... The lock is 48 hours and a second proposal restarts it.</p>;
      case 3:
      case 8:
        return (
          <p className="ops-sync">
            Set venue params, Minimum venue move to {n === 3 ? "10000" : "100000000"}.{" "}
            <button type="button" className="ops-link" onClick={() => goToAction("setVenueParams")}>
              Go to the form
            </button>
          </p>
        );
      case 4:
        return (
          <p className="ops-sync">
            Wait. {view?.state === "locked" ? `The lock ends ${view.unlock}.` : ""} If the target turns bad, CLI: {CLI}{" "}
            cancel-venue.
          </p>
        );
      case 5:
        return (
          <>
            <p className="ops-sync">Old venue holds {usdc(s?.venueValue)}. Drain until it is at or under the dust line.</p>
            <label>
              Amount (USDC)
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </label>
            <div className="ops-actions">
              <button
                type="button"
                data-testid="crank-drain"
                disabled={off || parsed === null || drain?.allowed !== true}
                onClick={() =>
                  parsed !== null &&
                  window.confirm(drainConfirm(`${amount} USDC`, pool)) &&
                  void run(async (p, poolState, caller) => [await drainVenue(p, poolState, caller, parsed)])
                }
              >
                Drain venue
              </button>
            </div>
            {drain && !drain.allowed && (
              <p className="ops-sync ops-why" data-testid="crank-drain-why">
                Drain venue is off. {drain.reason}
              </p>
            )}
          </>
        );
      case 6:
        return (
          <>
            <div className="ops-actions">
              <button
                type="button"
                data-testid="crank-migrate"
                disabled={off || migrate?.allowed !== true}
                onClick={() =>
                  window.confirm(migrateConfirm(view && "kind" in view ? view.kind : "proposed", pool)) &&
                  void run(wrap(migrateVenue))
                }
              >
                Migrate venue
              </button>
            </div>
            {migrate && !migrate.allowed && (
              <p className="ops-sync ops-why" data-testid="crank-migrate-why">
                Migrate venue is off. {migrate.reason}
              </p>
            )}
          </>
        );
      case 7:
        return (
          <p className="ops-sync">
            Start deployment, Admin only.{" "}
            <button type="button" className="ops-link" onClick={() => goToAction("pause-deploy")}>
              Go to the switch
            </button>
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <Panel id="venue-switch" title="Venue switch">
      <div id="ops-action-venueSwitch" tabIndex={-1}>
        <p className="ops-sync">
          {current === null
            ? "Cannot tell which step the pool is on."
            : current === 1
              ? "No switch in progress. It starts in the CLI."
              : `On step ${current}: ${STEPS[current - 1]}.`}
        </p>
        <ol className="ops-steps">
          {STEPS.map((title, i) => {
            const n = i + 1;
            return (
              <li key={title} data-current={n === current || undefined} data-done={(current ?? 0) > n || undefined}>
                <strong>{title}</strong>
                {body(n)}
              </li>
            );
          })}
        </ol>
        <TxStatus crank={crank} />
      </div>
    </Panel>
  );
}
