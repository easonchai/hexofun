// beta-launch-fixes ticket 10: a mainnet stack must never crank the wrong
// network, Pool or mint because an env var was missing or mistyped.
// validateEnv (config/env.ts) already refuses to boot without PROGRAM_ID,
// POOL_ID and CLUSTER; the checks here need the chain and the database, so
// they run once from main.ts's bootstrap() instead, before the server starts
// accepting requests. Pure and dependency-light on purpose (a duck-typed
// connection and coder) so every guard is unit tested without a live RPC or
// Postgres.
import { PublicKey } from "@solana/web3.js";

import { expectedVenuePins, type VenuePins } from "./bootstrap/params";
import { poolAddress } from "./chain/pda";
import type { Cluster } from "./config/env";

/** Mainnet-beta's and devnet's genesis hashes never change; a mismatch means
 *  CLUSTER and RPC_URL point at different networks. */
export const CLUSTER_GENESIS_HASHES: Record<Cluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

export function assertClusterMatchesGenesis(cluster: Cluster, genesisHash: string): void {
  const expected = CLUSTER_GENESIS_HASHES[cluster];
  if (genesisHash !== expected) {
    throw new Error(
      `CLUSTER=${cluster} does not match RPC_URL's genesis hash ${genesisHash} ` +
        `(expected ${expected} for ${cluster}); check RPC_URL`,
    );
  }
}

export function assertAcceptedMintMatchesPool(configuredMint: string, poolMint: string): void {
  if (configuredMint !== poolMint) {
    throw new Error(
      `ACCEPTED_MINT ${configuredMint} does not match the Pool's mint ${poolMint}`,
    );
  }
}

/** The Pool fields that say who owns the money and where it goes. */
export interface PoolPinsView {
  readonly admin: PublicKey;
  readonly treasury: PublicKey;
  readonly buybackReserve: PublicKey;
  readonly acceptedMint: PublicKey;
  readonly venueKind: number;
  readonly klendProgram: PublicKey;
  readonly klendMarket: PublicKey;
  readonly klendReserve: PublicKey;
  readonly klendCtoken: PublicKey;
}

/** What the env or flags say, each key only when it says something. */
export interface ExpectedPoolPins {
  readonly admin?: PublicKey | undefined;
  readonly treasury?: PublicKey | undefined;
  readonly buybackReserve?: PublicKey | undefined;
  readonly acceptedMint?: PublicKey | undefined;
  readonly venue?: VenuePins | undefined;
}

/**
 * One line per field where the on-chain Pool differs from what was given.
 * Empty means they agree. Anyone can run `create_pool` on an unprotected
 * program, and bootstrap and this guard used to compare only the operator, so
 * a Pool made by someone else with their own admin and treasury read as
 * "already exists" (mainnet-readiness-fixes 06).
 */
export function diffPoolPins(actual: PoolPinsView, expected: ExpectedPoolPins): string[] {
  const lines: string[] = [];
  const check = (name: string, chain: PublicKey | number, wanted: PublicKey | number | undefined): void => {
    if (wanted === undefined) return;
    const same =
      typeof chain === "number" || typeof wanted === "number"
        ? chain === wanted
        : chain.equals(wanted);
    if (!same) {
      lines.push(`  ${name}: on chain ${String(chain)}, expected ${String(wanted)}`);
    }
  };
  check("admin", actual.admin, expected.admin);
  check("treasury", actual.treasury, expected.treasury);
  check("buyback reserve", actual.buybackReserve, expected.buybackReserve);
  check("accepted mint", actual.acceptedMint, expected.acceptedMint);
  check("venue kind", actual.venueKind, expected.venue?.kind);
  check("venue program", actual.klendProgram, expected.venue?.klendProgram);
  check("venue market", actual.klendMarket, expected.venue?.klendMarket);
  check("venue reserve", actual.klendReserve, expected.venue?.klendReserve);
  check("venue cToken", actual.klendCtoken, expected.venue?.klendCtoken);
  return lines;
}

/** Throws with the whole diff, so one run shows every wrong field. */
export function assertPoolMatchesExpected(
  pool: PublicKey,
  actual: PoolPinsView,
  expected: ExpectedPoolPins,
  source: string,
): void {
  const diff = diffPoolPins(actual, expected);
  if (diff.length > 0) {
    throw new Error(
      `pool ${pool.toBase58()} does not match ${source}; it may have been created by someone else:\n${diff.join("\n")}`,
    );
  }
}

/** One row of the indexer's Postgres Pool table, as the guard needs it. */
export interface MirroredPoolRow {
  readonly address: string;
  readonly poolId: bigint;
}

/**
 * "Mirrored" means the indexer's own Postgres copy of the Pool table, not
 * the on-chain account. The database keeps every pool it has ever mirrored
 * (ADR 0016), so a Pool cutover leaves the retired pool's row behind, and a
 * row for a pool other than the configured one is no longer a mistake. What
 * still is: a row whose address is not the PDA of its own `poolId` under the
 * configured program. That database was built against another program, which
 * is what a wrong DATABASE_URL or PROGRAM_ID looks like.
 */
export function assertPoolRowsBelongToProgram(
  programId: PublicKey,
  mirroredRows: readonly MirroredPoolRow[],
): void {
  const foreign = mirroredRows.filter(
    (row) => poolAddress(programId, row.poolId).toBase58() !== row.address,
  );
  if (foreign.length > 0) {
    throw new Error(
      `Postgres has Pool row(s) that are not PDAs of PROGRAM_ID ${programId.toBase58()}: ` +
        `${foreign.map((row) => `${row.address} (poolId ${row.poolId})`).join(", ")}; ` +
        `wrong DATABASE_URL or PROGRAM_ID for this deployment`,
    );
  }
}

/** Just enough of `Program<Idl>.coder.accounts` to read the Pool's mint, so
 *  tests can fake it without a real Anchor coder or IDL. */
export interface PoolMintDecoder {
  readonly coder: {
    readonly accounts: {
      decode(name: "pool", data: Buffer): PoolPinsView;
    };
  };
}

/** Just enough of `Connection` for the guards below. */
export interface BootGuardConnection {
  getGenesisHash(): Promise<string>;
  getAccountInfo(address: PublicKey): Promise<{ data: Buffer } | null>;
}

export interface BootGuardDeps {
  readonly connection: BootGuardConnection;
  readonly program: PoolMintDecoder;
  readonly programId: PublicKey;
  readonly poolAddress: PublicKey;
  readonly acceptedMint: string;
  readonly cluster: Cluster;
  /** The process env: ADMIN_ADDRESS, TREASURY, BUYBACK_RESERVE and the venue
   *  keys bootstrap prints (VENUE_KIND, KLEND_*, KVAULT_ADDRESS). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Every row currently in Postgres's Pool table, Active and retired. */
  readonly mirroredPoolRows: () => Promise<MirroredPoolRow[]>;
}

const pubkeyEnv = (env: Readonly<Record<string, string | undefined>>, key: string): PublicKey | undefined => {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  try {
    return new PublicKey(raw);
  } catch (cause) {
    throw new Error(`${key} must be a base58 pubkey, got "${raw}"`, { cause });
  }
};

/**
 * Reads the pins out of the env. On mainnet-beta ADMIN_ADDRESS, TREASURY and
 * BUYBACK_RESERVE are required: an env that names none of them would compare
 * nothing, which is exactly the squatted-pool case this guards.
 */
export function expectedPinsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  genesisHash: string,
  cluster: Cluster,
  pool: PublicKey,
  programId: PublicKey,
): ExpectedPoolPins {
  const admin = pubkeyEnv(env, "ADMIN_ADDRESS");
  const treasury = pubkeyEnv(env, "TREASURY");
  const buybackReserve = pubkeyEnv(env, "BUYBACK_RESERVE");
  if (cluster === "mainnet-beta") {
    const missing = [
      ["ADMIN_ADDRESS", admin],
      ["TREASURY", treasury],
      ["BUYBACK_RESERVE", buybackReserve],
    ].filter(([, value]) => value === undefined).map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} must be set on mainnet-beta so the Pool can be checked against it; bootstrap prints TREASURY and BUYBACK_RESERVE`,
      );
    }
  }
  const venue = expectedVenuePins(genesisHash, env, pool, programId);
  return { admin, treasury, buybackReserve, venue };
}

/**
 * Runs every boot guard ticket 10 asks for beyond validateEnv's required-var
 * check: CLUSTER against the RPC's genesis hash, ACCEPTED_MINT against the
 * on-chain Pool's mint (skipped when the Pool does not exist yet — bootstrap
 * has not run), the Pool's admin, treasury, buyback reserve and venue pins
 * against the env, and every mirrored Postgres Pool row against the configured
 * program. Throws on the first failing guard; main.ts lets that fail
 * `bootstrap()` rather than starting the server.
 */
export async function runBootGuards(deps: BootGuardDeps): Promise<void> {
  const genesisHash = await deps.connection.getGenesisHash();
  assertClusterMatchesGenesis(deps.cluster, genesisHash);

  const poolInfo = await deps.connection.getAccountInfo(deps.poolAddress);
  if (poolInfo) {
    const raw = deps.program.coder.accounts.decode("pool", poolInfo.data);
    assertAcceptedMintMatchesPool(deps.acceptedMint, raw.acceptedMint.toBase58());
    assertPoolMatchesExpected(
      deps.poolAddress,
      raw,
      expectedPinsFromEnv(deps.env, genesisHash, deps.cluster, deps.poolAddress, deps.programId),
      "the env",
    );
  }

  assertPoolRowsBelongToProgram(deps.programId, await deps.mirroredPoolRows());
}
