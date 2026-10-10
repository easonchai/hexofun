/**
 * The pool summary with its `live` block (yield-claimer ticket 15), read from
 * the Read model only (ADR 0008).
 */
import { useCallback } from "react";

import { apiBaseUrl, fetchPoolSummary, type PoolSummaryDto } from "./api.js";
import { useApiPoll } from "./useApiPoll.js";

/** `GET /pool` reads klend's reserve through a 15 s cache, so asking sooner
 *  only repeats the answer. */
const POOL_POLL_MS = 15_000;

/** The pool summary with its `live` block; null until the first answer. */
export function useLivePool(): PoolSummaryDto | null {
  const load = useCallback((signal: AbortSignal) => fetchPoolSummary(apiBaseUrl(), signal), []);
  return useApiPoll(load, POOL_POLL_MS).data;
}
