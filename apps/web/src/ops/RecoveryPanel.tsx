/**
 * The rare permissionless cranks that undo a stall or a loss: Cover deficit
 * and Roll over epoch. The bot never covers; it rolls over on its own
 * timeout, so these are for when that backstop has not fired.
 */
import { useEffect, useState } from "react";

import { formatAtomic } from "../lib/money.js";
import { labelEpochStatus } from "../lib/protocol.js";
import { TxStatus, useCrank } from "./crank.js";
import { stuckLine, usdc, USDC_DECIMALS } from "./format.js";
import { coverDeficit, loadEpochSeed, parseUsdcAmount, rolloverEpoch } from "./instructions.js";
import { Panel, Why, whyOff } from "./ui.js";
import { useOps } from "./useOps.js";

export function RecoveryPanel() {
  const { summary: s, pool: poolSummary } = useOps();
  const crank = useCrank();
  const { run, off } = crank;
  const [amount, setAmount] = useState("");

  const deficit = s && BigInt(s.deficit) > 0n ? s.deficit : null;
  useEffect(() => {
    if (deficit) setAmount((a) => (a === "" ? formatAtomic(BigInt(deficit), USDC_DECIMALS) : a));
  }, [deficit]);
  const parsed = parseUsdcAmount(amount);

  const stuckEpoch = s?.stuck?.epoch ?? null;
  const stuckUnknown = s === null || s.stuck === null;
  // When the stuck epoch could first have moved on: the end of the current or previous epoch.
  const epochEndedAt = (id: string): number | null => {
    const p = poolSummary?.pool;
    if (!p) return null;
    if (id === p.currentEpochId) return Number(p.currentEpochEndsAt);
    if (BigInt(id) + 1n === BigInt(p.currentEpochId)) return Number(p.previousEpochEndsAt);
    return null;
  };
  const rolloverWhy = stuckEpoch
    ? `Epoch ${stuckEpoch.id} ${stuckLine(labelEpochStatus(stuckEpoch.status), epochEndedAt(stuckEpoch.id))}.`
    : whyOff([stuckUnknown, "Cannot tell whether an epoch is stuck."], [true, "No stuck epoch."]);

  return (
    <Panel id="recovery" title="Recovery">
      <h3>Cover deficit</h3>
      <p className="ops-sync">Pays the recorded deficit from your wallet's USDC. Impaired clears when it reaches zero.</p>
      <label>
        Amount (USDC)
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </label>
      <div className="ops-actions">
        <button
          type="button"
          id="ops-action-cover"
          disabled={off || parsed === null || deficit === null}
          onClick={() =>
            parsed !== null && void run(async (p, pool, caller) => [await coverDeficit(p, pool, caller, parsed)])
          }
        >
          Cover deficit{deficit ? ` (${usdc(deficit)})` : ""}
        </button>
      </div>
      <Why
        reason={whyOff([deficit === null, "No deficit to cover."], [parsed === null, "Enter an amount in USDC."])}
      />

      <h3>Stuck epoch</h3>
      <div className="ops-actions">
        <button
          type="button"
          id="ops-action-rollover"
          disabled={off || !stuckEpoch}
          onClick={() =>
            stuckEpoch &&
            void run(async (p, pool, caller) => [
              await rolloverEpoch(p, pool, caller, await loadEpochSeed(p, BigInt(stuckEpoch.id))),
            ])
          }
        >
          Roll over epoch
        </button>
      </div>
      <Why reason={rolloverWhy} />

      <TxStatus crank={crank} />
    </Panel>
  );
}
