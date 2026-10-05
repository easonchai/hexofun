/**
 * The vault's earning balance and rate (yield-claimer ticket 15): Principal
 * plus unsettled yield as one figure that ticks at the pool's estimated rate,
 * with "up to X%" and the 7-day paid rate beside it. Rows reuse the vault
 * widget's `vault-line` styling. Reads the Read model only (ADR 0008).
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PublicKey } from "@solana/web3.js";

import { apiBaseUrl, fetchPlayer } from "./api.js";
import { InfoTip } from "./InfoTip.js";
import { formatAtomic, formatAtomic2 } from "./lib/money.js";
import { useApiPoll } from "./useApiPoll.js";
import { useLivePool, useTickingBalance } from "./useLiveYield.js";
import { rateCopy } from "./yieldTick.js";

const DECIMALS = 6;

const RATE_TIP = [
  "Your balance earns what the venue pays after the pool's fee, up to this ceiling. The 7-day figure is what the pool actually paid. No rate is promised.",
];

/** "1,002.136986" while ticking so the motion shows, "1,002.13" otherwise. */
function money(value: bigint, ticking: boolean): string {
  const text = ticking ? formatAtomic(value, DECIMALS) : formatAtomic2(value, DECIMALS);
  const dot = text.indexOf(".");
  return `$${text.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${text.slice(dot)}`;
}

export function YieldBalance({ owner, principal }: { owner: PublicKey | null; principal: bigint }) {
  const ownerBase58 = owner?.toBase58();
  const loadPlayer = useCallback(
    (signal: AbortSignal) =>
      ownerBase58
        ? fetchPlayer(apiBaseUrl(), ownerBase58, signal)
        : Promise.resolve({ ok: false as const, reason: "no wallet connected" }),
    [ownerBase58],
  );
  const player = useApiPoll(loadPlayer, 10_000);
  const poolSummary = useLivePool();
  const live = poolSummary?.live ?? null;

  // A deposit or withdraw moves Principal on the fast state poll; ask the Read
  // model again instead of waiting out its slower interval.
  const { refresh } = player;
  const seenPrincipal = useRef(principal);
  useEffect(() => {
    if (seenPrincipal.current === principal) return;
    seenPrincipal.current = principal;
    refresh();
  }, [principal, refresh]);

  const p = player.data;
  const impaired = poolSummary?.pool.impaired ?? false;
  const input = useMemo(
    () =>
      p === null
        ? null
        : {
            principal: BigInt(p.principal),
            unsettled: BigInt(p.unsettledYield),
            syncedAt: Number(p.syncedAt),
            rateBps: live?.rates.estimatedBps ?? null,
            impaired,
          },
    [p, live, impaired],
  );
  const { value, ticking } = useTickingBalance(input);

  if (owner === null) return null;
  const rate = live ? rateCopy(live) : null;

  return (
    <>
      <dl className="vault-rows vault-earning">
        <div className="vault-line" data-testid="vault-balance">
          <dt>Balance</dt>
          <dd data-testid="vault-balance-value">
            {money(value ?? principal, ticking)}
          </dd>
        </div>
        <div className="vault-line" data-testid="vault-rate">
          <dt className="vault-line-label">
            Rate
            <InfoTip id="vault-rate-tip" paragraphs={RATE_TIP} />
          </dt>
          <dd data-testid="vault-rate-ceiling">{rate?.ceiling ?? "—"}</dd>
        </div>
        <div className="vault-line" data-testid="vault-rate-paid">
          <dt>{rate?.trailingShort ? "Paid so far" : "Paid, last 7 days"}</dt>
          <dd>{rate?.trailing ?? "—"}</dd>
        </div>
      </dl>
      {impaired ? (
        <div className="vault-notes" style={{ marginTop: 0, marginBottom: 20 }}>
          <span className="vault-note err" data-testid="vault-impaired-note">
            The venue is impaired. Your balance has stopped earning.
          </span>
        </div>
      ) : null}
    </>
  );
}
