// spec.md §3.1. Vars with a listed default value fall back to it; the rest
// have none and fail the boot if missing — all of them at once, not one at a
// time, so a fresh checkout tells you everything it needs in one error.
import { Logger } from "@nestjs/common";
import { PublicKey } from "@solana/web3.js";

import { INVITE_CIRCULATION_CAP, INVITE_REDEEM_GRANT_COUNT } from "../api/invite-code";
import { DEFAULT_REFERRAL_QUALIFY_SECONDS } from "../api/referral";

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "RPC_URL",
  "OPERATOR_KEYPAIR",
  "ACCEPTED_MINT",
  "CORS_ORIGIN",
  "PROGRAM_ID",
  "POOL_ID",
  "CLUSTER",
] as const;

// Used only as an explicit, concrete program id in tests and scripts now
// (beta-launch-fixes ticket 10): PROGRAM_ID itself has no default any more, a
// mainnet stack must never be able to crank a devnet Pool by omission.
export const DEFAULT_PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";

/** The clusters `CLUSTER` may name (beta-launch-fixes ticket 10); checked
 *  against the RPC's genesis hash at boot in boot-guard.ts. Same two values
 *  as the web's VITE_CLUSTER (apps/web/src/cluster.ts). */
export const CLUSTERS = ["devnet", "mainnet-beta"] as const;
export type Cluster = (typeof CLUSTERS)[number];

/** SOL the operator is warned about falling below, in `/status` and `/healthz`. */
export const DEFAULT_OPERATOR_SOL_WARN = 0.5;

/** Ceiling on the priority fee `ChainService.send` attaches (ticket 10):
 *  `setComputeUnitPrice`'s microlamports-per-CU price, capped so a spike in
 *  `getRecentPrioritizationFees` samples cannot run the operator's fee up
 *  without a bound. */
export const DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS = 50_000;

/** Per-call ceiling every chain read and send is bounded by (production-
 *  hardening ticket 03): the RPC that accepts the connection and then says
 *  nothing would otherwise hold the operator's tick, or an HTTP request,
 *  open with no bound. */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** `GET /alerts`' `OPERATOR_STALE` threshold (production-hardening ticket
 *  05): seconds since the operator's last tick before it counts as stuck. */
export const DEFAULT_ALERT_TICK_STALE_S = 300;

/** `GET /alerts`' `INDEXER_STALE` threshold: seconds since the indexer
 *  cursor last advanced before it counts as stuck. */
export const DEFAULT_ALERT_INDEXER_STALE_S = 600;

/** `GET /alerts`' `FREE_IDLE_LOW` threshold (yield-claimer ticket 14): seconds
 *  free idle may sit under the idle floor before it counts. The Operator
 *  recalls within a tick or two, so an hour means the recall is not working. */
export const DEFAULT_ALERT_IDLE_LOW_S = 3600;

/** `GET /alerts`' `RESERVE_LIQUIDITY_LOW` threshold: atomic USDC of free
 *  liquidity the pinned klend reserve may fall to. 100,000 USDC is a few
 *  times the pool's own position at the default caps. */
export const DEFAULT_ALERT_RESERVE_FREE_MIN = 100_000_000_000;

export interface HexVaultEnv {
  DATABASE_URL: string;
  RPC_URL: string;
  /** Optional second RPC (production-hardening ticket 03): a call that times
   *  out, or errors with a 5xx or a 429, on `RPC_URL` is retried once here.
   *  Absent means a failure just propagates, same as before this ticket. */
  RPC_FALLBACK_URL?: string;
  /** Optional WebSocket for `RPC_URL`'s subscriptions (solami 06). Solami
   *  serves pub/sub on its own host, not the one web3.js derives from the
   *  HTTP URL. Absent keeps the derived socket. */
  RPC_WS_URL?: string;
  /** Per-call timeout, in ms, every chain read and send is bounded by. */
  RPC_TIMEOUT_MS: number;
  PROGRAM_ID: string;
  POOL_ID: string;
  /** Checked against the RPC's genesis hash at boot (boot-guard.ts), so a
   *  wrong RPC_URL fails fast instead of cranking the wrong network. */
  CLUSTER: Cluster;
  /** The hot crank key. The admin's key is never in this env. */
  OPERATOR_KEYPAIR: string;
  /** Pool admin, base58 pubkey. Read for CLI targeting only; absent means
   * the locally loaded keypair is treated as the admin too. */
  ADMIN_ADDRESS?: string;
  /** The mint the pool takes deposits in: the test mint on devnet, real
   *  USDC on mainnet. Named HEXUSDC_MINT before the mainnet work. */
  ACCEPTED_MINT: string;
  /** SOL below which `/status` flags the operator as running out of fees.
   *  Parsed here rather than at the reader, so a typo fails the boot instead
   *  of turning into a NaN comparison that is false forever. */
  OPERATOR_SOL_WARN: number;
  /** Cap, in microlamports per compute unit, on the priority fee
   *  `ChainService.send` attaches to operator transactions. */
  PRIORITY_FEE_MAX_MICROLAMPORTS: number;
  FAUCET_AMOUNT: string;
  FAUCET_INTERVAL_SECONDS: string;
  /** Seconds a referral's Principal must stay above the qualify threshold
   *  before the daily bonus job (ticket 08) pays it. Shortened on devnet to
   *  see a referral qualify sooner. */
  REFERRAL_QUALIFY_SECONDS: number;
  /** `GET /alerts`' `OPERATOR_STALE` threshold, in seconds. */
  ALERT_TICK_STALE_S: number;
  /** `GET /alerts`' `INDEXER_STALE` threshold, in seconds. */
  ALERT_INDEXER_STALE_S: number;
  /** `GET /alerts`' `FREE_IDLE_LOW` threshold, in seconds. */
  ALERT_IDLE_LOW_S: number;
  /** `GET /alerts`' `RESERVE_LIQUIDITY_LOW` threshold, atomic USDC. */
  ALERT_RESERVE_FREE_MIN: number;
  /** Most remaining Invite code uses allowed in circulation before a redeem
   *  stops granting the redeemer codes of its own (invite-code.ts). */
  INVITE_CIRCULATION_CAP: number;
  /** Invite codes a successful redeem grants its redeemer, under the cap. */
  INVITE_REDEEM_GRANT_COUNT: number;
  CORS_ORIGIN: string;
  PORT: string;
  /** Sparring player secret, base58. The wallet `sparring-setup` funds. */
  SPARRING_KEYPAIR?: string;
  /** The Sparring player plays only when this is true (ADR 0019). Off by
   *  default and unset in every production env file, so a keypair left in an
   *  env cannot start it by itself. */
  SPARRING_ENABLED: boolean;
  /** Shared secret for `POST /access/invites`, sent as `x-admin-key`. Absent
   *  switches the route off (404). At least 32 characters when set. */
  INVITE_ADMIN_KEY?: string;
  /** Wallets allowed to call `POST /ops/fast-pause` (ops-console ticket 06),
   *  canonical base58. Empty switches the route off (404). */
  OPS_WALLETS?: string[];
  /** Beta-launch-fixes ticket 05: an ISO timestamp holding back the
   *  Operator's first `begin_epoch` while the Pool has no Epoch yet, so
   *  deposits can open days before the first Draw. Absent behaves as before:
   *  `begin_epoch` fires on the first tick. Reported on `/state` and
   *  `/status` so the web can render a countdown. */
  LAUNCH_AT?: string;
}

/**
 * A SOL threshold, as a number. Unset (or set to the empty string, which is
 * how a compose file spells "not configured") takes the default; anything
 * that is not a finite amount of SOL fails the boot, because the alternative
 * is a NaN that silently reports the operator's balance as fine forever.
 */
function solWarn(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_OPERATOR_SOL_WARN;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `OPERATOR_SOL_WARN must be a non-negative number of SOL, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default cap, anything
 * else must be a non-negative whole number of microlamports.
 */
function priorityFeeMax(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `PRIORITY_FEE_MAX_MICROLAMPORTS must be a non-negative whole number of microlamports, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default timeout,
 * anything else must be a positive whole number of milliseconds.
 */
function rpcTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_RPC_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `RPC_TIMEOUT_MS must be a positive whole number of milliseconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes referral.ts's own default,
 * anything else must be a non-negative whole number of seconds.
 */
function referralQualifySeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_REFERRAL_QUALIFY_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `REFERRAL_QUALIFY_SECONDS must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default, anything else
 * must be a non-negative whole number of seconds.
 */
function alertTickStaleSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_ALERT_TICK_STALE_S;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `ALERT_TICK_STALE_S must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/** Same shape as `alertTickStaleSeconds`. */
function alertIndexerStaleSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_ALERT_INDEXER_STALE_S;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `ALERT_INDEXER_STALE_S must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Ticket 05: unset or empty takes no launch time (today's behaviour).
 * Anything else must parse as an ISO timestamp, so a typo fails the boot
 * instead of the operator silently never gating `begin_epoch`.
 */
function launchAt(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return undefined;
  }
  const value = String(raw);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`LAUNCH_AT must be an ISO timestamp, got "${value}"`);
  }
  return value;
}

/** Comma separated public keys. Unset or blank is an empty list; one bad
 *  entry fails the boot, since a typo would silently lock a teammate out. */
function opsWallets(raw: unknown): string[] {
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      try {
        return new PublicKey(entry).toBase58();
      } catch {
        throw new Error(`OPS_WALLETS must be comma separated Solana public keys, got "${entry}"`);
      }
    });
}

/** `CLUSTER` must be one of `CLUSTERS`; there is no default, since a wrong
 *  guess is worse than a boot failure. */
function cluster(raw: unknown): Cluster {
  if (CLUSTERS.includes(raw as Cluster)) return raw as Cluster;
  throw new Error(`CLUSTER must be one of ${CLUSTERS.join(", ")}, got "${String(raw)}"`);
}

/** A switch that is off unless spelled `true` or `false` explicitly, so a typo
 *  such as `ture` fails the boot instead of silently reading as off. Unset
 *  and the empty string (a compose file's "not configured") are off. */
function offByDefaultSwitch(key: string, raw: unknown): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === "") return false;
  const value = String(raw).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be true or false, got "${String(raw)}"`);
}

/** Unset or empty takes `fallback`; anything else must be a non-negative
 *  whole number, or the boot fails naming `key`. */
function wholeNumber(key: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative whole number, got "${String(raw)}"`);
  }
  return value;
}

/** @nestjs/config `validate` hook: runs once at boot, on the raw process.env. */
export function validateEnv(env: Record<string, unknown>): HexVaultEnv {
  if (!env.ACCEPTED_MINT && env.HEXUSDC_MINT) {
    new Logger("env").warn("HEXUSDC_MINT is deprecated; rename it to ACCEPTED_MINT");
  }
  const acceptedMint = env.ACCEPTED_MINT ?? env.HEXUSDC_MINT;
  const missing = REQUIRED_KEYS.filter((key) =>
    key === "ACCEPTED_MINT" ? !acceptedMint : !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  if (env.INVITE_ADMIN_KEY && String(env.INVITE_ADMIN_KEY).length < 32) {
    throw new Error("INVITE_ADMIN_KEY must be at least 32 characters (try `openssl rand -hex 32`)");
  }
  const launchAtValue = launchAt(env.LAUNCH_AT);
  return {
    DATABASE_URL: String(env.DATABASE_URL),
    RPC_URL: String(env.RPC_URL),
    RPC_TIMEOUT_MS: rpcTimeoutMs(env.RPC_TIMEOUT_MS),
    PROGRAM_ID: String(env.PROGRAM_ID),
    POOL_ID: String(env.POOL_ID),
    CLUSTER: cluster(env.CLUSTER),
    OPERATOR_KEYPAIR: String(env.OPERATOR_KEYPAIR),
    ACCEPTED_MINT: String(acceptedMint),
    OPERATOR_SOL_WARN: solWarn(env.OPERATOR_SOL_WARN),
    PRIORITY_FEE_MAX_MICROLAMPORTS: priorityFeeMax(env.PRIORITY_FEE_MAX_MICROLAMPORTS),
    FAUCET_AMOUNT: String(env.FAUCET_AMOUNT ?? "1000000000"),
    FAUCET_INTERVAL_SECONDS: String(env.FAUCET_INTERVAL_SECONDS ?? "3600"),
    REFERRAL_QUALIFY_SECONDS: referralQualifySeconds(env.REFERRAL_QUALIFY_SECONDS),
    ALERT_TICK_STALE_S: alertTickStaleSeconds(env.ALERT_TICK_STALE_S),
    ALERT_INDEXER_STALE_S: alertIndexerStaleSeconds(env.ALERT_INDEXER_STALE_S),
    ALERT_IDLE_LOW_S: wholeNumber("ALERT_IDLE_LOW_S", env.ALERT_IDLE_LOW_S, DEFAULT_ALERT_IDLE_LOW_S),
    ALERT_RESERVE_FREE_MIN: wholeNumber(
      "ALERT_RESERVE_FREE_MIN",
      env.ALERT_RESERVE_FREE_MIN,
      DEFAULT_ALERT_RESERVE_FREE_MIN,
    ),
    INVITE_CIRCULATION_CAP: wholeNumber(
      "INVITE_CIRCULATION_CAP",
      env.INVITE_CIRCULATION_CAP,
      INVITE_CIRCULATION_CAP,
    ),
    INVITE_REDEEM_GRANT_COUNT: wholeNumber(
      "INVITE_REDEEM_GRANT_COUNT",
      env.INVITE_REDEEM_GRANT_COUNT,
      INVITE_REDEEM_GRANT_COUNT,
    ),
    CORS_ORIGIN: String(env.CORS_ORIGIN),
    PORT: String(env.PORT ?? "8080"),
    OPS_WALLETS: opsWallets(env.OPS_WALLETS),
    SPARRING_ENABLED: offByDefaultSwitch("SPARRING_ENABLED", env.SPARRING_ENABLED),
    // Spread rather than assigned: under `exactOptionalPropertyTypes` an
    // optional key cannot be set to `undefined`, and "absent" is the switch.
    ...(env.RPC_FALLBACK_URL ? { RPC_FALLBACK_URL: String(env.RPC_FALLBACK_URL) } : {}),
    ...(env.RPC_WS_URL ? { RPC_WS_URL: String(env.RPC_WS_URL) } : {}),
    ...(env.ADMIN_ADDRESS ? { ADMIN_ADDRESS: String(env.ADMIN_ADDRESS) } : {}),
    ...(env.SPARRING_KEYPAIR
      ? { SPARRING_KEYPAIR: String(env.SPARRING_KEYPAIR) }
      : {}),
    ...(env.INVITE_ADMIN_KEY ? { INVITE_ADMIN_KEY: String(env.INVITE_ADMIN_KEY) } : {}),
    ...(launchAtValue !== undefined ? { LAUNCH_AT: launchAtValue } : {}),
  };
}
