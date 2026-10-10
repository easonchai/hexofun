// Ticket 03: every chain read and send gets a timeout, and an optional
// second RPC takes over when the primary times out or errors. Wrapping the
// `Connection` object itself, rather than adding a timeout at each call
// site, is what makes "every read and send in the operator, indexer, API and
// admin CLI goes through the chain service" true for free: every one of them
// already calls through `chain.connection`, so wrapping it here is the one
// place this needs to happen.
import type { Connection } from "@solana/web3.js";

/** `/status`'s `rpcEndpoint`/`rpcFallbackAt` fields: which endpoint most
 *  recently served a call, and when the last failover happened (never, if
 *  it hasn't). */
export interface RpcStatus {
  endpoint: "primary" | "fallback";
  fallbackAt: number | null;
}

interface RpcStatusState {
  endpoint: "primary" | "fallback";
  fallbackAt: number | null;
}

/** Subscription methods stay pinned to the primary, unwrapped (spec.md
 *  "Websockets lie"): web3.js owns reconnecting and re-subscribing them
 *  itself, and a stale subscription is covered by the operator's and
 *  indexer's own sweeps, not by retrying on a second endpoint. */
const SUBSCRIPTION_METHODS = new Set<string>([
  "onLogs",
  "removeOnLogsListener",
  "onAccountChange",
  "removeAccountChangeListener",
  "onSignature",
  "removeSignatureListener",
]);

const statuses = new WeakMap<Connection, RpcStatusState>();

/**
 * Wraps `primary` so every non-subscription call is bounded by `timeoutMs`
 * and, on a timeout, a 5xx or a 429, retried once against `fallback` (when
 * configured). The primary is tried again on the very next call regardless
 * of the last call's outcome — there is no sticky failover. `rpcStatus`
 * reads the outcome of the most recent call.
 */
export function withRpcFallback(
  primary: Connection,
  fallback: Connection | undefined,
  timeoutMs: number,
): Connection {
  const state: RpcStatusState = { endpoint: "primary", fallbackAt: null };
  const urls = [primary.rpcEndpoint, fallback?.rpcEndpoint].filter(
    (url): url is string => Boolean(url),
  );
  const proxy = new Proxy(primary, {
    get(target, prop) {
      // Reflect.get with no receiver: a getter (e.g. `rpcEndpoint`) runs
      // with `this` bound to the real connection, never the proxy, so it
      // never re-enters this trap for its own internal field reads.
      const value = Reflect.get(target, prop);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      if (SUBSCRIPTION_METHODS.has(prop)) return value.bind(target);
      return (...args: unknown[]) =>
        callWithFallback(prop, args, primary, fallback, timeoutMs, state, urls);
    },
  });
  statuses.set(proxy, state);
  return proxy;
}

/** The wrapped connection's most recent call outcome, or the "always
 *  primary, never failed over" default for a plain `Connection` nothing
 *  wrapped (every test that builds `ChainService` on a bare fake). */
export function rpcStatus(connection: Connection): RpcStatus {
  const state = statuses.get(connection);
  return state ? { ...state } : { endpoint: "primary", fallbackAt: null };
}

async function callWithFallback(
  method: string,
  args: unknown[],
  primary: Connection,
  fallback: Connection | undefined,
  timeoutMs: number,
  state: RpcStatusState,
  urls: readonly string[],
): Promise<unknown> {
  try {
    const result = await withTimeout(invoke(primary, method, args), timeoutMs, `RPC ${method}`);
    state.endpoint = "primary";
    return result;
  } catch (primaryError) {
    if (!fallback || !isFailoverWorthy(primaryError)) throw redact(primaryError, urls);
    try {
      const result = await withTimeout(
        invoke(fallback, method, args),
        timeoutMs,
        `RPC ${method} (fallback)`,
      );
      state.endpoint = "fallback";
      state.fallbackAt = Date.now();
      return result;
    } catch (fallbackError) {
      throw redact(
        new Error(`RPC ${method} failed on both endpoints`, { cause: fallbackError }),
        urls,
      );
    }
  }
}

// SAFETY: every call site in this module reads `prop` off `Reflect.get` on
// the same connection first and only wraps it when it is already a
// function, so invoking it here with the connection as `this` is calling a
// real method with its normal receiver.
function invoke(connection: Connection, method: string, args: unknown[]): Promise<unknown> {
  return (connection as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
    method
  ]!(...args);
}

/** A timeout, a 5xx or a 429 (ticket 03): the failures worth spending a
 *  second RPC round trip on. Anything else (a bad request, a program error)
 *  would fail on the fallback too. */
function isFailoverWorthy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out after \d+ms$/.test(message) || /^(429|5\d\d)\b/.test(message);
}

/** Rejects with a named error once `ms` has passed, if `promise` has not
 *  settled by then. web3.js takes no per-call timeout, so an RPC that
 *  accepts the connection and then says nothing would otherwise hold a call
 *  open with no ceiling. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** The RPC url carries the provider api key (spec.md "never print the URL
 *  itself"), and web3.js puts the whole url in its own error text. Scrubs
 *  both the primary's and the fallback's before an error leaves this module,
 *  so nothing downstream has to remember to. */
function redact(error: unknown, urls: readonly string[]): unknown {
  if (!(error instanceof Error) || urls.length === 0) return error;
  let message = error.message;
  for (const url of urls) message = message.split(url).join("<rpc-url>");
  if (message === error.message) return error;
  return new Error(message, { cause: error });
}
