/**
 * React side of session delegation (off-chain-tickets ticket 15). Holds the
 * connected wallet's live session for the UI and runs `ensureSession` when the
 * bet drawer opens. The bet flow (ticket 18, App.tsx) calls `ensure()` again
 * before it signs and `drop()` after a `SessionInvalid` refusal.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "./api.js";
import { CLUSTER, PROGRAM_ID } from "./chain.js";
import {
  cannotSignMessages,
  dropSession,
  ensureSession,
  httpSessionApi,
  loadSession,
  type EnsureResult,
  type LiveSession,
  type SessionDeps,
} from "./session.js";
import type { GameSigner } from "./wallets.js";

export interface SessionState {
  /** The wallet's live session; null before the first delegation. */
  session: LiveSession | null;
  /** True while the wallet is open for a delegation. */
  busy: boolean;
  /** Plain-copy reason the last ensure failed; null otherwise. */
  error: string | null;
  /** Connected with a wallet that signs neither SIWS nor messages (Ledger). */
  cannotSign: boolean;
  ensure: () => Promise<EnsureResult | null>;
  /** Forgets the key so the next `ensure` prompts again (after SessionInvalid). */
  drop: () => void;
}

/** Stands in for localStorage when the browser blocks it (a private window):
 *  the session then lasts until the page reloads. */
const memory = new Map<string, string>();
const memoryStorage: SessionDeps["storage"] = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};
export const storage = (): SessionDeps["storage"] => {
  try {
    return window.localStorage;
  } catch {
    return memoryStorage;
  }
};

export function useSession(signer: GameSigner): SessionState {
  const wallet = signer.connected ? signer.publicKey?.toBase58() : undefined;
  const [session, setSession] = useState<LiveSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);
  // Two opens in a row (StrictMode, a double tap) must share one wallet prompt.
  const inflight = useRef<Promise<EnsureResult | null> | null>(null);

  const deps = useCallback((): SessionDeps | null => {
    const current = signerRef.current;
    const address = current.publicKey?.toBase58();
    if (!current.connected || !address) return null;
    return {
      storage: storage(),
      now: Date.now,
      api: httpSessionApi(apiBaseUrl()),
      origin: window.location.origin,
      cluster: CLUSTER,
      programId: PROGRAM_ID.toBase58(),
      signer: {
        wallet: address,
        signMessage: current.signMessage,
        signIn: current.signIn,
      },
    };
  }, []);

  // A different wallet has its own key (or none).
  useEffect(() => {
    const d = deps();
    setSession(d && wallet ? loadSession(d, wallet) : null);
    setError(null);
  }, [wallet, deps]);

  const ensure = useCallback((): Promise<EnsureResult | null> => {
    if (inflight.current) return inflight.current;
    const d = deps();
    if (!d) return Promise.resolve(null);
    setBusy(true);
    const run = ensureSession(d)
      .then((result) => {
        if (result.ok) {
          setSession(result.session);
          setError(null);
        } else {
          setError(result.message);
        }
        return result;
      })
      .finally(() => {
        inflight.current = null;
        setBusy(false);
      });
    inflight.current = run;
    return run;
  }, [deps]);

  const drop = useCallback((): void => {
    const d = deps();
    if (d) dropSession(d, d.signer.wallet);
    setSession(null);
  }, [deps]);

  return {
    session,
    busy,
    error,
    cannotSign: signer.connected && cannotSignMessages(signer),
    ensure,
    drop,
  };
}
