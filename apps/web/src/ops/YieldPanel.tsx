import { pct, usdc } from "./format.js";
import { Loading, Panel, Row, SyncLine } from "./ui.js";
import { useOps } from "./useOps.js";

export function YieldPanel() {
  const { summary: s, pool } = useOps();
  if (!s) {
    return (
      <Panel id="yield" title="Yield">
        <Loading />
      </Panel>
    );
  }
  const rates = pool?.live.rates;
  return (
    <Panel id="yield" title="Yield">
      <SyncLine lastSyncAt={s.lastSyncAt} />
      <dl>
        <Row label="Yield fee owed" value={usdc(s.feeOwed)} note="to the Treasury at next Harvest" />
        <Row label="Prize share owed" value={usdc(s.prizeOwed)} note="to the jackpot at next Harvest" />
        <Row label="Sent to the Treasury, lifetime" value={usdc(s.harvestedToTreasury)} />
        <Row label="Sent to the jackpot vault, lifetime" value={usdc(s.harvestedToJackpot)} />
        <Row label="Paid rate, 24 hours" value={pct(rates?.trailing24h.aprBps)} note="APR" />
        <Row label="Paid rate, 7 days" value={pct(rates?.trailing7d.aprBps)} note="APR" />
        <Row label="Ceiling" value={pct(rates?.ceilingBps)} note="APR" />
      </dl>
    </Panel>
  );
}
