import { deployedBps, pct, usdc } from "./format.js";
import { Loading, Panel, Row, SyncLine } from "./ui.js";
import { useOps } from "./useOps.js";

export function VenuePanel() {
  const { summary: s } = useOps();
  if (!s) {
    return (
      <Panel id="venue" title="Venue">
        <Loading />
      </Panel>
    );
  }
  return (
    <Panel id="venue" title="Venue">
      <SyncLine lastSyncAt={s.lastSyncAt} />
      <dl>
        <Row label="Position value" value={usdc(s.venueValue)} />
        <Row label="Share of pool deployed" value={pct(deployedBps(s.venueValue, s.vaultLiquidity))} />
        <Row label="Reserve utilisation" value={pct(s.reserveUtilizationBps)} />
        <Row label="Reserve free liquidity" value={usdc(s.reserveFreeLiquidity)} />
        <Row label="Supply rate" value={pct(s.supplyRateBps)} note="APR, read live" />
      </dl>
    </Panel>
  );
}
