import { pct, UNAVAILABLE, usdc } from "./format.js";
import { Loading, Panel, Row, Switch, SyncLine } from "./ui.js";
import { useOps } from "./useOps.js";

export function PoolPanel() {
  const { summary: s, pool } = useOps();
  if (!s) {
    return (
      <Panel id="pool" title="Pool">
        <Loading />
      </Panel>
    );
  }
  const p = pool?.pool;
  const v = s.venueParams;
  const idle = s.freeIdle === null ? UNAVAILABLE : usdc(s.freeIdle);
  const idleNote =
    s.freeIdleBps === null
      ? undefined
      : `${pct(s.freeIdleBps)} of Principal${s.freeIdleBelowFloor ? ", below the floor" : ""}`;
  const band = v ? `floor ${pct(v.idleFloorBps)}, target ${pct(v.idleTargetBps)}` : UNAVAILABLE;
  // Null means the backend's chain read failed, which is unknown, not clean.
  const stuck = (item: { id: string; status: number } | null | undefined): string =>
    s.stuck === null ? UNAVAILABLE : item ? `#${item.id} (status ${item.status})` : "None";

  return (
    <Panel id="pool" title="Pool">
      <SyncLine lastSyncAt={s.lastSyncAt} />
      <dl>
        <Row label="Total Principal" value={usdc(s.totalPrincipal)} raw={s.totalPrincipal} />
        <Row label="Vault balance" value={usdc(s.vaultLiquidity)} raw={s.vaultLiquidity} />
        <Row label="Free idle" value={idle} {...(idleNote ? { note: idleNote } : {})} raw={s.freeIdle} />
        <Row label="Idle band" value={band} raw={v ? `${v.idleFloorBps} to ${v.idleTargetBps} bps` : null} />
        <Row label="Pending withdrawals" value={usdc(s.pendingWithdrawals)} raw={s.pendingWithdrawals} />
        <Row label="Solvency margin" value={usdc(s.solvencyMargin)} raw={s.solvencyMargin} />
        <Row label="Deficit" value={usdc(s.deficit)} raw={s.deficit} />
        <Row label="Impaired" value={s.impaired ? "Yes" : "No"} />
        <Switch label="Pool" on={p ? p.paused : null} />
        <Switch label="Game" on={p ? p.gamePaused : null} />
        <Switch label="Jackpot" on={p ? p.jackpotPaused : null} />
        <Switch label="Deployment" on={s.deployPaused} />
        <Switch label="Bought tickets" on={pool ? pool.live.buyTicketsPaused : null} />
        <Row label="Shutdown" value={s.shutdown ? "Yes, permanent" : "No"} />
        <Row label="Stuck Round" value={stuck(s.stuck?.round)} />
        <Row label="Stuck epoch" value={stuck(s.stuck?.epoch)} />
      </dl>
    </Panel>
  );
}
