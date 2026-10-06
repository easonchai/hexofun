import { Injectable, Logger } from "@nestjs/common";
import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  decodeRound,
  EPOCH_STATUS,
  ROUND_STATUS,
  type EpochState,
  type PoolState,
  type RoundState,
} from "../operator/chain-state";
import { isFulfilled, randomnessAddress } from "../operator/vrf";
import { PrismaService } from "../prisma/prisma.service";
import { ApiService } from "./api.service";
import { supplyRateBps } from "./live-yield";

/** The Round or epoch a permissionless crank would accept right now. */
export interface StuckItem {
  id: bigint;
  status: number;
}

export interface Stuck {
  /** The Round `void_round` would accept. */
  round: StuckItem | null;
  /** The epoch `rollover_epoch` would accept. */
  epoch: StuckItem | null;
}

export interface VenueParams {
  yieldFeeBps: number;
  idleFloorBps: number;
  idleTargetBps: number;
  reserveShareCapBps: number;
  reserveLiquidityFloorBps: number;
  minVenueMove: bigint;
  lossToleranceBps: number;
}

/** What `GET /ops/summary` adds to the `GET /status` payload. Amounts are
 *  atomic USDC; the serialization interceptor turns each bigint into a string. */
export interface OpsSummaryExtras {
  totalPrincipal: bigint;
  venueValue: bigint;
  feeOwed: bigint;
  prizeOwed: bigint;
  yieldOwed: bigint;
  deficit: bigint;
  /** Chain unix seconds of the last Sync; 0 before the pool is indexed. */
  lastSyncAt: bigint;
  /** Null before the pool is indexed. */
  admin: string | null;
  /** Null before the pool is indexed. */
  venueParams: VenueParams | null;
  /** klend's supply rate in basis points. Null when the reserve is unreadable. */
  supplyRateBps: number | null;
  /** Lifetime `fee_paid` and `prize_paid`, summed from indexed `Harvested` events. */
  harvestedToTreasury: bigint;
  harvestedToJackpot: bigint;
  /** Null when the chain read failed, so the console shows "unknown" rather
   *  than a clean pool. The failure is logged. */
  stuck: Stuck | null;
}

export type OpsSummary = Awaited<ReturnType<ApiService["getStatus"]>> & OpsSummaryExtras;

const NOT_STUCK: Stuck = { round: null, epoch: null };

/**
 * Mirrors the program's own gates in `void_round` and `rollover_epoch`, so the
 * console offers a crank only when the program would take it. A fulfilled
 * request is never stuck: `settle_round` and `draw` take it instead.
 */
export async function findStuck(input: {
  now: bigint;
  pool: Pick<PoolState, "vrfTimeout" | "payoutTimeout" | "jackpotPaused">;
  openRound: RoundState | null;
  previousEpoch: EpochState | null;
  fulfilled: (seed: Uint8Array) => Promise<boolean>;
}): Promise<Stuck> {
  const { now, pool, openRound, previousEpoch, fulfilled } = input;

  let round: StuckItem | null = null;
  if (openRound?.status === ROUND_STATUS.OPEN && now > openRound.endsAt + pool.vrfTimeout) {
    round = { id: openRound.roundId, status: openRound.status };
  } else if (
    openRound?.status === ROUND_STATUS.REQUESTED &&
    now > openRound.requestedAt + pool.vrfTimeout &&
    !(await fulfilled(openRound.vrfSeed))
  ) {
    round = { id: openRound.roundId, status: openRound.status };
  }

  let stuckEpoch = false;
  switch (previousEpoch?.status) {
    case EPOCH_STATUS.ENDED:
      stuckEpoch =
        !pool.jackpotPaused &&
        now > Math.max(Number(previousEpoch.endedAt), Number(previousEpoch.endsAt)) + Number(pool.vrfTimeout);
      break;
    case EPOCH_STATUS.DRAWING:
      stuckEpoch =
        now > previousEpoch.requestedAt + pool.vrfTimeout && !(await fulfilled(previousEpoch.vrfSeed));
      break;
    case EPOCH_STATUS.DRAWN:
      stuckEpoch = now > previousEpoch.drawnAt + pool.payoutTimeout;
      break;
    default:
  }
  return {
    round,
    epoch: previousEpoch && stuckEpoch ? { id: previousEpoch.epochId, status: previousEpoch.status } : null,
  };
}

/** The Ops console's single poll: `GET /status` plus what it lacks. */
@Injectable()
export class OpsSummaryService {
  private readonly logger = new Logger(OpsSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: ApiService,
    private readonly chain: ChainService,
  ) {}

  async getOpsSummary(): Promise<OpsSummary> {
    const poolAddress = this.api.poolAddress;
    const status = await this.api.getStatus();
    const pool = await this.prisma.pool.findUnique({ where: { address: poolAddress } });
    // Cached for BALANCES_TTL_MS and already warm from getStatus, so this is
    // the same reserve read, not a second RPC call.
    const reserve = (await this.api.chainBalances(pool?.klendReserve)).reserve;
    const [harvested, stuck] = await Promise.all([this.harvestedTotals(), this.stuck(pool !== null)]);
    return {
      ...status,
      totalPrincipal: pool?.totalPrincipal ?? 0n,
      venueValue: pool?.venueValue ?? 0n,
      feeOwed: pool?.feeOwed ?? 0n,
      prizeOwed: pool?.prizeOwed ?? 0n,
      yieldOwed: pool?.yieldOwed ?? 0n,
      deficit: pool?.deficit ?? 0n,
      lastSyncAt: pool?.lastSyncAt ?? 0n,
      admin: pool?.admin ?? null,
      venueParams:
        pool === null
          ? null
          : {
              yieldFeeBps: pool.yieldFeeBps,
              idleFloorBps: pool.idleFloorBps,
              idleTargetBps: pool.idleTargetBps,
              reserveShareCapBps: pool.reserveShareCapBps,
              reserveLiquidityFloorBps: pool.reserveLiquidityFloorBps,
              minVenueMove: pool.minVenueMove,
              lossToleranceBps: pool.lossToleranceBps,
            },
      supplyRateBps: reserve === null ? null : supplyRateBps(reserve),
      harvestedToTreasury: harvested.treasury,
      harvestedToJackpot: harvested.jackpot,
      stuck,
    };
  }

  private async harvestedTotals(): Promise<{ treasury: bigint; jackpot: bigint }> {
    const [row] = await this.prisma.$queryRaw<{ treasury: string; jackpot: string }[]>`
      SELECT COALESCE(SUM((data->>'feePaid')::numeric), 0)::text AS treasury,
             COALESCE(SUM((data->>'prizePaid')::numeric), 0)::text AS jackpot
      FROM "Event"
      WHERE "poolAddress" = ${this.api.poolAddress} AND name = 'Harvested'
    `;
    return { treasury: BigInt(row?.treasury ?? "0"), jackpot: BigInt(row?.jackpot ?? "0") };
  }

  /** Reads the chain, since the timeouts and request times are not indexed. */
  private async stuck(indexed: boolean): Promise<Stuck | null> {
    if (!indexed) return NOT_STUCK;
    try {
      const { connection, program } = this.chain;
      const poolKey = this.chain.poolAddress();
      const [poolInfo, clockInfo] = await connection.getMultipleAccountsInfo([poolKey, SYSVAR_CLOCK_PUBKEY]);
      if (!poolInfo) return NOT_STUCK;
      const pool = decodePool(program, poolKey, poolInfo.data);
      const wanted = [
        ...(pool.openRoundId > 0n ? [this.chain.roundAddress(pool.openRoundId)] : []),
        ...(pool.currentEpochId > 1n ? [this.chain.epochAddress(pool.currentEpochId - 1n)] : []),
      ];
      const infos = wanted.length > 0 ? await connection.getMultipleAccountsInfo(wanted) : [];
      const roundInfo = pool.openRoundId > 0n ? infos[0] : null;
      const epochInfo = pool.currentEpochId > 1n ? infos[infos.length - 1] : null;
      const testVrf = program.idl.instructions.some((ix) => ix.name === "testFulfill");
      return await findStuck({
        now: clockUnixTimestamp(clockInfo?.data),
        pool,
        openRound: roundInfo ? decodeRound(program, roundInfo.data) : null,
        previousEpoch: epochInfo ? decodeEpoch(program, epochInfo.data) : null,
        fulfilled: async (seed) =>
          isFulfilled((await connection.getAccountInfo(randomnessAddress(this.chain.programId, seed, testVrf)))?.data),
      });
    } catch (cause) {
      this.logger.warn(`stuck check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }
}
