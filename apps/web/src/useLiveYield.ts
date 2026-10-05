/**
 * Hooks for the earning balance (yield-claimer ticket 15). Both read the Read
 * model only (ADR 0008): `GET /pool`'s `live` block for rates, and the timer
 * math in `yieldTick.ts` for the ticking between refreshes.
 */
import { useCallback, useEffect, useState } from "react";

import { apiBaseUrl, fetchPoolSummary, type PoolSummaryDto } from "./api.js";
import { useApiPoll } from "./useApiPoll.js";
import { balanceAt, isTicking, keepForward, type BalanceInput, type Shown } from "./yieldTick.js";

/** `GET /pool` reads klend's reserve through a 15 s cache, so asking sooner
 *  only repeats the answer. */
const POOL_POLL_MS = 15_000;

/** The pool summary with its `live` block; null until the first answer. */
export function useLivePool(): PoolSummaryDto | null {
  const load = useCallback((signal: AbortSignal) => fetchPoolSummary(apiBaseUrl(), signal), []);
  return useApiPoll(load, POOL_POLL_MS).data;
}

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Principal plus unsettled yield, ticking once a second while the pool earns.
 * `input` must be memoised by the caller. Under reduced motion, at a zero rate
 * or while impaired there is no timer: the figure moves only when a refresh
 * brings a new `input`. It never steps back on a refresh (`keepForward`).
 */
export function useTickingBalance(input: BalanceInput | null): { value: bigint | null; ticking: boolean } {
  const [shown, setShown] = useState<Shown | null>(null);
  const ticking = input !== null && !reducedMotion() && isTicking(input.rateBps, input.impaired);

  useEffect(() => {
    if (input === null) {
      setShown(null);
      return;
    }
    const update = () =>
      setShown((prev) =>
        keepForward(
          prev,
          { principal: input.principal, value: balanceAt(input, Date.now() / 1000) },
          input.impaired,
        ),
      );
    update();
    if (!ticking) return;
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [input, ticking]);

  return { value: shown?.value ?? null, ticking };
}
