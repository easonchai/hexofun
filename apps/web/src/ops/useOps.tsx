/**
 * The Ops console's shared read model. One provider polls the API and every
 * panel reads it through `useOps()`. Panels that act (cranks, Admin actions,
 * Fast pause) call `refresh()` after a transaction confirms.
 *
 * Reads go through the backend only, so the console stays inside the RPC
 * budget. A failed call keeps the last good data and sets `error`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  fetchAlerts,
  fetchDailyRates,
  fetchOpsSummary,
  fetchPoolSummary,
  type AlertDto,
  type DailyRateDto,
  type OpsSummaryDto,
  type PoolSummaryDto,
} from "../api.js";
import { API_URL } from "../chain.js";

export const POLL_MS = 15_000;
export const DAILY_DAYS = 30;

export interface OpsState {
  /** `GET /ops/summary`. Null until the first answer. */
  summary: OpsSummaryDto | null;
  /** `GET /pool`: the pause switches the summary lacks, the rates, the ceiling. */
  pool: PoolSummaryDto | null;
  /** Firing alerts; empty when none or not yet loaded. */
  alerts: AlertDto[];
  /** Last `DAILY_DAYS` UTC days of paid APR. Null until loaded. */
  daily: DailyRateDto[] | null;
  /** Why the last poll failed, or null when every call answered. */
  error: string | null;
  /** Re-reads everything now. Resolves when the new data is in state. */
  refresh: () => Promise<void>;
}

const OpsContext = createContext<OpsState | null>(null);

export function useOps(): OpsState {
  const state = useContext(OpsContext);
  if (!state) throw new Error("OpsProvider is not mounted");
  return state;
}

export function OpsProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<OpsSummaryDto | null>(null);
  const [pool, setPool] = useState<PoolSummaryDto | null>(null);
  const [alerts, setAlerts] = useState<AlertDto[]>([]);
  const [daily, setDaily] = useState<DailyRateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // A newer read supersedes one still in flight.
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    const { signal } = mine;
    const [s, p, a, d] = await Promise.all([
      fetchOpsSummary(API_URL, signal),
      fetchPoolSummary(API_URL, signal),
      fetchAlerts(API_URL, signal),
      fetchDailyRates(API_URL, DAILY_DAYS, signal),
    ]);
    if (signal.aborted) return;
    if (s.ok) setSummary(s.data);
    if (p.ok) setPool(p.data);
    if (a.ok) setAlerts(a.data);
    if (d.ok) setDaily(d.data);
    const failed = [s, p, a, d].find((r) => !r.ok);
    setError(failed && !failed.ok ? failed.reason : null);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh]);

  const value = useMemo<OpsState>(
    () => ({ summary, pool, alerts, daily, error, refresh }),
    [summary, pool, alerts, daily, error, refresh],
  );
  return <OpsContext.Provider value={value}>{children}</OpsContext.Provider>;
}
