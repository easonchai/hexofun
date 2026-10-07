import { deployedBps, pct, UNAVAILABLE, usdc } from "./format.js";
import { Loading, Panel, Row, SyncLine, useNow } from "./ui.js";
import { useOps } from "./useOps.js";
import { proposalView, venueKindName } from "./venueProposal.js";

export function VenuePanel() {
  const { summary: s } = useOps();
  const now = useNow();
  if (!s) {
    return (
      <Panel id="venue" title="Venue">
        <Loading />
      </Panel>
    );
  }
  const proposal = proposalView(s, now);
  return (
    <Panel id="venue" title="Venue">
      <SyncLine lastSyncAt={s.lastSyncAt} />
      <dl>
        <Row label="Position value" value={usdc(s.venueValue)} />
        <Row label="Share of pool deployed" value={pct(deployedBps(s.venueValue, s.vaultLiquidity))} />
        <Row label="Reserve utilisation" value={pct(s.reserveUtilizationBps)} />
        <Row label="Reserve free liquidity" value={usdc(s.reserveFreeLiquidity)} />
        <Row label="Supply rate" value={pct(s.supplyRateBps)} note="APR, read live" />
        <Row label="Venue kind" value={venueKindName(s.venueKind)} />
        {proposal.state === "unavailable" && <Row label="Venue proposal" value={UNAVAILABLE} />}
        {proposal.state === "none" && <Row label="Venue proposal" value="None" />}
        {(proposal.state === "locked" || proposal.state === "unlocked") && (
          <>
            <Row
              label="Venue proposal"
              value={proposal.state === "locked" ? "Open, locked" : "Open, lock elapsed"}
              note="deploys are refused while it stands"
            />
            <Row label="Proposed kind" value={proposal.kind} />
            <Row label="Proposed reserve" value={proposal.reserve} />
            <Row label="Unlocks" value={proposal.unlock} note={proposal.unlocksAt} />
          </>
        )}
      </dl>
    </Panel>
  );
}
