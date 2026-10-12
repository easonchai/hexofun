import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type Cursor,
  type Epoch,
  type OperatorState,
  type Player,
  type Pool,
} from "@prisma/client";
import { unpackAccount } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import { rpcStatus } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { SUBGRAPH_CLIENT, type SubgraphSource } from "../indexer/subgraph";
import { clockUnixTimestamp } from "../operator/chain-state";
import { snapshotReasons } from "../ledger/snapshot-reasons";
import { referralGrantsForEpoch } from "../operator/referral-grants";
import { epochSeed, randomnessAddress } from "../operator/vrf";
import { PrismaService } from "../prisma/prisma.service";
import { winnerProof, type WinnerProof } from "../snapshot/epoch-draw";
import {
  decodeReserve,
  dailyPaidRates,
  estimatedRateBps,
  SECONDS_PER_DAY,
  freeIdle,
  haircutFactor,
  pendingTickets,
  positionBasis,
  positionYield,
  withdrawMaturity,
  type OwnerEvent,
  solvencyMargin,
  supplyRateBps,
  trailingRate,
  unsettledYield,
  type IndexPoint,
  type ReserveStats,
  type TrailingRate,
} from "./live-yield";
import { readRoundState } from "./round-state";
import { webhookLastSlot } from "./webhooks.controller";
import { mirageConnected, mirageLastSlot } from "../indexer/mirage.service";

/** Mirrors programs/hex_vault/src/constants.rs `epoch_status`. */
export const EPOCH_OPEN = 0;
export const EPOCH_ENDED = 1;
export const EPOCH_DRAWING = 2;
const EPOCH_DRAWN = 3;
const EPOCH_PAID = 4;

/** Events the frontend feed shows. Anything else is operator noise. */
const FEED_NAMES = [
  "Deposited",
  "Withdrawn",
  "JackpotPaid",
  "EpochRolledOver",
] as const;

/**
 * What a wallet's own history adds to `FEED_NAMES`: its withdraw requests
 * (the refunded and queued parts) and cancels. The public feed leaves them
 * out, since `activityRows.ts` renders neither and they would take rows under
 * the limit.
 */
const OWNER_FEED_NAMES = [...FEED_NAMES, "WithdrawRequested", "WithdrawCancelled"] as const;

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
 * `bought_epoch`/`bought_amount` reset lazily on chain, the next time the matching
 * instruction runs for a stale epoch, not the moment the epoch turns over.
 * A read has to apply the same gate: a counter left over from a past epoch
 * reads as though it were already reset to 0.
 */
function ifCurrentEpoch(counterEpoch: bigint, currentEpochId: bigint, value: bigint): bigint {
  return counterEpoch === currentEpochId ? value : 0n;
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
  /** The wallet's `TicketBalance`: what the next snapshot counts for them. */
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
export interface ChainBalances {
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
  private subgraphProbe: CachedRead<number | null> | undefined;
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

  /** Winner proofs of drawn epochs, newest few (see `winnerFor`). */
  private readonly winners = new Map<string, WinnerProof>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
    /** Solami ticket 05: set only when `SUBGRAPH_URL` and `SUBGRAPH_API_KEY` are. */
    @Optional() @Inject(SUBGRAPH_CLIENT) private readonly subgraph: SubgraphSource | null = null,
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
   * The Pool row and current Epoch, plus `live` (ticket 14): the
   * 24-hour and 7-day paid rates, the estimated current rate, the ceiling,
   * the fee, the Bought Tickets switch, and the haircut while impaired.
   */
  async getPool() {
    const pool = await this.requirePool();
    const poolAddress = this.poolAddress;
    const [currentEpoch, balances] = await Promise.all([
      this.prisma.epoch.findUnique({
        where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
      }),
      this.chainBalances(pool.klendReserve),
    ]);
    return {
      pool,
      currentEpoch,
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

  /**
   * The rate depositors were paid for each of the last `days` UTC days, today
   * included, oldest first. Reads one row per day (the day's last point) plus
   * the newest point before the range, which a first day with no point of its
   * own needs as its start.
   */
  async getDailyPaidRates(days: number) {
    const poolAddress = this.poolAddress;
    const firstDay = nowSeconds() / SECONDS_PER_DAY - BigInt(days - 1);
    const from = firstDay * SECONDS_PER_DAY;
    const [before, closes] = await Promise.all([
      this.prisma.yieldIndexPoint.findFirst({
        where: { poolAddress, at: { lt: from } },
        orderBy: { at: "desc" },
      }),
      this.prisma.$queryRaw<{ at: bigint; yieldIndex: Prisma.Decimal }[]>`
        SELECT DISTINCT ON ("at" / 86400) "at", "yieldIndex"
        FROM "YieldIndexPoint"
        WHERE "poolAddress" = ${poolAddress} AND "at" >= ${from}
        ORDER BY "at" / 86400, "at" DESC
      `,
    ]);
    const points = [...(before === null ? [] : [before]), ...closes].map((row) => ({
      at: row.at,
      yieldIndex: toBigInt(row.yieldIndex),
    }));
    return dailyPaidRates(points, firstDay, days).map(({ day, aprBps }) => ({
      day: new Date(Number(day) * 86_400_000).toISOString().slice(0, 10),
      aprBps,
    }));
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
      jackpotAmount: await this.liveJackpot(epoch, pool, true),
      drawing: await this.drawingProgress(pool),
    };
  }

  /**
   * The Epoch snapshot: leaves in tree order from `after`, and the sum tree's
   * root, depth, leaf count and total. `nextIndex` is where the next page starts,
   * null on the last. 404 until the next epoch has begun, which is when the
   * ledger takes the snapshot; an empty one reads as zero leaves and a null root.
   * Each leaf also carries `reasons`, the ledger sums behind its Tickets (see
   * `snapshotReasons`). The tree does not hash them.
   */
  async getEpochSnapshot(id: bigint, after: number, limit: number) {
    const epoch = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress: this.poolAddress, id } },
    });
    if (epoch === null || epoch.leafCount === null) {
      throw new NotFoundException("That epoch has no snapshot yet. It is taken when the next epoch begins.");
    }
    const leaves = await this.prisma.epochSnapshot.findMany({
      where: { poolAddress: this.poolAddress, epochId: id, index: { gte: after } },
      orderBy: { index: "asc" },
      take: limit,
      select: { index: true, owner: true, tickets: true },
    });
    const next = after + leaves.length;
    const why = await snapshotReasons(this.prisma, this.poolAddress, id, leaves.map((leaf) => leaf.owner));
    return {
      epochId: id,
      root: epoch.snapshotRoot,
      depth: epoch.snapshotDepth,
      leafCount: epoch.leafCount,
      totalTickets: epoch.totalTickets,
      leaves: leaves.map((leaf) => ({ ...leaf, ...why.get(leaf.owner) })),
      nextIndex: next < epoch.leafCount ? next : null,
    };
  }

  /** One wallet's Ticket ledger, newest first; `before` is the last page's `nextBefore`. */
  async getLedger(owner: string, before: bigint | null, limit: number) {
    const rows = await this.prisma.ticketLedger.findMany({
      where: { poolAddress: this.poolAddress, owner, ...(before === null ? {} : { id: { lt: before } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, epochId: true, reason: true, delta: true, ref: true, signer: true, signature: true, createdAt: true },
    });
    const page = rows.slice(0, limit);
    return { rows: page, nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /** The epoch's Referral bonus grants and their inputs (ticket 22); the job lives in operator/referral-grants.ts. */
  getEpochReferralGrants(id: bigint) {
    return referralGrantsForEpoch(this.prisma, this.poolAddress, id);
  }

  /**
   * Everything needed to check the epoch's draw, or to send its `payout`
   * (permissionless): the committed root, depth, leaf count and total, the
   * nonce and the seed they make, the randomness account, the drawn target and
   * the winner's leaf with its proof. A field is null until it exists, and the
   * nonce stays private until `request_draw` has landed, since nobody should
   * be able to pre-create the randomness account before then. A winner the
   * stored rows cannot prove reads as null, not as no winner.
   */
  async getEpochDraw(id: bigint) {
    const epoch = await this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress: this.poolAddress, id } },
    });
    if (epoch === null || epoch.leafCount === null) {
      throw new NotFoundException("That epoch has no snapshot yet. It is taken when the next epoch begins.");
    }
    const total = epoch.totalTickets ?? 0n;
    // Not `>= EPOCH_DRAWING`: an epoch rolled over at `end_epoch` (jackpot under the floor) holds a
    // claimed nonce but never had a randomness account.
    const requested =
      epoch.nonce !== null &&
      total > 0n &&
      (epoch.status === EPOCH_DRAWING || epoch.status === EPOCH_DRAWN || epoch.status === EPOCH_PAID);
    const seed = requested
      ? epochSeed(
          new PublicKey(this.poolAddress),
          id,
          Buffer.from(epoch.nonce as string, "hex"),
          Buffer.from(epoch.snapshotRoot as string, "hex"),
          total,
        )
      : null;
    const testVrf = this.chain.program.idl.instructions.some((ix) => ix.name === "testFulfill");
    const paidOrDrawn = epoch.status === EPOCH_DRAWN || epoch.status === EPOCH_PAID;
    const winner = paidOrDrawn ? await this.winnerFor(id, toBigInt(epoch.target)) : null;
    return {
      epochId: id,
      status: epoch.status,
      root: epoch.snapshotRoot,
      depth: epoch.snapshotDepth,
      leafCount: epoch.leafCount,
      totalTickets: epoch.totalTickets,
      nonce: seed === null ? null : epoch.nonce,
      seed: seed?.toString("hex") ?? null,
      randomness:
        seed === null ? null : randomnessAddress(this.chain.programId, seed, testVrf).toBase58(),
      target: paidOrDrawn ? toBigInt(epoch.target) : null,
      winner: winner?.owner ?? null,
      winnerIndex: winner?.index ?? null,
      winnerTickets: winner?.tickets ?? null,
      proof: winner?.siblings.map(({ hash, sum }) => ({ hash: hash.toString("hex"), sum })) ?? null,
    };
  }

  /** A proof is a pure function of rows that stop changing once the epoch is
   *  drawn, and building one reads every leaf, so the last few are kept. */
  private async winnerFor(id: bigint, target: bigint): Promise<WinnerProof | null> {
    const key = `${id}:${target}`;
    const cached = this.winners.get(key);
    if (cached) return cached;
    const proof = await winnerProof(this.prisma, this.poolAddress, id, target);
    if (proof !== null) {
      if (this.winners.size >= 8) this.winners.delete(this.winners.keys().next().value as string);
      this.winners.set(key, proof);
    }
    return proof;
  }

  /**
   * `Epoch.jackpot_amount` is a snapshot the program takes once, at
   * `request_draw`. While the epoch is still open it is 0 on chain no
   * matter what `fund_jackpot` has moved into the vault, so the open epoch
   * reports the vault's token balance instead, less `jackpotReserved`: the
   * prize a Drawing or Drawn epoch still owes sits in the same vault, and
   * `request_draw` subtracts it before it snapshots. From Ended on the chain
   * value is authoritative (the vault drains to the winner at payout).
   *
   * `withPrizeOwed` picks the figure. The display one (`/epochs/current`,
   * `/state`) adds `Pool.prizeOwed`, the prize share already earned and
   * booked but only moved into the vault at Harvest, once an epoch. The
   * snapshot one (`/status` and the min-jackpot alert behind it) leaves it
   * out: it is what the draw would snapshot, and counting `prizeOwed` there
   * would hide a failed harvest.
   *
   * Right after a harvest the indexed Pool row can lag the vault read by a
   * few seconds, so the display figure briefly counts that prize twice.
   * Fine for a display.
   */
  private async liveJackpot(epoch: Epoch, pool: Pool, withPrizeOwed: boolean): Promise<bigint> {
    if (epoch.status !== EPOCH_OPEN) return epoch.jackpotAmount;
    const owed = withPrizeOwed ? pool.prizeOwed : 0n;
    try {
      const vault = await this.cachedJackpotBalance();
      return (vault > pool.jackpotReserved ? vault - pool.jackpotReserved : 0n) + owed;
    } catch (error: unknown) {
      // This fallback never enters the cache. cachedJackpotBalance clears a
      // failed read, so the next request retries the chain.
      this.logger.warn(
        `jackpot vault balance read failed, serving the indexed snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return epoch.jackpotAmount + owed;
    }
  }

  /**
   * The chain call `liveJackpot` caches. Unlike `chainClock`/`rpcHealth`
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

  /**
   * Principal, the yield earned since the last settle as of the pool's last
   * sync (`unsettledYield`, `syncedAt`), the Tickets the Player holds in the
   * current epoch, `pendingMaturesAt`, when the queued
   * withdrawal pays (null with nothing queued), and `positionYield`, what the
   * open position has earned, settled or not (`positionBasis`). That one is
   * null while the Player row is newer than the newest stored event and that
   * event's Principal differs, because the basis then lacks the change that
   * moved Principal.
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
    const [queuedEpoch, ownerEvents, newestEvent] = await Promise.all([
      player.pendingWithdraw > 0n
        ? this.prisma.epoch.findUnique({
            where: { poolAddress_id: { poolAddress: this.poolAddress, id: player.pendingEpoch } },
          })
        : null,
      this.principalEvents(owner),
      // The Player row comes from the confirmed log path or a sweep, the Event
      // rows from the finalized live path or catch-up, so they land apart.
      // Not `Cursor.lastSlot`: the live path stores events without moving it,
      // and catch-up moves it only once a minute.
      this.prisma.event.aggregate({
        where: { poolAddress: this.poolAddress },
        _max: { slot: true },
      }),
    ]);
    // Or the owner's newest event already left Principal where the row has
    // it: the hourly sweep restamps every unchanged row near the tip, and a
    // quiet pool would otherwise read null until its next event.
    const lastPrincipal = ownerEvents.at(-1)?.data.principal;
    const eventsCurrent =
      player.slot <= (newestEvent._max.slot ?? 0n) ||
      (lastPrincipal !== undefined && BigInt(String(lastPrincipal)) === player.principal);
    const unsettled = unsettledYield(player.principal, toBigInt(pool.yieldIndex), toBigInt(player.yieldIndex));
    return {
      ...playerDto(mine, total),
      ...playerTicketExtras(player, pool.currentEpochId),
      pendingMaturesAt:
        player.pendingWithdraw > 0n
          ? withdrawMaturity(queuedEpoch?.endsAt ?? null, player.requestedAt, pool.epochSeconds)
          : null,
      unsettledYield: unsettled,
      positionYield: eventsCurrent
        ? positionYield(player.principal, unsettled, positionBasis(ownerEvents))
        : null,
      syncedAt: pool.lastSyncAt,
    };
  }

  /** Every event that moves this owner's Principal, oldest first, for
   *  `positionBasis`. Uses the same owner/winner indexes as `getFeed`. */
  private principalEvents(owner: string): Promise<OwnerEvent[]> {
    return this.prisma.$queryRaw<OwnerEvent[]>`
      SELECT name, data
      FROM "Event"
      WHERE "poolAddress" = ${this.poolAddress}
        AND (
          (name IN ('Deposited', 'WithdrawRequested', 'WithdrawCancelled', 'Withdrawn', 'EmergencyWithdrawn')
            AND data->>'owner' = ${owner})
          OR (name = 'JackpotPaid' AND data->>'winner' = ${owner})
        )
      ORDER BY slot ASC, "index" ASC
    `;
  }

  /**
   * Ticket 06: Pool, current Epoch, Player and operator status
   * from one point-in-time snapshot. Every DB read this needs — including
   * the previous epoch and player scan that `drawingProgress`/`liveWeights`
   * would otherwise re-read on their own connections — goes through one
   * `RepeatableRead` transaction; the player scan only runs when an owner is
   * given or the previous epoch is mid-draw. The chain-cached reads (jackpot
   * balance, rpc health, clock, pool config) run after the transaction closes.
   */
  async getState(owner?: string) {
    const serverNow = new Date();
    const { pool, epoch, previousEpoch, operator, cursor, player, rounds } =
      await this.prisma.$transaction(
        async (tx) => {
          const poolAddress = this.poolAddress;
          const pool = await tx.pool.findUnique({ where: { address: poolAddress } });
          if (pool === null) {
            throw new NotFoundException(
              "The pool is not indexed yet. Try again in a few seconds.",
            );
          }
          const [epoch, previousEpoch, operator, cursor, player, rounds] = await Promise.all([
            tx.epoch.findUnique({
              where: { poolAddress_id: { poolAddress, id: pool.currentEpochId } },
            }),
            pool.currentEpochId <= 0n
              ? Promise.resolve(null)
              : tx.epoch.findUnique({
                  where: { poolAddress_id: { poolAddress, id: pool.currentEpochId - 1n } },
                }),
            tx.operatorState.findUnique({ where: { poolAddress } }),
            tx.cursor.findUnique({ where: { poolAddress } }),
            owner === undefined
              ? Promise.resolve(null)
              : tx.player.findUnique({ where: { poolAddress_owner: { poolAddress, owner } } }),
            readRoundState(tx, poolAddress, serverNow, owner),
          ]);
          return { pool, epoch, previousEpoch, operator, cursor, player, rounds };
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
    // pool + principal vault; buyTickets: pool + jackpot vault), so `priorityFeeMicroLamports` prices the fee
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
    ];

    const [jackpotAmount, rpc, chainTime, balances, priorityFeeMicroLamports] = await Promise.all([
      epoch === null ? Promise.resolve(0n) : this.liveJackpot(epoch, pool, true),
      this.rpcHealth(),
      this.extrapolatedChainNow(),
      this.chainBalances(pool.klendReserve),
      this.chain.priorityFeeMicroLamports(hotWritableAccounts),
    ]);

    const { weights, total } =
      player === null ? { weights: [], total: 0n } : await this.weightsFor(pool, [player]);
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
      player: mine === undefined ? null : playerDto(mine, total),
      status: statusFrom(operator, cursor, rpc, pool, balances, this.operatorSolWarn),
      chainTime,
      /** Ticket 04's cached estimate, scoped to `hotWritableAccounts` above.
       *  Untrusted by the time it reaches the browser: the web send helper
       *  caps and validates it before signing (ticket 08). */
      priorityFeeMicroLamports,
      /** Ticket 05: the deposit-only launch week's countdown target; null
       *  once an Epoch exists or `LAUNCH_AT` is unset. */
      launchAt: epoch === null ? this.launchAt : null,
      /** Off-chain-tickets 16: the id a bet names to open a Round, the open
       *  Round (null on an idle board) and the newest finished one. */
      nextRoundId: rounds.nextRoundId,
      openRound: rounds.openRound,
      lastRound: rounds.lastRound,
      /** Ticket 18: the owner's own Positions in those two Rounds. */
      positions: rounds.positions,
      /** Ticket 18: wall-clock seconds, the clock `closeAt` is on. The countdown
       *  anchors to this, not to `chainTime`, which a local validator skews. */
      serverTime: BigInt(Math.floor(serverNow.getTime() / 1000)),
    };
  }

  async getLeaderboard(limit: number) {
    // ponytail: every Player row per request, for the odds denominator. Fine
    // at beta scale; page it off a mirrored total if the Player count grows
    // into the thousands.
    const pool = await this.requirePool();
    const players = await this.prisma.player.findMany({ where: { poolAddress: this.poolAddress } });
    const { weights, total } = await this.weightsFor(pool, players);
    return weights
      .slice()
      .sort((a, b) => {
        // Ticket 01: a tie (most commonly two players at 0% before any
        // Ticket exists) otherwise falls back to whatever order the DB
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
        tickets: weight,
        isHouse: player.isHouse,
        weight,
        odds: oddsPercent(weight, total),
      }));
  }

  /**
   * Newest first. `owner`, when given, keeps only events about that wallet. `JackpotPaid`
   * carries `winner` rather than `owner`, so both keys are checked; dropping
   * the `winner` half would make a "Prize Win" row vanish from that wallet's
   * filtered history. Two expression indexes, on `data->>'owner'` and `data->>'winner'`, serve the filter.
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
        AND name IN (${Prisma.join(owner === undefined ? FEED_NAMES : OWNER_FEED_NAMES)})
      ${ownerFilter}
      ORDER BY slot DESC, "index" DESC
      LIMIT ${limit}
    `;
  }

  async getStatus() {
    const poolAddress = this.poolAddress;
    // A freshly cut-over pool has no OperatorState or Cursor row until its
    // first tick and sync; statusFrom reads those nulls as "never ran"
    // rather than showing the retired pool's (ADR 0016).
    const [operator, cursor, pool, rpc, subgraphSlot] = await Promise.all([
      this.prisma.operatorState.findUnique({ where: { poolAddress } }),
      this.prisma.cursor.findUnique({ where: { poolAddress } }),
      this.prisma.pool.findUnique({ where: { address: poolAddress } }),
      this.rpcHealth(),
      this.subgraphSyncedSlot(),
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
      ...this.yieldStatus(pool, balances),
      pendingDepositPlayers: awaitingActivation,
      // Ticket 05: null once the Pool has an Epoch, or when `LAUNCH_AT` is
      // unset — the same rule `/state`'s `launchAt` follows.
      launchAt: pool !== null && pool.currentEpochId > 0n ? null : this.launchAt,
      epochEndsAt: epoch?.endsAt ?? null,
      epochStatus: epoch?.status ?? null,
      jackpotAmount:
        pool === null || epoch === null ? null : await this.liveJackpot(epoch, pool, false),
      minJackpot: pool?.minJackpot ?? 0n,
      // solami-index 09: slot of the newest Solami webhook delivery this
      // process took; null with the route off or nothing delivered yet.
      webhookLastSlot: webhookLastSlot(),
      // Slot of the newest Mirage frame this process took, and whether its
      // socket is open; both null with `MIRAGE_STREAM_URL` unset. Module
      // state like `webhookLastSlot`, so ApiModule needs no IndexerModule.
      mirageLastSlot: mirageLastSlot(),
      mirageConnected: mirageConnected(),
      // Solami ticket 08: in-memory Beam send counts since boot, null when off.
      beam: this.chain.beam?.status() ?? null,
      // Solami ticket 05: null with the subgraph unset or its read failed.
      subgraphSyncedSlot: subgraphSlot,
      subgraphBehindSlots: subgraphSlot === null || rpc.slot === null ? null : rpc.slot - subgraphSlot,
    };
  }

  /**
   * Live yield's half of GET /status (ticket 14): the solvency invariant as a
   * signed margin, free idle against the band, the reserve's utilisation and
   * free liquidity, and the two switches. A null pool (not indexed yet) reads as zeros and
   * false, like the rest of `getStatus`; a figure that needs the vault or the
   * reserve is null when that read failed, never a made-up zero.
   */
  private yieldStatus(pool: Pool | null, balances: ChainBalances) {
    const vault = balances.vaultLiquidity;
    const idle = pool === null || vault === null ? null : freeIdle(vault, pool.pendingWithdrawals);
    const reserve = balances.reserve;
    // The band is measured against free idle plus the venue position, as the
    // program measures it; `freeIdleBps` is the share of Principal.
    const band = pool === null || idle === null ? 0n : idle + pool.venueValue;
    return {
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
   * `players`' Tickets from the Ticket ledger's `TicketBalance`, and the total
   * every wallet holds, which is what a Player's share is taken over. A wallet
   * with no balance row holds none.
   *
   * ponytail: the whole balance table per call for the total, two columns
   * wide. Fine at beta scale; keep a running total if the wallet count grows
   * into the tens of thousands.
   */
  private async weightsFor(
    pool: Pool,
    players: readonly Player[],
  ): Promise<{ weights: LiveWeight[]; total: bigint }> {
    // Deposit-only launch week: `currentEpochId` 0 means no Epoch yet, so the
    // draw has no Tickets and every share reads zero.
    if (pool.currentEpochId === 0n) {
      return { weights: weightsFrom(players, new Map(), pool.currentEpochId), total: 0n };
    }
    const balances = await this.prisma.ticketBalance.findMany({
      where: { poolAddress: this.poolAddress },
      select: { owner: true, tickets: true },
    });
    const held = new Map(balances.map(({ owner, tickets }) => [owner, tickets]));
    return {
      weights: weightsFrom(players, held, pool.currentEpochId),
      total: balances.reduce((sum, { tickets }) => sum + tickets, 0n),
    };
  }

  /**
   * Chain time as of right now: the cached Clock sysvar value (see
   * `chainClock` below, so this spends no extra call) advanced by the wall
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

  /**
   * The Clock sysvar's `unix_timestamp`, read the same way the operator reads
   * it (see `operator/chain-state.ts`), so Weight and odds here agree with
   * what the draw uses instead of drifting from wall time. Cached for
   * `CHAIN_CLOCK_TTL_MS` so polling does not turn into a chain read per viewer.
   */
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
  async chainBalances(klendReserve?: string): Promise<ChainBalances> {
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

  /** The subgraph's synced slot, on `rpcOk`'s cadence; null when it is not
   *  configured or the read failed (the client has already scrubbed the error). */
  private subgraphSyncedSlot(): Promise<number | null> {
    const subgraph = this.subgraph;
    if (subgraph === null) return Promise.resolve(null);
    this.subgraphProbe = this.cached(this.subgraphProbe, RPC_PROBE_TTL_MS, async () => {
      try {
        return (await subgraph.syncedSlot()).slot;
      } catch (cause) {
        this.logger.warn(`subgraph status read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    });
    return this.subgraphProbe.result;
  }

  /**
   * Serves `fetch()` from `cache` for `ttlMs`, replacing it with a fresh call
   * once the window lapses. Returns the new cache entry; the caller stores
   * it back on its own field since a shared private field would mix values
   * of different types across `chainClock` and `rpcHealth` above.
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

/** Draw progress for the epoch that just ended, from the row already read.
 *  Null unless `previous` is Ended (waiting for the draw) or Drawing.
 *  `jackpotAmount` is what it draws for: 0 until `request_draw` snapshots it,
 *  then reserved out of the vault, so the new epoch's live figure leaves it out. */
function drawingProgressFrom(previous: Epoch | null) {
  if (previous === null || (previous.status !== EPOCH_ENDED && previous.status !== EPOCH_DRAWING)) {
    return null;
  }
  return { epochId: previous.id, status: previous.status, jackpotAmount: previous.jackpotAmount };
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

/** Each player's ledger Tickets and pending deposit in the epoch `currentEpochId`. */
function weightsFrom(
  players: readonly Player[],
  held: ReadonlyMap<string, bigint>,
  currentEpochId: bigint,
): LiveWeight[] {
  return players.map((player) => ({
    player,
    weight: held.get(player.owner) ?? 0n,
    pending: pendingTickets(player, currentEpochId),
  }));
}

/** A weighted Player as `/players/:owner` and `/state` return it. `tickets`
 *  and `weight` are both the ledger's Tickets (`weight` is the older name the
 *  web still reads), `pendingTickets` the Principal that starts
 *  earning them in `pendingActivatesEpoch` (null when nothing is pending). */
function playerDto(entry: LiveWeight, total: bigint) {
  return {
    ...entry.player,
    tickets: entry.weight,
    weight: entry.weight,
    pendingTickets: entry.pending,
    pendingActivatesEpoch: entry.pending > 0n ? entry.player.pendingDepositEpoch + 1n : null,
    odds: oddsPercent(entry.weight, total),
  };
}

/**
 * `boughtToday` and `buyAllowanceLeft` for `/players/:owner`, from the
 * epoch-gated counter `buy_tickets` keeps on the Player (see `ifCurrentEpoch`). `buyAllowanceLeft` mirrors the on-chain
 * cap check in `bought_amount_after`: spend is capped at locked Principal
 * (Principal less the Pending deposit) per day.
 */
export function playerTicketExtras(player: Player, currentEpochId: bigint) {
  const boughtToday = ifCurrentEpoch(player.boughtEpoch, currentEpochId, player.boughtAmount);
  const locked = player.principal - pendingTickets(player, currentEpochId);
  return {
    boughtToday,
    buyAllowanceLeft: locked > boughtToday ? locked - boughtToday : 0n,
  };
}
