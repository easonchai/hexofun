import { ago, closesIn, idleLine, UNAVAILABLE, usdcShort } from "./format.js";
import { Row, useNow } from "./ui.js";
import { useOps } from "./useOps.js";

/** Six figures that say what the pool holds and how live the data is. */
export function HeadlinePanel() {
  const { summary: s, pool } = useOps();
  const now = useNow();
  const tickIso = s?.operator?.lastTickAt ?? null;
  const tickAt = tickIso === null ? null : Date.parse(tickIso) / 1000;
  const endsAt = pool ? Number(pool.pool.currentEpochEndsAt) : null;
  const jackpot = pool?.currentEpoch?.jackpotAmount ?? null;

  return (
    <dl className="ops-headline" data-testid="ops-headline">
      <Row label="Principal" value={s ? usdcShort(s.totalPrincipal) : UNAVAILABLE} raw={s?.totalPrincipal} />
      <Row
        label="Free idle"
        value={s ? idleLine(s.freeIdle, s.freeIdleBps, s.venueParams) : UNAVAILABLE}
        raw={s?.freeIdleBps == null ? s?.freeIdle : `${s.freeIdle} (${s.freeIdleBps} bps)`}
      />
      <Row label="Solvency margin" value={s ? usdcShort(s.solvencyMargin) : UNAVAILABLE} raw={s?.solvencyMargin} />
      <Row
        label="Operator last tick"
        value={tickAt === null || Number.isNaN(tickAt) ? UNAVAILABLE : ago(tickAt, now)}
        raw={tickIso}
      />
      <Row
        label="Epoch"
        value={endsAt === null || endsAt <= 0 ? UNAVAILABLE : closesIn(endsAt, now)}
        raw={pool?.pool.currentEpochEndsAt}
      />
      <Row label="Jackpot" value={usdcShort(jackpot)} raw={jackpot} />
    </dl>
  );
}
