import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  EPOCH_STATUS,
  type EpochState,
  type PoolState,
} from "../operator/chain-state";
import { isFulfilled, randomnessAddress } from "../operator/vrf";
import { HARVEST_LEAD_SECONDS } from "../operator/venue";
import { VENUE_LOCK_SECONDS } from "../chain/venue-kind";
import { principalDrift, type PrincipalDrift } from "../ledger/ledger-store";
import { PrismaService } from "../prisma/prisma.service";
import { isOperatorFailing, isOperatorStale, operatorAges } from "./alerts.controller";
import { ApiService } from "./api.service";
import { supplyRateBps } from "./live-yield";
import { TodoClock, todoDrafts, type TodoInput, type TodoItem } from "./ops-todo";

/** The epoch a permissionless crank would accept right now. */
export interface StuckItem {
  id: bigint;
  status: number;
}

export interface Stuck {
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

/** The open venue proposal (venue-switch ticket 03). `unlocksAt` is chain unix
 *  seconds: `proposedAt` plus the program's 48 hour lock. */
export interface VenueProposalSummary {
  venueKind: number;
  klendProgram: string;
  klendMarket: string;
  klendReserve: string;
  klendCtoken: string;
  proposedAt: bigint;
  unlocksAt: bigint;
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
  /** The hot crank key; may call `drain_venue` at any time. Null before the pool is indexed. */
  operatorKey: string | null;
  /** Null before the pool is indexed. */
  venueParams: VenueParams | null;
  /** The venue kind the pool is on now. Null before the pool is indexed. */
  venueKind: number | null;
  /** The open proposal, or null when none is. */
  venueProposal: VenueProposalSummary | null;
  /** klend's supply rate in basis points. Null when the reserve is unreadable. */
  supplyRateBps: number | null;
  /** Lifetime `fee_paid` and `prize_paid`, summed from indexed `Harvested` events. */
  harvestedToTreasury: bigint;
  harvestedToJackpot: bigint;
  /** Null when the chain read failed, so the console shows "unknown" rather
   *  than a clean pool. The failure is logged. */
  stuck: Stuck | null;
  /** Actions due on the pool, from the Operator's own rules. Empty before the pool is indexed. */
  todo: TodoItem[];
  /** `OPS_WALLETS` as base58: the wallets `POST /ops/fast-pause` accepts. Empty when unset. */
  fastPauseWallets: string[];
  /** Wallets whose ledger Principal differs from their Player's: the total and the first few by
   *  wallet, with both figures (audit-2026-10-09 07). */
  ledgerDrift: { count: number; wallets: PrincipalDrift[] };
}

/** How many drifting wallets the summary lists. */
export const LEDGER_DRIFT_LISTED = 5;

export type OpsSummary = Awaited<ReturnType<ApiService["getStatus"]>> & OpsSummaryExtras;

const NOT_STUCK: Stuck = { epoch: null };

/** What one chain read gives the summary: the stuck check and the todo list share it. */
interface ChainView {
  stuck: Stuck;
  chain: TodoInput["chain"];
}

/**
 * Mirrors the program's own gates in `rollover_epoch`, so the console offers a
 * crank only when the program would take it. A fulfilled request is never
 * stuck: `draw` takes it instead.
 */
export async function findStuck(input: {
  now: bigint;
  pool: Pick<PoolState, "vrfTimeout" | "payoutTimeout" | "jackpotPaused">;
  previousEpoch: EpochState | null;
  fulfilled: (seed: Uint8Array) => Promise<boolean>;
}): Promise<Stuck> {
  const { now, pool, previousEpoch, fulfilled } = input;

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
    epoch: previousEpoch && stuckEpoch ? { id: previousEpoch.epochId, status: previousEpoch.status } : null,
  };
}

/** The Ops console's single poll: `GET /status` plus what it lacks. */
@Injectable()
export class OpsSummaryService {
  private readonly logger = new Logger(OpsSummaryService.name);
  private readonly todoClock = new TodoClock();
  private readonly tickStaleSeconds: number;
  private readonly fastPauseWallets: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: ApiService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.tickStaleSeconds = config.get("ALERT_TICK_STALE_S", { infer: true });
    this.fastPauseWallets = config.get("OPS_WALLETS", { infer: true }) ?? [];
  }

  async getOpsSummary(): Promise<OpsSummary> {
    const poolAddress = this.api.poolAddress;
    const status = await this.api.getStatus();
    const pool = await this.prisma.pool.findUnique({ where: { address: poolAddress } });
    // Cached for BALANCES_TTL_MS and already warm from getStatus, so this is
    // the same reserve read, not a second RPC call.
    const reserve = (await this.api.chainBalances(pool?.klendReserve)).reserve;
    const [harvested, view, proposal, ledgerDrift] = await Promise.all([
      this.harvestedTotals(),
      this.chainView(pool !== null),
      this.prisma.venueProposal.findUnique({ where: { poolAddress } }),
      principalDrift(this.prisma, poolAddress, LEDGER_DRIFT_LISTED),
    ]);
    const stuck = view === null ? null : view.stuck;
    const todo =
      pool === null
        ? []
        : await this.todo({
            chain: view === null ? null : view.chain,
            vaultBalance: status.vaultLiquidity,
            proposal,
            stuck,
            deficit: pool.deficit,
            impaired: pool.impaired,
            currentEpochId: pool.currentEpochId,
            status,
          });
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
      operatorKey: pool?.operator ?? null,
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
      venueKind: pool?.venueKind ?? null,
      venueProposal:
        proposal === null
          ? null
          : {
              venueKind: proposal.venueKind,
              klendProgram: proposal.klendProgram,
              klendMarket: proposal.klendMarket,
              klendReserve: proposal.klendReserve,
              klendCtoken: proposal.klendCtoken,
              proposedAt: proposal.proposedAt,
              unlocksAt: proposal.proposedAt + VENUE_LOCK_SECONDS,
            },
      supplyRateBps: reserve === null ? null : supplyRateBps(reserve),
      harvestedToTreasury: harvested.treasury,
      harvestedToJackpot: harvested.jackpot,
      stuck,
      todo,
      fastPauseWallets: this.fastPauseWallets,
      ledgerDrift,
    };
  }

  /** The todo list with `due` set. The two DB reads are the Operator's own queries, mirrored. */
  private async todo(input: {
    chain: TodoInput["chain"];
    vaultBalance: bigint | null;
    proposal: TodoInput["proposal"];
    stuck: Stuck | null;
    deficit: bigint;
    impaired: boolean;
    currentEpochId: bigint;
    status: Awaited<ReturnType<ApiService["getStatus"]>>;
  }): Promise<TodoItem[]> {
    const { chain, status } = input;
    const poolAddress = this.api.poolAddress;
    const windowOpensAt = chain?.currentEpoch ? chain.currentEpoch.endsAt - HARVEST_LEAD_SECONDS : null;
    const [players, harvests] = await Promise.all([
      // Impaired, the Operator pays nothing (every payout is the owner's to sign).
      input.impaired
        ? []
        : this.prisma.player.findMany({
            where: { poolAddress, pendingWithdraw: { gt: 0 }, pendingEpoch: { lt: input.currentEpochId } },
            orderBy: { pendingEpoch: "asc" },
            select: { owner: true, pendingWithdraw: true },
          }),
      windowOpensAt === null
        ? 0
        : this.prisma.event.count({
            where: { poolAddress, name: "Harvested", blockTime: { gte: windowOpensAt } },
          }),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ages = operatorAges(status.operator, nowSeconds);
    return this.todoClock.mark(
      todoDrafts({
        chain,
        vaultBalance: input.vaultBalance,
        proposal: input.proposal,
        harvestedThisWindow: harvests > 0,
        stuck: input.stuck,
        deficit: input.deficit,
        dueWithdrawals: players.map((player) => ({ owner: player.owner, amount: player.pendingWithdraw })),
      }),
      {
        operatorDown:
          isOperatorStale({ ...ages, shutdown: status.shutdown }, this.tickStaleSeconds) ||
          isOperatorFailing(ages),
        nowSeconds,
        tickStaleSeconds: this.tickStaleSeconds,
      },
    );
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

  /** Reads the chain, since the timeouts and request times are not indexed.
   *  Null when the read failed. */
  private async chainView(indexed: boolean): Promise<ChainView | null> {
    if (!indexed) return { stuck: NOT_STUCK, chain: null };
    try {
      const { connection, program } = this.chain;
      const poolKey = this.chain.poolAddress();
      const [poolInfo, clockInfo] = await connection.getMultipleAccountsInfo([poolKey, SYSVAR_CLOCK_PUBKEY]);
      if (!poolInfo) return { stuck: NOT_STUCK, chain: null };
      const pool = decodePool(program, poolKey, poolInfo.data);
      const wanted = [
        ...(pool.currentEpochId > 1n ? [this.chain.epochAddress(pool.currentEpochId - 1n)] : []),
        ...(pool.currentEpochId > 0n ? [this.chain.epochAddress(pool.currentEpochId)] : []),
      ];
      const infos = wanted.length > 0 ? await connection.getMultipleAccountsInfo(wanted) : [];
      const epochInfo = pool.currentEpochId > 1n ? infos[0] : null;
      const currentInfo = pool.currentEpochId > 0n ? infos[infos.length - 1] : null;
      const testVrf = program.idl.instructions.some((ix) => ix.name === "testFulfill");
      const now = clockUnixTimestamp(clockInfo?.data);
      const previousEpoch = epochInfo ? decodeEpoch(program, epochInfo.data) : null;
      return {
        chain: { pool, now, currentEpoch: currentInfo ? decodeEpoch(program, currentInfo.data) : null },
        stuck: await findStuck({
          now,
          pool,
          previousEpoch,
          fulfilled: async (seed) =>
            isFulfilled((await connection.getAccountInfo(randomnessAddress(this.chain.programId, seed, testVrf)))?.data),
        }),
      };
    } catch (cause) {
      this.logger.warn(`stuck check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }
}
