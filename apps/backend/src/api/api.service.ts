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
  type WeightTreeState,
} from "@prisma/client";
import { unpackAccount } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import { rpcStatus } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { clockUnixTimestamp } from "../operator/chain-state";
import { prefixWeights, readNodes } from "../operator/weight-tree";
import { PrismaService } from "../prisma/prisma.service";
import {
  decodeReserve,
  effectiveTickets,
  estimatedRateBps,
  freeIdle,
  haircutFactor,
  pendingTickets,
  withdrawMaturity,
  solvencyMargin,
  supplyRateBps,
  trailingRate,
  unsettledYield,
  type IndexPoint,
  type ReserveStats,
  type TrailingRate,
} from "./live-yield";

/** Mirrors programs/hex_vault/src/constants.rs `epoch_status`. */
export const EPOCH_OPEN = 0;
export const EPOCH_ENDED = 1;
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

/** How long the Weight tree account read behind a Player's Weight answers
 *  for. The tree moves on every Ticket change, but the odds a viewer reads
 *  only need to be about right. */
export const TREE_TTL_MS = 15_000;

/** Most Players one tree holds: (10 MiB - 56-byte header) / 56-byte node, as
 *  in weight_tree.rs. Past it deposits fail with `WeightTreeFull`. */
export const TREE_CAPACITY = 187_244;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const toBigInt = (value: Prisma.Decimal): bigint => BigInt(value.toFixed());

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

/** Pool-wide `grant_tickets` cap for one epoch, mirroring the on-chain
 *  `pool_bonus_cap`. */
export function poolBonusCap(totalPrincipal: bigint, bonusCapBps: number): bigint {
  return (totalPrincipal * BigInt(bonusCapBps)) / 10_000n;
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
  /** The Player's Tickets in the current epoch, with the lazy reset and the
   *  pending fold applied (`effectiveTickets`): exactly what the draw counts
   *  for them. */
  weight: bigint;
  /** Principal that earns no Ticket until the next epoch. */
  pending: bigint;
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
  /** The pinned klend reserve, decoded. Null when the pool has none, the read
   *  failed, or the account is not klend's (a test-venue stub). */
  reserve: ReserveStats | null;
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
  private tree: CachedRead<Buffer | null> | undefined;

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

  /**
   * The Pool row, current Epoch and open Round, plus `live` (ticket 14): the
   * 24-hour and 7-day paid rates, the estimated current rate, the ceiling,
   * the fee, the Bought Tickets switch, and the haircut while impaired.
   */
  async getPool() {
    const pool = await this.requirePool();
    const poolAddress = this.poolAddress;
    const [currentEpoch, openRound, balances] = await Promise.all([
      this.prisma.epoch.findUnique({
        where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
      }),
      this.prisma.round.findFirst({
        where: { poolAddress, status: { in: [ROUND_OPEN, ROUND_REQUESTED] } },
        orderBy: { id: "desc" },
      }),
      this.chainBalances(pool.klendReserve),
    ]);
    return {
      pool,
      currentEpoch,
      openRound: openRound === null ? null : summarizeRound(openRound),
      live: await this.liveYield(pool, balances),
    };
  }

  /**
   * ponytail: two history lookups per window per request. The history is one
   * row a minute, indexed on (poolAddress, at); cache the answer for a minute
   * if /pool polling ever shows up in the database's bill.
   */
  private async trailing(latest: IndexPoint, window: number): Promise<TrailingRate> {
    if (latest.at <= 0n) return trailingRate(latest, null, window);
    const poolAddress = this.poolAddress;
    const row =
      (await this.prisma.yieldIndexPoint.findFirst({
        where: { poolAddress, at: { lte: latest.at - BigInt(window) } },
        orderBy: { at: "desc" },
      })) ??
      (await this.prisma.yieldIndexPoint.findFirst({ where: { poolAddress }, orderBy: { at: "asc" } }));
    return trailingRate(
      latest,
      row === null ? null : { at: row.at, yieldIndex: toBigInt(row.yieldIndex) },
      window,
    );
  }

  private async liveYield(pool: Pool, balances: ChainBalances) {
    // The window ends at the pool's own last sync, not at the newest history
    // row, which the one-a-minute thinning can leave up to a minute behind.
    const latest = { at: pool.lastSyncAt, yieldIndex: toBigInt(pool.yieldIndex) };
    const [trailing24h, trailing7d] = await Promise.all([
      this.trailing(latest, 86_400),
      this.trailing(latest, 7 * 86_400),
    ]);
    const idle =
      balances.vaultLiquidity === null
        ? null
        : freeIdle(balances.vaultLiquidity, pool.pendingWithdrawals);
    const estimatedBps = estimatedRateBps({
      supplyRateBps: balances.reserve === null ? null : supplyRateBps(balances.reserve),
      venueValue: pool.venueValue,
      freeIdle: idle,
      yieldFeeBps: pool.yieldFeeBps,
      ceilingBps: pool.baseRateBps,
    });
    return {
      rates: { trailing24h, trailing7d, estimatedBps, ceilingBps: pool.baseRateBps },
      yieldFeeBps: pool.yieldFeeBps,
      buyTicketsPaused: pool.buyTicketsPaused,
      freeIdle: idle,
      /** The share of a withdrawal the pool pays, while impaired; else null. */
      haircutFactor:
        pool.impaired && balances.vaultLiquidity !== null
          ? haircutFactor(pool, balances.vaultLiquidity)
          : null,
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

  /**
   * Principal, the yield earned since the last settle as of the pool's last
   * sync (`unsettledYield`, `syncedAt`), the Weight the tree holds for the
   * Player in the current epoch, and `pendingMaturesAt`, when the queued
   * withdrawal pays (null with nothing queued).
   */
  async getPlayer(owner: string) {
    const [pool, player] = await Promise.all([
      this.requirePool(),
      this.prisma.player.findUnique({
        where: { poolAddress_owner: { poolAddress: this.poolAddress, owner } },
      }),
    ]);
    if (player === null) {
      throw new NotFoundException(
        "No Player account for that wallet yet. Deposit to open one.",
      );
    }
    const { weights, total } = await this.weightsFor(pool, [player]);
    const mine = weights[0] as LiveWeight;
    const queuedEpoch =
      player.pendingWithdraw > 0n
        ? await this.prisma.epoch.findUnique({
            where: { poolAddress_id: { poolAddress: this.poolAddress, id: player.pendingEpoch } },
          })
        : null;
    return {
      ...playerDto(mine, total),
      ...playerTicketExtras(player, pool.currentEpochId),
      pendingMaturesAt:
        player.pendingWithdraw > 0n
          ? withdrawMaturity(queuedEpoch?.endsAt ?? null, player.requestedAt, pool.epochSeconds)
          : null,
      unsettledYield: unsettledYield(player.principal, toBigInt(pool.yieldIndex), toBigInt(player.yieldIndex)),
      syncedAt: pool.lastSyncAt,
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
    const { pool, epoch, previousEpoch, openRound, operator, cursor, player, round, position } =
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
          const trackedRoundId = roundId ?? openRound?.id;
          const [player, round, position] = await Promise.all([
            owner === undefined
              ? Promise.resolve(null)
              : tx.player.findUnique({ where: { poolAddress_owner: { poolAddress, owner } } }),
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
          return { pool, epoch, previousEpoch, openRound, operator, cursor, player, round, position };
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
      this.chainBalances(pool.klendReserve),
      this.chain.priorityFeeMicroLamports(hotWritableAccounts),
    ]);

    // Ticket 05: no Epoch yet means the draw has no Tickets at all, so the
    // total is 0 and the tree is not read.
    const { weights, total } =
      player === null
        ? { weights: [], total: 0n }
        : epoch === null
          ? { weights: weightsFrom([player], pool.currentEpochId), total: 0n }
          : await this.weightsFor(pool, [player], epoch);
    const mine = weights[0];

    return {
      pool,
      currentEpoch:
        epoch === null
          ? null
          : {
              ...epoch,
              jackpotAmount,
              drawing: drawingProgressFrom(previousEpoch),
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
    // ponytail: every Player row and the whole tree per request, for the odds
    // denominator. Fine at beta scale; page it off the mirrored root if the
    // Player count grows into the thousands.
    const pool = await this.requirePool();
    const players = await this.prisma.player.findMany({ where: { poolAddress: this.poolAddress } });
    const { weights, total } = await this.weightsFor(pool, players);
    return weights
      .slice()
      .sort((a, b) => {
        // Ticket 01: a tie (most commonly two players at 0% before any
        // Round opens) otherwise falls back to whatever order the DB
        // returned, which is not guaranteed stable across requests. House
        // always sorts last among ties; real players break ties by owner
        // so the order is deterministic and the test is stable.
        if (b.weight !== a.weight) return b.weight > a.weight ? 1 : -1;
        if (a.player.isHouse !== b.player.isHouse) return a.player.isHouse ? 1 : -1;
        return a.player.owner < b.player.owner ? -1 : a.player.owner > b.player.owner ? 1 : 0;
      })
      .slice(0, limit)
      .map(({ player, weight }) => ({
        owner: player.owner,
        principal: player.principal,
        entries: player.entries,
        isHouse: player.isHouse,
        weight,
        odds: oddsOf(weight, total),
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
         OR (name = 'PositionSettled'
             AND (data->>'reward' ~ '^[1-9][0-9]*$' OR data->>'refund' ~ '^[1-9][0-9]*$')))
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
    const [operator, cursor, pool, rpc, tree] = await Promise.all([
      this.prisma.operatorState.findUnique({ where: { poolAddress } }),
      this.prisma.cursor.findUnique({ where: { poolAddress } }),
      this.prisma.pool.findUnique({ where: { address: poolAddress } }),
      this.rpcHealth(),
      this.prisma.weightTreeState.findUnique({ where: { poolAddress } }),
    ]);
    const balances = await this.chainBalances(pool?.klendReserve);
    // Players whose deposit has not earned a Ticket yet: one made in the
    // current epoch. An older one has folded into Tickets already, touched or not.
    const awaitingActivation =
      pool === null
        ? 0
        : await this.prisma.player.count({
            where: { poolAddress, pendingDeposit: { gt: 0 }, pendingDepositEpoch: { gte: pool.currentEpochId } },
          });
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
      ...this.yieldStatus(pool, balances, tree),
      pendingDepositPlayers: awaitingActivation,
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
   * Live yield's half of GET /status (ticket 14): the solvency invariant as a
   * signed margin, free idle against the band, the reserve's utilisation and
   * free liquidity, the two switches, the Weight tree's fill, and the
   * referral bonus counters. A null pool (not indexed yet) reads as zeros and
   * false, like the rest of `getStatus`; a figure that needs the vault or the
   * reserve is null when that read failed, never a made-up zero.
   */
  private yieldStatus(pool: Pool | null, balances: ChainBalances, tree: WeightTreeState | null) {
    const vault = balances.vaultLiquidity;
    const idle = pool === null || vault === null ? null : freeIdle(vault, pool.pendingWithdrawals);
    const reserve = balances.reserve;
    const nodeCount = tree?.nodeCount ?? 0n;
    // The band is measured against free idle plus the venue position, as the
    // program measures it; `freeIdleBps` is the share of Principal.
    const band = pool === null || idle === null ? 0n : idle + pool.venueValue;
    return {
      bonusGrantedToday:
        pool === null ? 0n : ifCurrentEpoch(pool.bonusEpoch, pool.currentEpochId, pool.bonusGranted),
      bonusCap: pool === null ? 0n : poolBonusCap(pool.totalPrincipal, pool.bonusCapBps),
      solvencyMargin: pool === null || vault === null ? null : solvencyMargin(pool, vault),
      freeIdle: idle,
      freeIdleBps:
        pool === null || idle === null || pool.totalPrincipal === 0n
          ? null
          : Number((idle * 10_000n) / pool.totalPrincipal),
      idleFloorBps: pool?.idleFloorBps ?? 0,
      idleTargetBps: pool?.idleTargetBps ?? 0,
      freeIdleBelowFloor:
        pool === null || idle === null ? null : band > 0n && idle * 10_000n < band * BigInt(pool.idleFloorBps),
      reserveUtilizationBps:
        reserve === null || reserve.available + reserve.borrowed === 0n
          ? null
          : Number((reserve.borrowed * 10_000n) / (reserve.available + reserve.borrowed)),
      reserveFreeLiquidity: reserve?.available ?? null,
      impaired: pool?.impaired ?? false,
      deployPaused: pool?.deployPaused ?? false,
      treeNodeCount: nodeCount,
      treeCapacity: TREE_CAPACITY,
      treeUsedBps: Number((nodeCount * 10_000n) / BigInt(TREE_CAPACITY)),
    };
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

  /** Draw progress for the epoch that just ended, so the Jackpot screen can
   *  show it is waiting on the draw instead of a spinner. */
  private async drawingProgress(pool: Pool) {
    if (pool.currentEpochId <= 0n) return null;
    const previous = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress: this.poolAddress, id: pool.currentEpochId - 1n } },
    });
    return drawingProgressFrom(previous);
  }

  /**
   * `players`' Tickets in the current epoch, from their rows, and the draw's
   * total, the Weight tree's root. The two sides come from different places on
   * purpose: the root is what the draw selects over, and a Player's share of it
   * is their Tickets over it. `epoch` is the current Epoch when the caller has
   * it.
   *
   * ponytail: the whole tree account per call for the root, cached for
   * `TREE_TTL_MS`, parsed in memory. 56 bytes a Player, so a few thousand
   * Players is a couple hundred KB; read the root's O(log n) nodes with
   * `dataSlice` once that matters.
   */
  private async weightsFor(
    pool: Pool,
    players: readonly Player[],
    epoch?: Epoch,
  ): Promise<{ weights: LiveWeight[]; total: bigint | null }> {
    const current =
      epoch ??
      (await this.prisma.epoch.findUnique({
        where: { poolAddress_id: { poolAddress: this.poolAddress, id: pool.currentEpochId } },
      }));
    if (current === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }
    const data = await this.cachedTree(pool.weightTree);
    const prefix = data === null ? null : prefixWeights(readNodes(data), current.id);
    return {
      weights: weightsFrom(players, pool.currentEpochId),
      total: prefix === null ? null : (prefix[prefix.length - 1] as bigint),
    };
  }

  /** The tree account, or null when the read failed (logged), so Weight and
   *  odds go out as null rather than as a made-up zero. */
  private cachedTree(address: string): Promise<Buffer | null> {
    this.tree = this.cached(this.tree, TREE_TTL_MS, async () => {
      try {
        const info = await this.chain.connection.getAccountInfo(new PublicKey(address));
        if (info === null) throw new Error("the account does not exist");
        return info.data;
      } catch (cause) {
        this.logger.warn(
          `weight tree read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        // Not cached: the next request retries the chain.
        this.tree = undefined;
        return null;
      }
    });
    return this.tree.result;
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
  private async chainBalances(klendReserve?: string): Promise<ChainBalances> {
    try {
      return await this.cachedBalances(klendReserve);
    } catch (cause) {
      // Computed off the failed promise, so it never becomes the cached
      // value: `cachedBalances` has already cleared the slot.
      this.logger.warn(
        `balance read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return { vaultLiquidity: null, reserve: null, operatorSol: null, sparringSol: null };
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
  private cachedBalances(klendReserve: string | undefined): Promise<ChainBalances> {
    if (
      this.balances === undefined ||
      Date.now() - this.balances.at > BALANCES_TTL_MS
    ) {
      const principalVault = this.chain.principalVaultAddress();
      // The reserve rides in the same call. A pool row not indexed yet has no
      // reserve (an empty string), and the key slot is kept so the indexes
      // below stay fixed.
      const reserveKey = klendReserve ? new PublicKey(klendReserve) : null;
      const accounts = [
        principalVault,
        this.chain.keypair.publicKey,
        ...(reserveKey ? [reserveKey] : []),
        ...(this.sparringPubkey ? [this.sparringPubkey] : []),
      ];
      const result = this.chain.connection
        .getMultipleAccountsInfo(accounts)
        .then(([vault, fees, ...rest]) => {
          const reserve = reserveKey ? rest.shift() : null;
          const sparring = rest[0];
          return {
            vaultLiquidity: vault ? unpackAccount(principalVault, vault).amount : null,
            reserve: reserve ? readReserve(reserve.data) : null,
            operatorSol: fees ? fees.lamports / LAMPORTS_PER_SOL : 0,
            sparringSol: this.sparringPubkey === null ? null : sparring ? sparring.lamports / LAMPORTS_PER_SOL : 0,
          };
        });
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

/** Draw progress for the epoch that just ended, from the row already read.
 *  Null unless `previous` is Ended (waiting for the draw) or Drawing. */
function drawingProgressFrom(previous: Epoch | null) {
  if (previous === null || (previous.status !== EPOCH_ENDED && previous.status !== EPOCH_DRAWING)) {
    return null;
  }
  return { epochId: previous.id, status: previous.status };
}

/** A klend reserve's decoded figures, or null when the account is not one
 *  (a test-venue pool pins a stub), logged nowhere: that is a pool fact. */
function readReserve(data: Buffer): ReserveStats | null {
  try {
    return decodeReserve(data);
  } catch {
    return null;
  }
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
  };
}

/** Each player's Tickets and pending deposit in the epoch `currentEpochId`. */
function weightsFrom(players: readonly Player[], currentEpochId: bigint): LiveWeight[] {
  return players.map((player) => ({
    player,
    weight: effectiveTickets(player, currentEpochId),
    pending: pendingTickets(player, currentEpochId),
  }));
}

/** `oddsPercent`, or null while the tree is unreadable. */
function oddsOf(weight: bigint, total: bigint | null): string | null {
  return total === null ? null : oddsPercent(weight, total);
}

/** A weighted entry as `/players/:owner` and `/state` return it. `weight` is
 *  the Player's active Tickets, `pendingTickets` the Principal that starts
 *  earning them in `pendingActivatesEpoch` (null when nothing is pending). */
function playerDto(entry: LiveWeight, total: bigint | null) {
  return {
    ...entry.player,
    weight: entry.weight,
    pendingTickets: entry.pending,
    pendingActivatesEpoch: entry.pending > 0n ? entry.player.pendingDepositEpoch + 1n : null,
    odds: oddsOf(entry.weight, total),
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
