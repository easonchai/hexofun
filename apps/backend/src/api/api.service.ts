import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type Cursor,
  type Epoch,
  type OperatorState,
  type Player,
  type Pool,
  type Round,
} from "@prisma/client";
import { unpackAccount } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import { rpcStatus } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { clockUnixTimestamp } from "../operator/chain-state";
import { PrismaService } from "../prisma/prisma.service";

/** Mirrors programs/hex_vault/src/constants.rs `epoch_status`. */
export const EPOCH_OPEN = 0;
export const EPOCH_REGISTERING = 1;
export const EPOCH_DRAWING = 2;

/** Mirrors programs/hex_vault/src/constants.rs `round_status`. */
export const ROUND_OPEN = 0;
export const ROUND_REQUESTED = 1;

/** Events the frontend feed shows. Anything else is operator noise. */
const FEED_NAMES = [
  "Deposited",
  "Withdrawn",
  "PositionBought",
  "RoundSettled",
  "JackpotPaid",
  "EpochRolledOver",
] as const;

/** How long a `getSlot` probe answers for. `rpcOk` only needs to be roughly right. */
const RPC_PROBE_TTL_MS = 300_000;

/**
 * How long the chain clock read behind live weights and `/state`'s `chainTime`
 * answers for. `extrapolatedChainNow` advances a cache hit by the wall time
 * since it was observed, so the served second stays live across the whole
 * window; the read only re-grounds the value against the chain's own phase.
 * It was 2 s, which matched the browser's poll interval exactly and so cost a
 * chain read on nearly every poll — 27 calls a minute for as long as one tab
 * stayed open, the largest single item in the RPC bill. The browser anchors
 * its countdown once per round now (`useChainClock.ts`), and chain time gains
 * only 0.19% on wall time, so a longer window changes nothing it shows.
 */
export const CHAIN_CLOCK_TTL_MS = 30_000;

/**
 * How long the jackpot vault balance read behind the open epoch's amount
 * answers for. Longer than the clock's: the vault only moves when the
 * operator tops it up (once per epoch) or the payout drains it, so a 2 s
 * window bought nothing and cost 30 chain calls a minute for as long as one
 * browser tab stayed open.
 */
export const JACKPOT_BALANCE_TTL_MS = 15_000;

/**
 * How long the principal vault balance and the operator's SOL answer for.
 * Same reasoning as the jackpot's: both move a handful of times an epoch,
 * and /status is polled every two seconds by every open tab.
 */
export const BALANCES_TTL_MS = 15_000;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const toBigInt = (value: Prisma.Decimal): bigint => BigInt(value.toFixed());

/**
 * A player's Weight for one epoch at instant `at`, following the touch rule in
 * spec.md §2.2 without needing the player to have been touched. Four cases:
 * the epoch is already frozen, the player is accruing in it, the player last
 * acted before it (so Entries equalled Principal throughout), or the player
 * has already moved past it without freezing it, which is zero.
 */
export function weightAt(
  player: Player,
  epochId: bigint,
  epochStart: bigint,
  at: bigint,
): bigint {
  if (player.frozenEpoch === epochId) return toBigInt(player.frozenWeight);
  if (player.epochId === epochId) {
    const elapsed = at - player.lastUpdate;
    if (elapsed <= 0n) return toBigInt(player.weightAcc);
    return toBigInt(player.weightAcc) + player.entries * elapsed;
  }
  if (player.epochId < epochId) {
    const elapsed = at - epochStart;
    return elapsed <= 0n ? 0n : player.principal * elapsed;
  }
  return 0n;
}

/**
 * `bought_epoch`/`bought_amount`, `bonus_epoch`/`bonus_granted` and
 * `yield_epoch` reset lazily on chain, the next time the matching
 * instruction runs for a stale epoch, not the moment the epoch turns over.
 * A read has to apply the same gate: a counter left over from a past epoch
 * reads as though it were already reset to 0.
 */
function ifCurrentEpoch(counterEpoch: bigint, currentEpochId: bigint, value: bigint): bigint {
  return counterEpoch === currentEpochId ? value : 0n;
}

/**
 * Atomic USDC one day of Base yield would cost the whole pool at the
 * current rate: `total_principal × base_rate_bps / (10_000 × 365)`. Same
 * per-second rate `register` applies (`10_000 × 31_536_000` seconds in a
 * year), and 31_536_000 / 86_400 is exactly 365, so a full epoch's cost
 * scales by 365 rather than the longer seconds-per-year fraction.
 */
export function oneDayYieldCost(totalPrincipal: bigint, baseRateBps: number): bigint {
  return (totalPrincipal * BigInt(baseRateBps)) / (10_000n * 365n);
}

/** Pool-wide `grant_tickets` cap for one epoch, mirroring the on-chain
 *  `pool_bonus_cap`. */
export function poolBonusCap(totalPrincipal: bigint, bonusCapBps: number): bigint {
  return (totalPrincipal * BigInt(bonusCapBps)) / 10_000n;
}

export interface PrincipalOutInputs {
  readonly totalPrincipal: bigint;
  readonly pendingWithdrawals: bigint;
  readonly yieldBudget: bigint;
  readonly vaultAmount: bigint;
}

/**
 * How much Principal is out of the pool (ops-and-envs ticket 08): absent an
 * `admin_withdraw` deployment, `sweep_house`'s own invariant is that the
 * principal vault holds exactly `total_principal + pending_withdrawals +
 * yield_budget`. Whatever the vault falls short of that by is principal
 * pulled out and not yet returned. Shared by `/status` and the admin CLI's
 * `principal-out`/`return-principal` commands, so both report the same
 * figure off the same rule.
 *
 * Clamped at 0: a vault that holds more than this (say, a deposit landed
 * after `vaultAmount` was read) is not principal out, just a stale read.
 */
export function principalOut({
  totalPrincipal,
  pendingWithdrawals,
  yieldBudget,
  vaultAmount,
}: PrincipalOutInputs): bigint {
  const owed = totalPrincipal + pendingWithdrawals + yieldBudget;
  return owed > vaultAmount ? owed - vaultAmount : 0n;
}

/** Share of the total as a percentage with two decimals, e.g. "12.34". */
export function oddsPercent(weight: bigint, total: bigint): string {
  if (total <= 0n || weight <= 0n) return "0.00";
  const basisPoints = (weight * 10_000n) / total;
  const whole = basisPoints / 100n;
  const fraction = basisPoints % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

interface LiveWeight {
  player: Player;
  /** Weight accrued so far this epoch. */
  liveWeight: bigint;
  /**
   * Weight the player will hold at the draw if nobody touches their account
   * again. Odds come from this share, not the live one: the live share
   * crawls every second as late depositors catch up (a 22.57% that reads
   * 22.64% a minute later), while this one only moves when someone
   * deposits, withdraws or plays.
   */
  drawWeight: bigint;
}

interface RpcHealth {
  rpcOk: boolean;
  slot: number | null;
  /** Which RPC most recently served a call (production-hardening ticket 03):
   *  "fallback" means `RPC_FALLBACK_URL` is currently carrying traffic. */
  rpcEndpoint: "primary" | "fallback";
  /** Wall-clock instant of the last failover, or null if there has never
   *  been one. */
  rpcFallbackAt: Date | null;
}

/**
 * The two balances `/status` reports about the operator's ability to pay:
 * what the principal vault holds against the pending withdrawals, and what
 * the hot key has left for fees. Null means the read failed and the figure
 * is unknown, which /status says rather than guessing a zero. A missing
 * account is not that case: a system account nobody has funded holds exactly
 * 0 lamports, so `operatorSol` reports 0 there.
 */
interface ChainBalances {
  vaultLiquidity: bigint | null;
  operatorSol: number | null;
  /** Ticket 09: the sparring player's SOL, null when either `SPARRING_KEYPAIR`
   *  is not configured (the service is off) or the read failed — both read
   *  the same as "unknown", same as `operatorSol`. */
  sparringSol: number | null;
}

/**
 * Ticket 09: `/status`'s stable code in place of `OperatorState.lastError`'s
 * raw text. A bare identifier is an Anchor/IDL error name (`instructions.ts`'s
 * `mapSendError` puts exactly that in `Error.message`), which is already safe
 * to show — it names no host, path or account. Anything else (a network
 * error, a Postgres error, `principalVaultBalance`'s "does not exist; run
 * bootstrap first") might carry one, so it collapses to one generic code; the
 * full text still reaches the logs from the tick's own `logger.error` call.
 */
const KNOWN_ERROR_CODE = /^[A-Za-z]+$/;
export function operatorErrorCode(message: string | null): string | null {
  if (message === null) return null;
  return KNOWN_ERROR_CODE.test(message) ? message : "OPERATOR_TICK_FAILED";
}

/** The cached Clock sysvar value plus the wall-clock moment it was observed
 *  (when the read resolved, not when `CachedRead.at` below was stamped). */
interface ClockReading {
  value: bigint;
  observedAt: number;
}

/**
 * A TTL-cached read. `result` is the in-flight or last-settled promise
 * itself, not just its resolved value: every caller inside the `at` window
 * awaits that same promise, so a concurrent burst collapses to one chain
 * call instead of one per caller.
 */
interface CachedRead<T> {
  at: number;
  result: Promise<T>;
}

/** Reads for every route in spec.md §3.5 except the faucet, all from Postgres. */
@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private probe: CachedRead<RpcHealth> | undefined;
  private clock: CachedRead<ClockReading> | undefined;
  private jackpotBalance: CachedRead<bigint> | undefined;
  private balances: CachedRead<ChainBalances> | undefined;

  /**
   * The highest chain time `getState` has served. The Clock sysvar runs a
   * little behind wall time, so `extrapolatedChainNow` overshoots inside the
   * cache window and the next fresh read can land below what the previous
   * response carried. The browser anchors its countdown on the `chainTime` it
   * receives at a round boundary, so a value that went backwards made the
   * round timer start the new round with a second it had already counted.
   *
   * ponytail: a high-water mark that never resets. A validator restart that
   * rewinds the chain clock pins it until the backend restarts; only local
   * validators do that.
   */
  private lastServedChainTime = 0n;

  /** SOL below which `/status` flags the operator as running dry. Also the
   *  threshold for the sparring player (ticket 09): both are hot keys paying
   *  their own fees, and spec.md names no separate figure for the second. */
  private readonly operatorSolWarn: number;
  /** Ticket 09: the sparring player's public key, decoded the same way
   *  `SparringService` does, or null when `SPARRING_KEYPAIR` is not set (the
   *  service is off, so there is nothing to alert on). */
  private readonly sparringPubkey: PublicKey | null;

  /** Beta-launch-fixes ticket 05: when configured, the ISO timestamp
   *  `/state` and `/status` report so the web can render a launch countdown
   *  while the Pool has no Epoch yet. Null when `LAUNCH_AT` is unset. */
  private readonly launchAt: string | null;

  /** The Active pool's address as base58. The database may also hold
   *  retired pools' rows, so every read of a pool-scoped table filters on
   *  this (ADR 0016). Public so AlertsController scopes its Event read the
   *  same way. */
  readonly poolAddress: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.poolAddress = chain.poolAddress().toBase58();
    this.operatorSolWarn = config.get("OPERATOR_SOL_WARN", { infer: true });
    const launchAt = config.get("LAUNCH_AT", { infer: true });
    this.launchAt = typeof launchAt === "string" && launchAt.length > 0 ? launchAt : null;
    // Same rule as `SparringService`: a keypair alone does not start it, so a
    // service that is off has no SOL balance to alert on.
    const sparringSecret = config.get("SPARRING_KEYPAIR", { infer: true });
    this.sparringPubkey = sparringSecret && config.get("SPARRING_ENABLED", { infer: true })
      ? Keypair.fromSecretKey(bs58.decode(sparringSecret)).publicKey
      : null;
  }

  async getPool() {
    const pool = await this.requirePool();
    const poolAddress = this.poolAddress;
    const [currentEpoch, openRound] = await Promise.all([
      this.prisma.epoch.findUnique({
        where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
      }),
      this.prisma.round.findFirst({
        where: { poolAddress, status: { in: [ROUND_OPEN, ROUND_REQUESTED] } },
        orderBy: { id: "desc" },
      }),
    ]);
    return {
      pool,
      currentEpoch,
      openRound: openRound === null ? null : summarizeRound(openRound),
    };
  }

  getEpochs(limit: number): Promise<Epoch[]> {
    return this.prisma.epoch.findMany({
      where: { poolAddress: this.poolAddress },
      orderBy: { id: "desc" },
      take: limit,
    });
  }

  async getCurrentEpoch() {
    const pool = await this.requirePool();
    const epoch = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress: this.poolAddress, id: pool.currentEpochId } },
    });
    if (epoch === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }
    return {
      ...epoch,
      jackpotAmount: await this.liveJackpot(epoch),
      drawing: await this.drawingProgress(pool),
    };
  }

  /**
   * `Epoch.jackpot_amount` is a snapshot the program takes once, at
   * `close_registration`. While the epoch is still open it is 0 on chain no
   * matter what `fund_jackpot` has moved into the vault, so the open epoch
   * reports the vault's token balance instead. From REGISTERING on the chain
   * value is authoritative (the vault drains to the winner at payout).
   */
  private async liveJackpot(epoch: Epoch): Promise<bigint> {
    if (epoch.status !== EPOCH_OPEN) return epoch.jackpotAmount;
    try {
      return await this.cachedJackpotBalance();
    } catch (error: unknown) {
      // This fallback never enters the cache. cachedJackpotBalance clears a
      // failed read, so the next request retries the chain.
      this.logger.warn(
        `jackpot vault balance read failed, serving the indexed snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return epoch.jackpotAmount;
    }
  }

  /**
   * The chain call `liveJackpot` caches. Unlike `chainNow`/`rpcHealth`
   * below, a failed read clears the slot instead of sitting in it for the
   * rest of the window: the next call retries the chain rather than
   * repeating the same failure, and `liveJackpot`'s fallback is computed
   * above from the failed promise, so it never becomes the cached value
   * itself. A concurrent burst inside the window still shares one chain
   * call: every caller reads the same pending promise before it settles.
   */
  private cachedJackpotBalance(): Promise<bigint> {
    if (
      this.jackpotBalance === undefined ||
      Date.now() - this.jackpotBalance.at > JACKPOT_BALANCE_TTL_MS
    ) {
      const result = this.chain.connection
        .getTokenAccountBalance(this.chain.jackpotVaultAddress())
        .then(({ value }) => BigInt(value.amount));
      const entry: CachedRead<bigint> = { at: Date.now(), result };
      this.jackpotBalance = entry;
      result.catch(() => {
        if (this.jackpotBalance === entry) this.jackpotBalance = undefined;
      });
    }
    return this.jackpotBalance.result;
  }

  getRounds(limit: number): Promise<Round[]> {
    return this.prisma.round.findMany({
      where: { poolAddress: this.poolAddress },
      orderBy: { id: "desc" },
      take: limit,
    });
  }

  async getRound(id: bigint): Promise<Round> {
    const round = await this.prisma.round.findUnique({
      where: { poolAddress_id: { poolAddress: this.poolAddress, id } },
    });
    if (round === null) {
      throw new NotFoundException(`No round ${id}. Check the round id and retry.`);
    }
    return round;
  }

  async getPlayer(owner: string) {
    const { weights, total } = await this.liveWeights();
    const mine = weights.find((entry) => entry.player.owner === owner);
    if (mine === undefined) {
      throw new NotFoundException(
        "No Player account for that wallet yet. Deposit to open one.",
      );
    }
    const [pool, yieldStats] = await Promise.all([
      this.requirePool(),
      this.playerYieldStats(owner, mine.player.yieldEpoch),
    ]);
    return {
      ...playerDto(mine, total),
      ...playerTicketExtras(mine.player, pool.currentEpochId),
      ...yieldStats,
    };
  }

  /**
   * `yieldLastEpoch` (what `register` credited this owner in
   * `player.yieldEpoch`, the most recent epoch a credit landed) and
   * `yieldToDate` (every credit ever), summed from the `YieldCredited`
   * event log the same way `getPositionCounts` sums `PositionBought`. Active
   * pool only: epoch ids restart per pool, so a retired pool's rows would
   * collide with `yieldEpoch` (ADR 0016).
   */
  private async playerYieldStats(
    owner: string,
    yieldEpoch: bigint,
  ): Promise<{ yieldToDate: bigint; yieldLastEpoch: bigint }> {
    const rows = await this.prisma.$queryRaw<
      { yieldToDate: string; yieldLastEpoch: string }[]
    >`
      SELECT
        COALESCE(SUM((data->>'amount')::numeric), 0)::text AS "yieldToDate",
        COALESCE(SUM((data->>'amount')::numeric) FILTER (
          WHERE (data->>'epochId')::bigint = ${yieldEpoch}
        ), 0)::text AS "yieldLastEpoch"
      FROM "Event"
      WHERE "poolAddress" = ${this.poolAddress}
        AND name = 'YieldCredited' AND data->>'owner' = ${owner}
    `;
    const row = rows[0];
    return {
      yieldToDate: BigInt(row?.yieldToDate ?? "0"),
      yieldLastEpoch: BigInt(row?.yieldLastEpoch ?? "0"),
    };
  }

  /**
   * Ticket 06: Pool, current Epoch, open Round, Player and operator status
   * from one point-in-time snapshot. Every DB read this needs — including
   * the previous epoch and player scan that `drawingProgress`/`liveWeights`
   * would otherwise re-read on their own connections — goes through one
   * `RepeatableRead` transaction; the player scan only runs when an owner is
   * given or the previous epoch is mid-draw. The chain-cached reads (jackpot
   * balance, rpc health, clock, pool config) run after the transaction closes.
   *
   * Ticket 07: `roundId`, when given, also returns that Round's full state —
   * any status, winning tile and tile totals included — as `round`, plus
   * `owner`'s Position in it. `openRound` stays filtered to Open/Requested
   * (an existing contract other callers rely on), so it goes null the moment
   * a Round settles; `round` is how the browser keeps watching the same
   * Round through settlement without a chain read, and how it learns the
   * viewer's Position once that Round is no longer the open one. Falls back
   * to the open Round's id when `roundId` is not given, so a first load with
   * no known id yet still gets a Position for whatever Round is open.
   */
  async getState(owner?: string, roundId?: bigint) {
    const { pool, epoch, previousEpoch, openRound, operator, cursor, players, round, position } =
      await this.prisma.$transaction(
        async (tx) => {
          const poolAddress = this.poolAddress;
          const pool = await tx.pool.findUnique({ where: { address: poolAddress } });
          if (pool === null) {
            throw new NotFoundException(
              "The pool is not indexed yet. Try again in a few seconds.",
            );
          }
          const [epoch, previousEpoch, openRound, operator, cursor] = await Promise.all([
            tx.epoch.findUnique({
              where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
            }),
            pool.currentEpochId <= 0n
              ? Promise.resolve(null)
              : tx.epoch.findUnique({
                  where: { poolAddress_id: { poolAddress, id: pool.currentEpochId - 1n } },
                }),
            tx.round.findFirst({
              where: { poolAddress, status: { in: [ROUND_OPEN, ROUND_REQUESTED] } },
              orderBy: { id: "desc" },
            }),
            tx.operatorState.findUnique({ where: { poolAddress } }),
            tx.cursor.findUnique({ where: { poolAddress } }),
          ]);
          const needsPlayers =
            owner !== undefined ||
            (previousEpoch !== null &&
              (previousEpoch.status === EPOCH_REGISTERING ||
                previousEpoch.status === EPOCH_DRAWING));
          const trackedRoundId = roundId ?? openRound?.id;
          const [players, round, position] = await Promise.all([
            needsPlayers ? tx.player.findMany({ where: { poolAddress } }) : Promise.resolve([]),
            trackedRoundId === undefined
              ? Promise.resolve(null)
              : tx.round.findUnique({
                  where: { poolAddress_id: { poolAddress, id: trackedRoundId } },
                }),
            owner === undefined || trackedRoundId === undefined
              ? Promise.resolve(null)
              : tx.position.findFirst({
                  where: { poolAddress, owner, roundId: trackedRoundId },
                }),
          ]);
          return { pool, epoch, previousEpoch, openRound, operator, cursor, players, round, position };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    // Ticket 05: `epoch === null` while `currentEpochId` is still 0 means the
    // Pool has never had an Epoch yet (deposit-only launch week), not that
    // the indexer is behind — that only applies once an Epoch id exists to
    // mirror. The null branch below carries `launchAt` instead of 404ing.
    if (epoch === null && pool.currentEpochId > 0n) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }

    // The accounts a player transaction actually writes (deposit/withdraw:
    // pool + principal vault; buyTickets: pool + jackpot vault; buyPosition:
    // pool + the open round), so `priorityFeeMicroLamports` prices the fee
    // market they compete in rather than an unscoped network-wide estimate
    // (production-hardening ticket 08, research/notes/transactions_and_rpc.md
    // "Fee markets are local"). `priorityFeeMicroLamports` never rejects —
    // it falls back to 0 on any read failure (chain.service.ts) — so /state
    // never fails because of this.
    const poolAddress = new PublicKey(pool.address);
    const hotWritableAccounts = [
      poolAddress,
      this.chain.principalVaultAddress(poolAddress),
      this.chain.jackpotVaultAddress(poolAddress),
      ...(openRound === null ? [] : [this.chain.roundAddress(openRound.id, poolAddress)]),
    ];

    const [jackpotAmount, rpc, chainTime, balances, priorityFeeMicroLamports] = await Promise.all([
      epoch === null ? Promise.resolve(0n) : this.liveJackpot(epoch),
      this.rpcHealth(),
      this.extrapolatedChainNow(),
      this.chainBalances(),
      this.chain.priorityFeeMicroLamports(hotWritableAccounts),
    ]);

    // Same extrapolated instant for the response's chainTime and for the
    // Player's liveWeight, so the two never disagree by the clock's TTL.
    // Ticket 05: no Epoch yet means no Weight has ever started accruing, so
    // every player's live and draw weight is 0 rather than undefined.
    const { weights, total } =
      epoch === null ? { weights: [], total: 0n } : weightsFrom(players, epoch, chainTime);
    const mine =
      owner === undefined
        ? undefined
        : (weights.find((entry) => entry.player.owner === owner) ??
          (epoch === null
            ? players
                .filter((player) => player.owner === owner)
                .map((player) => ({ player, liveWeight: 0n, drawWeight: 0n }))[0]
            : undefined));

    return {
      pool,
      currentEpoch:
        epoch === null
          ? null
          : {
              ...epoch,
              jackpotAmount,
              drawing: drawingProgressFrom(previousEpoch, players),
            },
      openRound: openRound === null ? null : summarizeRound(openRound),
      round,
      player: mine === undefined ? null : playerDto(mine, total),
      position:
        position === null ? null : { tiles: position.tiles, stakePerTile: position.stakePerTile },
      status: statusFrom(operator, cursor, rpc, pool, balances, this.operatorSolWarn),
      chainTime,
      /** Ticket 04's cached estimate, scoped to `hotWritableAccounts` above.
       *  Untrusted by the time it reaches the browser: the web send helper
       *  caps and validates it before signing (ticket 08). */
      priorityFeeMicroLamports,
      /** Ticket 05: the deposit-only launch week's countdown target; null
       *  once an Epoch exists or `LAUNCH_AT` is unset. */
      launchAt: epoch === null ? this.launchAt : null,
    };
  }

  async getLeaderboard(limit: number) {
    const { weights, total } = await this.liveWeights();
    return weights
      .slice()
      .sort((a, b) => {
        // Ticket 01: a tie (most commonly two players at 0% before any
        // Round opens) otherwise falls back to whatever order the DB
        // returned, which is not guaranteed stable across requests. House
        // always sorts last among ties; real players break ties by owner
        // so the order is deterministic and the test is stable.
        if (b.drawWeight !== a.drawWeight) return b.drawWeight > a.drawWeight ? 1 : -1;
        if (a.player.isHouse !== b.player.isHouse) return a.player.isHouse ? 1 : -1;
        return a.player.owner < b.player.owner ? -1 : a.player.owner > b.player.owner ? 1 : 0;
      })
      .slice(0, limit)
      .map(({ player, liveWeight, drawWeight }) => ({
        owner: player.owner,
        principal: player.principal,
        entries: player.entries,
        isHouse: player.isHouse,
        liveWeight,
        odds: oddsPercent(drawWeight, total),
      }));
  }

  /**
   * Newest first. A settled Position that won nothing is not news, so the
   * reward filter runs in Postgres: filtering it in JS would silently return
   * fewer than `limit` rows on a board where most positions lose.
   *
   * `owner`, when given, keeps only events about that wallet. `JackpotPaid`
   * carries `winner` rather than `owner`, so both keys are checked; dropping
   * the `winner` half would make a "Prize Win" row vanish from that wallet's
   * filtered history. No GIN index on `data`: a seq scan is fine at demo scale.
   */
  getFeed(limit: number, owner?: string): Promise<FeedRow[]> {
    const ownerFilter =
      owner === undefined
        ? Prisma.empty
        : Prisma.sql`AND (data->>'owner' = ${owner} OR data->>'winner' = ${owner})`;
    return this.prisma.$queryRaw<FeedRow[]>`
      SELECT slot, signature, "index", name, data, "blockTime"
      FROM "Event"
      WHERE "poolAddress" = ${this.poolAddress}
        AND (name IN (${Prisma.join(FEED_NAMES)})
         OR (name = 'PositionSettled' AND data->>'reward' ~ '^[1-9][0-9]*$'))
      ${ownerFilter}
      ORDER BY slot DESC, "index" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Distinct rounds played per owner, ever. `Position` cannot answer this:
   * `settle_position`/`void_round` close the account and the indexer drops
   * the row with it (indexer.service.ts `syncAccounts`), so a Position-backed
   * count reads 0 for exactly the settled rounds a "Past Winners" row is
   * about. `PositionBought` is append-only history instead, so this counts
   * from the Event log: `{ roundId, owner, tiles, stakePerTile, total }`,
   * both camelCase per `decode.ts`'s `jsonify` (checked against
   * `decode.test.ts`'s fixture, not assumed).
   *
   * DISTINCT on `roundId`: a player can buy more than once in the same round
   * (adding tiles to the same Position account), each a separate
   * `PositionBought` event, so counting rows would overcount rounds. Round
   * ids restart per pool, so this counts the Active pool only (ADR 0016).
   */
  async getPositionCounts(owners: string[]): Promise<{ counts: Record<string, number> }> {
    const rows = await this.prisma.$queryRaw<{ owner: string; rounds: number }[]>`
      SELECT data->>'owner' AS owner, COUNT(DISTINCT data->>'roundId')::int AS rounds
      FROM "Event"
      WHERE "poolAddress" = ${this.poolAddress}
        AND name = 'PositionBought' AND data->>'owner' IN (${Prisma.join(owners)})
      GROUP BY data->>'owner'
    `;
    const byOwner = new Map(rows.map((row) => [row.owner, row.rounds]));
    const counts = Object.fromEntries(owners.map((owner) => [owner, byOwner.get(owner) ?? 0]));
    return { counts };
  }

  async getStatus() {
    const poolAddress = this.poolAddress;
    // A freshly cut-over pool has no OperatorState or Cursor row until its
    // first tick and sync; statusFrom reads those nulls as "never ran"
    // rather than showing the retired pool's (ADR 0016).
    const [operator, cursor, pool, rpc, balances] = await Promise.all([
      this.prisma.operatorState.findUnique({ where: { poolAddress } }),
      this.prisma.cursor.findUnique({ where: { poolAddress } }),
      this.prisma.pool.findUnique({ where: { address: poolAddress } }),
      this.rpcHealth(),
      this.chainBalances(),
    ]);
    // Ticket 09: the current epoch's own close deadline and jackpot, for the
    // near-close alert conditions. One extra row read, gated on a pool
    // actually being indexed, same tolerance as the rest of this method.
    const epoch =
      pool === null
        ? null
        : await this.prisma.epoch.findUnique({
            where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
          });
    return {
      ...statusFrom(operator, cursor, rpc, pool, balances, this.operatorSolWarn),
      ...(await this.yieldStatus(pool)),
      // Ticket 05: null once the Pool has an Epoch, or when `LAUNCH_AT` is
      // unset — the same rule `/state`'s `launchAt` follows.
      launchAt: pool !== null && pool.currentEpochId > 0n ? null : this.launchAt,
      epochEndsAt: epoch?.endsAt ?? null,
      epochStatus: epoch?.status ?? null,
      jackpotAmount: epoch === null ? null : await this.liveJackpot(epoch),
      minJackpot: pool?.minJackpot ?? 0n,
    };
  }

  /**
   * `yieldBudget`, `yieldShortfall` (the last ended epoch's uncredited Base
   * yield), `bonusGrantedToday`, `bonusCap`, and `yieldBudgetLow` for
   * GET /status (ticket 05). Null pool (not indexed yet) reads as every
   * figure being 0/false rather than throwing, matching the rest of
   * `getStatus`, which already tolerates a missing pool row.
   */
  private async yieldStatus(pool: Pool | null): Promise<{
    yieldBudget: bigint;
    yieldShortfall: bigint;
    bonusGrantedToday: bigint;
    bonusCap: bigint;
    yieldBudgetLow: boolean;
  }> {
    if (pool === null) {
      return {
        yieldBudget: 0n,
        yieldShortfall: 0n,
        bonusGrantedToday: 0n,
        bonusCap: 0n,
        yieldBudgetLow: false,
      };
    }
    return {
      yieldBudget: pool.yieldBudget,
      yieldShortfall: await this.lastEpochYieldShortfall(pool.currentEpochId),
      bonusGrantedToday: ifCurrentEpoch(pool.bonusEpoch, pool.currentEpochId, pool.bonusGranted),
      bonusCap: poolBonusCap(pool.totalPrincipal, pool.bonusCapBps),
      yieldBudgetLow: pool.yieldBudget < oneDayYieldCost(pool.totalPrincipal, pool.baseRateBps),
    };
  }

  /**
   * Σ `YieldCredited.shortfall` for the epoch `register` last credited
   * (`currentEpochId - 1`, "yesterday" in spec.md's words), from the event
   * log the same way `getPositionCounts` sums `PositionBought`. 0 before the
   * pool has completed a first epoch.
   */
  private async lastEpochYieldShortfall(currentEpochId: bigint): Promise<bigint> {
    if (currentEpochId <= 0n) return 0n;
    const lastEpoch = currentEpochId - 1n;
    const rows = await this.prisma.$queryRaw<{ shortfall: string }[]>`
      SELECT COALESCE(SUM((data->>'shortfall')::numeric), 0)::text AS shortfall
      FROM "Event"
      WHERE "poolAddress" = ${this.poolAddress}
        AND name = 'YieldCredited' AND (data->>'epochId')::bigint = ${lastEpoch}
    `;
    return BigInt(rows[0]?.shortfall ?? "0");
  }

  private async requirePool(): Promise<Pool> {
    const pool = await this.prisma.pool.findUnique({ where: { address: this.poolAddress } });
    if (pool === null) {
      throw new NotFoundException(
        "The pool is not indexed yet. Try again in a few seconds.",
      );
    }
    return pool;
  }

  /**
   * Registration and draw progress for the epoch that just ended, so the
   * Jackpot screen can show a bar instead of a spinner.
   */
  private async drawingProgress(pool: Pool) {
    if (pool.currentEpochId <= 0n) return null;
    const poolAddress = this.poolAddress;
    const previous = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress, id: pool.currentEpochId - 1n } },
    });
    const needsPlayers =
      previous !== null &&
      (previous.status === EPOCH_REGISTERING || previous.status === EPOCH_DRAWING);
    const players = needsPlayers ? await this.prisma.player.findMany({ where: { poolAddress } }) : [];
    return drawingProgressFrom(previous, players);
  }

  /**
   * ponytail: scans every Player row per request to get the odds denominator.
   * Fine for one demo pool; cache the total per epoch tick if it grows.
   */
  private async liveWeights(): Promise<{ weights: LiveWeight[]; total: bigint }> {
    const poolAddress = this.poolAddress;
    const pool = await this.requirePool();
    const epoch = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
    });
    if (epoch === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }
    const at = await this.chainNow();
    const players = await this.prisma.player.findMany({ where: { poolAddress } });
    return weightsFrom(players, epoch, at);
  }

  /**
   * The Clock sysvar's `unix_timestamp`, read the same way the operator reads
   * it (see `operator/chain-state.ts`), so Weight and odds here agree with
   * what the draw uses instead of drifting from wall time. Cached for
   * `CHAIN_CLOCK_TTL_MS` so /players and /leaderboard polling does not turn
   * into a chain read per viewer.
   */
  private async chainNow(): Promise<bigint> {
    return (await this.chainClock()).value;
  }

  /**
   * Chain time as of right now: the cached Clock sysvar value (shared with
   * `chainNow` above, so this spends no extra call) advanced by the wall
   * time elapsed since it was observed, so a cache hit never serves a
   * second that is already stale. Used only by `getState` (ticket 06).
   *
   * Clamped to `lastServedChainTime`: the advance is wall time but the chain
   * clock is not, so the two drift apart inside the window and an
   * unclamped value walks backwards across the refresh.
   */
  private async extrapolatedChainNow(): Promise<bigint> {
    const { value, observedAt } = await this.chainClock();
    const elapsedSeconds = BigInt(Math.max(0, Math.floor((Date.now() - observedAt) / 1000)));
    const extrapolated = value + elapsedSeconds;
    if (extrapolated > this.lastServedChainTime) this.lastServedChainTime = extrapolated;
    return this.lastServedChainTime;
  }

  /** `chainNow`/`extrapolatedChainNow`'s shared cache. */
  private chainClock(): Promise<ClockReading> {
    this.clock = this.cached(this.clock, CHAIN_CLOCK_TTL_MS, async () => {
      const info = await this.chain.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
      return { value: clockUnixTimestamp(info?.data), observedAt: Date.now() };
    });
    return this.clock.result;
  }

  /**
   * The principal vault's token balance and the operator's SOL. A failed
   * read reports both as null rather than a zero that would read as "the
   * vault is empty" or "the operator is out of fees"; a missing vault
   * account is the same unknown, while a missing operator account is a real
   * zero, because an unfunded system account holds no lamports.
   */
  private async chainBalances(): Promise<ChainBalances> {
    try {
      return await this.cachedBalances();
    } catch (cause) {
      // Computed off the failed promise, so it never becomes the cached
      // value: `cachedBalances` has already cleared the slot.
      this.logger.warn(
        `balance read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return { vaultLiquidity: null, operatorSol: null, sparringSol: null };
    }
  }

  /**
   * The chain call `chainBalances` caches: one `getMultipleAccountsInfo`
   * held for `BALANCES_TTL_MS`, so /status polling stays one chain call per
   * window rather than two per client. Same failure handling as
   * `cachedJackpotBalance`: a rejected read clears its slot instead of
   * sitting in it, so the next request retries the chain rather than
   * serving the same "unknown" for the rest of the window.
   */
  private cachedBalances(): Promise<ChainBalances> {
    if (
      this.balances === undefined ||
      Date.now() - this.balances.at > BALANCES_TTL_MS
    ) {
      const principalVault = this.chain.principalVaultAddress();
      const accounts = [
        principalVault,
        this.chain.keypair.publicKey,
        ...(this.sparringPubkey ? [this.sparringPubkey] : []),
      ];
      const result = this.chain.connection
        .getMultipleAccountsInfo(accounts)
        .then(([vault, fees, sparring]) => ({
          vaultLiquidity: vault ? unpackAccount(principalVault, vault).amount : null,
          operatorSol: fees ? fees.lamports / LAMPORTS_PER_SOL : 0,
          sparringSol: this.sparringPubkey === null ? null : sparring ? sparring.lamports / LAMPORTS_PER_SOL : 0,
        }));
      const entry: CachedRead<ChainBalances> = { at: Date.now(), result };
      this.balances = entry;
      result.catch(() => {
        if (this.balances === entry) this.balances = undefined;
      });
    }
    return this.balances.result;
  }

  /** Cached so /status polling at 2 s does not turn into a getSlot per client. */
  private rpcHealth(): Promise<RpcHealth> {
    this.probe = this.cached(this.probe, RPC_PROBE_TTL_MS, () => this.probeRpc());
    return this.probe.result;
  }

  /**
   * Serves `fetch()` from `cache` for `ttlMs`, replacing it with a fresh call
   * once the window lapses. Returns the new cache entry; the caller stores
   * it back on its own field since a shared private field would mix values
   * of different types across `chainNow` and `rpcHealth` above.
   * `cachedJackpotBalance` below needs a failed read to clear its slot
   * instead of sitting cached for the window, so it keeps its own copy of
   * this check rather than reusing this helper.
   */
  private cached<T>(
    cache: CachedRead<T> | undefined,
    ttlMs: number,
    fetch: () => Promise<T>,
  ): CachedRead<T> {
    if (cache === undefined || Date.now() - cache.at > ttlMs) {
      return { at: Date.now(), result: fetch() };
    }
    return cache;
  }

  private async probeRpc(): Promise<RpcHealth> {
    try {
      const slot = await this.chain.connection.getSlot();
      return { rpcOk: true, slot, ...servedBy(this.chain.connection) };
    } catch (cause) {
      // The RPC url carries the provider api key, and web3.js puts the whole
      // url in its error text, so scrub it before it reaches a log line.
      // `withRpcFallback` already redacts both endpoints' urls from an error
      // it raises itself; this covers a plain `Connection` no wrapper touched.
      const rpcUrl = this.chain.connection.rpcEndpoint;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(`getSlot failed: ${detail.split(rpcUrl).join("<rpc-url>")}`);
      return { rpcOk: false, slot: null, ...servedBy(this.chain.connection) };
    }
  }
}

/** `rpcStatus`'s fields, shaped for `/status` (ticket 03): the wrapper's
 *  epoch-ms `fallbackAt` becomes the same `Date | null` every other /status
 *  timestamp uses. */
function servedBy(connection: ChainService["connection"]): {
  rpcEndpoint: "primary" | "fallback";
  rpcFallbackAt: Date | null;
} {
  const status = rpcStatus(connection);
  return {
    rpcEndpoint: status.endpoint,
    rpcFallbackAt: status.fallbackAt === null ? null : new Date(status.fallbackAt),
  };
}

export interface FeedRow {
  slot: bigint;
  signature: string;
  index: number;
  name: string;
  data: Prisma.JsonValue;
  blockTime: bigint | null;
}

const summarizeRound = (round: Round) => ({
  id: round.id,
  epochId: round.epochId,
  startsAt: round.startsAt,
  endsAt: round.endsAt,
  status: round.status,
  pot: round.pot,
  houseCut: round.houseCut,
});

/** Draw progress for the epoch that just ended, from rows already read.
 *  Null unless `previous` is Registering or Drawing. */
function drawingProgressFrom(previous: Epoch | null, players: Player[]) {
  if (
    previous === null ||
    (previous.status !== EPOCH_REGISTERING && previous.status !== EPOCH_DRAWING)
  ) {
    return null;
  }
  const eligible = players.filter(
    (player) => weightAt(player, previous.id, previous.startsAt, previous.endsAt) > 0n,
  ).length;
  return {
    epochId: previous.id,
    registeredCount: previous.registeredCount,
    eligible,
    status: previous.status,
  };
}

/** GET /status's shape, from rows and balances already read. */
function statusFrom(
  operator: OperatorState | null,
  cursor: Cursor | null,
  rpc: RpcHealth,
  pool: Pool | null,
  balances: ChainBalances,
  operatorSolWarn: number,
) {
  const now = nowSeconds();
  return {
    // The row keeps unix seconds; the frontend `Date.parse`s this field,
    // which reads a bare digit string as NaN and shows "STALLED" forever.
    operator: operator && {
      ...operator,
      lastTickAt:
        operator.lastTickAt == null ? null : new Date(Number(operator.lastTickAt) * 1000),
      // Same treatment: the crank sleeps to a deadline, so the frontend
      // needs to know when it plans to wake before calling it stalled.
      nextWakeAt:
        operator.nextWakeAt == null ? null : new Date(Number(operator.nextWakeAt) * 1000),
      // Ticket 09: same treatment as the two above.
      lastSuccessAt:
        operator.lastSuccessAt == null ? null : new Date(Number(operator.lastSuccessAt) * 1000),
      // Ticket 09: a stable code in place of the raw text, so an internal
      // hostname or path in a chain or Postgres error never reaches a
      // client. The raw text still reaches the logs from the tick itself.
      lastError: operatorErrorCode(operator.lastError),
    },
    cursor: {
      lastSlot: cursor?.lastSlot ?? null,
      lastSignature: cursor?.lastSignature ?? null,
      // Null rather than 0 when the indexer has never synced, so the
      // frontend can tell "fresh" from "never ran".
      ageSeconds: cursor?.updatedAt == null ? null : Number(now - cursor.updatedAt),
    },
    ...rpc,
    // What depositors are owed, what the vault can pay them with, and what
    // the last crank found missing (ticket 03).
    pendingWithdrawals: pool?.pendingWithdrawals ?? 0n,
    vaultLiquidity: balances.vaultLiquidity,
    withdrawShortfall: operator?.withdrawShortfall ?? 0n,
    // Ticket 06/07: 0/false until a tick has looked, same treatment as
    // `withdrawShortfall` above.
    withdrawSkippedCount: operator?.withdrawSkippedCount ?? 0,
    registrationIndexerStale: operator?.registrationIndexerStale ?? false,
    operatorSol: balances.operatorSol,
    // Null, not false, when the balance is unknown: a failed read is not
    // evidence that the operator still has fees.
    operatorSolLow:
      balances.operatorSol === null
        ? null
        : balances.operatorSol < operatorSolWarn,
    // Ticket 09: same null-means-unknown treatment as operatorSol/Low, and
    // null when the sparring player is not configured at all — there is
    // nothing to warn about for a service that is off.
    sparringSol: balances.sparringSol,
    sparringSolLow:
      balances.sparringSol === null ? null : balances.sparringSol < operatorSolWarn,
    // Irreversible once true (ops-and-envs ticket 08); false, not null,
    // before the pool is indexed, matching every other pool-derived figure
    // above.
    shutdown: pool?.shutdown ?? false,
    // Null rather than a wrong number when either half of the sum is
    // unknown: no pool indexed yet, or the vault balance read failed.
    principalOut:
      pool === null || balances.vaultLiquidity === null
        ? null
        : principalOut({
            totalPrincipal: pool.totalPrincipal,
            pendingWithdrawals: pool.pendingWithdrawals,
            yieldBudget: pool.yieldBudget,
            vaultAmount: balances.vaultLiquidity,
          }),
  };
}

/** Each player's Weight at instant `at`, plus the epoch total, from rows already read. */
function weightsFrom(
  players: Player[],
  epoch: Epoch,
  at: bigint,
): { weights: LiveWeight[]; total: bigint } {
  const weights = players.map((player) => ({
    player,
    liveWeight: weightAt(player, epoch.id, epoch.startsAt, at),
    drawWeight: weightAt(player, epoch.id, epoch.startsAt, epoch.endsAt),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.drawWeight, 0n);
  return { weights, total };
}

/** A weighted entry as `/players/:owner` and `/state` return it. */
function playerDto(entry: LiveWeight, total: bigint) {
  return {
    ...entry.player,
    liveWeight: entry.liveWeight,
    odds: oddsPercent(entry.drawWeight, total),
  };
}

/**
 * `boughtToday`, `buyAllowanceLeft` and `grantedToday` for `/players/:owner`,
 * from the epoch-gated counters `buy_tickets`/`grant_tickets` keep on the
 * Player (see `ifCurrentEpoch`). `buyAllowanceLeft` mirrors the on-chain
 * cap check in `bought_amount_after`: spend is capped at Principal per day.
 */
export function playerTicketExtras(player: Player, currentEpochId: bigint) {
  const boughtToday = ifCurrentEpoch(player.boughtEpoch, currentEpochId, player.boughtAmount);
  return {
    boughtToday,
    buyAllowanceLeft: player.principal > boughtToday ? player.principal - boughtToday : 0n,
    grantedToday: ifCurrentEpoch(player.bonusEpoch, currentEpochId, player.bonusGranted),
  };
}
