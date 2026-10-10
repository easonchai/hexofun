/**
 * Ticket 07: the Indexer is the browser's read model, so this is the one
 * poll every screen reads from — `GET /state`, selected into props by App.
 * Runs every 2 s, tightens to 500 ms for 15 s after `kick()` (call once a
 * sent transaction confirms), pauses while the tab is hidden and does one
 * immediate poll on focus.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchState, type StateDto } from "./api.js";
import { scoped } from "./useApiPoll.js";

const NORMAL_MS = 2_000;
const BURST_MS = 500;
const BURST_WINDOW_MS = 15_000;

export interface StatePollResult {
  data: StateDto | null;
  error: string | null;
  /** True from `kick()` until the watched state changes or 15 s pass. */
  pending: boolean;
  /** True once 15 s have passed since `kick()` with no change: the send is
   *  still confirming, not failed. */
  stillConfirming: boolean;
  /** Call right after a transaction confirms: tightens polling to 500 ms for
   *  15 s and watches for the next poll's state to differ from right now. */
  kick: () => void;
}

/**
 * Only the parts a transaction moves. Chain time and the operator heartbeat
 * change on every poll by themselves, and so do the Player's odds, which move
 * with every other Player's deposit: comparing those would call a deposit
 * landed one poll after it was sent, whatever the chain did.
 *
 * Every write the UI can send has to land in here or `pending` never clears:
 * deposit and request_withdraw move `principal`, process_withdraw moves only
 * `pendingWithdraw`, and buy_tickets moves `tickets` once the ledger books it. The
 * faucet moves none of them — it mints to
 * the wallet, which `/state` does not carry — so it refreshes the balance
 * directly instead of arming this watch (see App.tsx `onFunded`).
 */
export function snapshot(data: StateDto): string {
  const player = data.player;
  return JSON.stringify({
    principal: player?.principal ?? null,
    tickets: player?.tickets ?? null,
    pendingWithdraw: player?.pendingWithdraw ?? null,
    // Ticket 05: null before the pool has ever had an Epoch.
    jackpot: data.currentEpoch?.jackpotAmount ?? null,
    totalPrincipal: data.pool.totalPrincipal,
  });
}

export function useStatePoll(baseUrl: string, owner: string | undefined): StatePollResult {
  // Held with its owner: after a wallet switch the previous owner's payload
  // reads as null until the new owner's first fetch lands.
  const [heldData, setHeldData] = useState<{ key: unknown; value: StateDto | null } | null>(null);
  const [heldError, setHeldError] = useState<{ key: unknown; value: string | null } | null>(null);
  const data = scoped(heldData, owner, null);
  const error = scoped(heldError, owner, null);
  const [pending, setPending] = useState(false);
  const [stillConfirming, setStillConfirming] = useState(false);

  const dataRef = useRef<StateDto | null>(null);
  const burstUntilRef = useRef(0);
  const watchBaselineRef = useRef<string | null>(null);
  const runRef = useRef<() => void>(() => {});

  const kick = useCallback(() => {
    burstUntilRef.current = Date.now() + BURST_WINDOW_MS;
    watchBaselineRef.current = dataRef.current ? snapshot(dataRef.current) : null;
    setPending(true);
    setStillConfirming(false);
    runRef.current();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    // A new owner starts with no send in flight and nothing to compare against.
    dataRef.current = null;
    watchBaselineRef.current = null;
    burstUntilRef.current = 0;
    setPending(false);
    setStillConfirming(false);

    const scheduleNext = (): void => {
      if (cancelled) return;
      const inBurst = Date.now() < burstUntilRef.current;
      timer = setTimeout(() => void run(), inBurst ? BURST_MS : NORMAL_MS);
    };

    // A `kick()` mid-flight cancels whatever was scheduled and runs now;
    // `run` itself is not otherwise re-entrant-safe against overlapping
    // fetches, which a demo-scale poll interval never triggers in practice.
    const run = async (): Promise<void> => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (document.hidden) return; // resumed by the visibility listener below
      const result = await fetchState(baseUrl, owner, controller.signal);
      if (cancelled) return;
      if (result.ok) {
        dataRef.current = result.data;
        setHeldData({ key: owner, value: result.data });
        setHeldError({ key: owner, value: null });
        const baseline = watchBaselineRef.current;
        if (baseline !== null) {
          if (snapshot(result.data) !== baseline) {
            watchBaselineRef.current = null;
            setPending(false);
            setStillConfirming(false);
          } else if (Date.now() >= burstUntilRef.current) {
            setStillConfirming(true);
          }
        }
      } else {
        setHeldError({ key: owner, value: result.reason });
      }
      scheduleNext();
    };
    runRef.current = () => void run();

    void run();

    const onVisibility = (): void => {
      if (document.hidden) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void run();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, owner]);

  return { data, error, pending, stillConfirming, kick };
}
