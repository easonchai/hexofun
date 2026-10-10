/**
 * Ticket 14: a production build must not ship with a devnet default silently
 * baked in. `vite.config.ts` calls this at build time (`vite build` runs in
 * "production" mode by default), listing every missing value at once rather
 * than failing the build one retry at a time. Nothing is imported here on
 * purpose, same reasoning as `cluster.ts`: this runs in Node, inside the
 * Vite config, not in the browser bundle.
 */

/** Every value a production build needs a real one for; each also has its
 *  own build-time or load-time check (VITE_CLUSTER via `clusterFrom`,
 *  VITE_PROGRAM_ID via `programIdFrom`) — this is the one place that checks all of them are
 *  present together. VITE_PUBLIC_RPC_URL is optional: unset, `chain.ts` uses
 *  the cluster's public endpoint, rate-limited per player IP. */
const REQUIRED_IN_PRODUCTION = [
  "VITE_CLUSTER",
  "VITE_API_URL",
  "VITE_PRIVY_APP_ID",
  "VITE_PROGRAM_ID",
  "VITE_POOL_ID",
] as const;

/** Throws naming every missing value, not just the first. */
export function validateProdEnv(env: Record<string, string | undefined>): void {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment value(s): ${missing.join(", ")}`,
    );
  }
}
