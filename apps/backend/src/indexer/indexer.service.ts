import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventParser } from "@anchor-lang/core";
import type { Epoch, Player, Prisma, Round } from "@prisma/client";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import bs58 from "bs58";

import { ensureReferralCode } from "../api/referral-code";
import {
  applyReferralEvent,
  isQualified,
  type ReferralPrincipalEvent,
  type ReferralQualificationState,
} from "../api/referral";
import {
  computeBonuses,
  REFERRAL_BONUS_BASIS_CAP,
  remainingGrantCap,
  splitShares,
  type ReferrerBonusInput,
  type ShareWeight,
} from "../api/referral-bonus";
import { ChainService } from "../chain/chain.service";
import { rpcStatus } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { nodeCount, prefixWeights, readNodes } from "../operator/weight-tree";
import { PrismaService } from "../prisma/prisma.service";
import {
  closedRound,
  decodeEventLogs,
  epochRow,
  LIVE_ROUND_STATUSES,
  playerRow,
  poolRow,
  positionRow,
  roundRow,
  settledPosition,
  venueProposalRow,
  type DecodedEpoch,
  type DecodedEvent,
  type DecodedPlayer,
  type DecodedPool,
  type DecodedPosition,
  type DecodedRound,
  type DecodedVenueProposal,
} from "./decode";

/** What a log-triggered read expects at an address, plus anything the row
 *  builder needs that the account bytes do not carry. */
type WantedAccount =
  | { kind: "pool" }
  | { kind: "epoch" }
  | { kind: "round" }
  | { kind: "player" }
  | { kind: "venueProposal" }
  | { kind: "position"; roundId: bigint };

/** One string field of a decoded event, or undefined when the event has no
 *  such field. `jsonify` renders every pubkey and u64 as a string. */
function eventField(event: DecodedEvent, key: string): string | undefined {
  const { data } = event;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

/** True boolean fields only; `eventField` is string-only and `compounded`
 *  jsonifies as a real boolean, not a string. */
function eventBool(event: DecodedEvent, key: string): boolean | undefined {
  const { data } = event;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The Principal-changing events ticket 07's `Referral.aboveSince` tracker
 * needs (live yield settles inside the money instructions. Principal falls when
 * a pending deposit refunds, which WithdrawRequested reports as `refunded`, and
 * when a queued withdrawal pays, which Withdrawn reports as the Principal left),
 * paired with their owner, in the batch's own emission order (a dip
 * and a restore in one batch must be applied as two separate crossings, not
 * collapsed into one net delta). JackpotPaid only counts when `compounded`:
 * a House win never compounds, and an uncompounded win pays a token account
 * instead of moving Principal.
 */
function referralPrincipalEvents(
  events: readonly DecodedEvent[],
): { owner: string; event: ReferralPrincipalEvent }[] {
  const result: { owner: string; event: ReferralPrincipalEvent }[] = [];
  for (const event of events) {
    const amount = eventField(event, "amount");
    if (event.name === "Deposited") {
      const owner = eventField(event, "owner");
      const principal = eventField(event, "principal");
      if (owner !== undefined && principal !== undefined) {
        result.push({ owner, event: { kind: "Deposited", principal: BigInt(principal) } });
      }
    } else if (event.name === "WithdrawRequested") {
      const owner = eventField(event, "owner");
      const refunded = eventField(event, "refunded");
      if (owner !== undefined && refunded !== undefined) {
        result.push({ owner, event: { kind: "WithdrawRequested", refunded: BigInt(refunded) } });
      }
    } else if (event.name === "Withdrawn") {
      const owner = eventField(event, "owner");
      const principal = eventField(event, "principal");
      if (owner !== undefined && principal !== undefined) {
        result.push({ owner, event: { kind: "Withdrawn", principal: BigInt(principal) } });
      }
    } else if (event.name === "JackpotPaid" && eventBool(event, "compounded") === true) {
      // JackpotPaid names its player `winner`, not `owner` (see refreshFromLogs).
      const owner = eventField(event, "winner");
      if (owner !== undefined && amount !== undefined) {
        result.push({ owner, event: { kind: "JackpotPaid", amount: BigInt(amount) } });
      }
    }
  }
  return result;
}

/**
 * The account sync is event driven: a confirmed program log triggers one
 * `getProgramAccountsV2` walk. This sweep is the safety net for a dropped
 * websocket, and it is where the finalized event catch-up runs.
 */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * A full, unfiltered walk is the backstop for anything an incremental sweep
 * or an event missed. Every other sweep asks only for what changed since the
 * last one, so this only bites once an hour instead of every minute.
 */
const FULL_WALK_INTERVAL_MS = 60 * 60 * 1000;
/** ticket 08: how long `v2Unsupported` sticks before `fetchAll` gives
 *  `getProgramAccountsV2` another try. */
const V2_UNSUPPORTED_RESET_MS = 60 * 60 * 1000;
// One page of `getSignaturesForAddress`. `catchUpEvents` pages backwards
// with `before` past as many of these as the backlog since the cursor takes,
// so a long outage no longer loses anything older than one page.
const SIGNATURE_PAGE = 1_000;

/** The Yield index history keeps at most one point a minute (spec "Backend"). */
const YIELD_INDEX_MIN_GAP_S = 60n;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

// Anchor's `Program` runs the IDL through `convertIdlToCamelCase` before it
// builds the coder, so the coder knows `Pool` as `pool`. A wrong name here
// throws "Account not found", it never decodes the wrong layout.
const ACCOUNT = {
  pool: "pool",
  epoch: "epoch",
  round: "round",
  player: "player",
  position: "position",
  venueProposal: "venueProposal",
} as const;

/** One transaction's finalized logs, the unit both ingest paths hand over. */
export interface LogBatch {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  logs: string[];
}

/** Decoded accounts of one type, from the paginated program-accounts walk. */
interface AccountsByType {
  get<T>(name: string): { pubkey: PublicKey; account: T }[];
}

/** One account as `getProgramAccountsV2` reports it: base58 pubkey, data as
 *  the standard `[base64, encoding]` tuple (requested with `encoding: "base64"`). */
interface RawProgramAccount {
  pubkey: string;
  account: { data: [string, string] };
}

/**
 * `getProgramAccountsV2` is a Helius extension, probed 2026-09-14 against the
 * devnet key on the Free plan: pages at 1,000 rows, keyed by `paginationKey`,
 * and honours `changedSinceSlot`. It is not in @solana/web3.js 1.98.4's
 * `Connection`, so there is no typed response shape to import; this mirrors
 * the envelope every other `withContext` call on this RPC already uses
 * (`context.slot` alongside a `value` carrying the method's own payload).
 */
interface ProgramAccountsV2Response {
  context: { slot: number };
  value: {
    accounts: RawProgramAccount[];
    count: number;
    /** Explicitly `null` on the last page, not absent (probed 2026-09-14
     *  against the devnet key: a 6,534-account walk ends `"paginationKey":
     *  null` on page 7). Sending that null back is a hard RPC error, so the
     *  walk has to treat it as the end, not as another page. */
    paginationKey?: string | null;
  };
}

/** Raised when the RPC has no `getProgramAccountsV2`, so the walk retries on
 *  the plain call. Not an error the sweep reports: it is a provider fact. */
class MethodNotFound extends Error {}

/**
 * JSON-RPC reserves -32601 for an unknown method, but providers differ on
 * whether they set it, so the message is matched as well.
 */
const isMethodNotFound = (error: { code?: number; message: string }): boolean =>
  error.code === -32601 || /method not found/i.test(error.message);

interface SocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Mirrors program accounts and finalized events into Postgres (spec §3.3) and
 * answers the reads the operator and the API make, so neither hammers the RPC.
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private readonly parser: EventParser;

  private timer?: NodeJS.Timeout;
  private subscriptionId?: number;
  private syncSubscriptionId?: number;
  /** Single-flight: a slow tick is skipped, never queued behind itself. */
  private ticking = false;
  /** Coalesces log-triggered syncs: one in flight, at most one more queued. */
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  /** Serializes the live socket and the catch-up poll onto one writer. */
  private queue: Promise<void> = Promise.resolve();
  private lastFailure: string | undefined;
  private socketState = "connected";
  /** Slot the last successful sweep was consistent as of. Undefined before
   *  the first walk, which forces every process boot to start full. */
  private lastSyncedSlot: bigint | undefined;
  /** Wall time of the last full walk, gating `FULL_WALK_INTERVAL_MS`. */
  private lastFullWalkAt = 0;
  /** Set once the primary RPC answers "method not found" for
   *  `getProgramAccountsV2`, which a local validator and most non-Helius
   *  providers do. Cleared after `V2_UNSUPPORTED_RESET_MS` (ticket 08): a
   *  provider can add the extension, or a fallback-served false positive
   *  (see `fetchAll`'s own guard) should not degrade every later sweep for
   *  the rest of the process's life. */
  private v2Unsupported = false;
  /** Wall time `v2Unsupported` was last set; undefined while it is false. */
  private v2UnsupportedSince: number | undefined;
  /**
   * Addresses the log path has written, and the slot it wrote them from.
   * `getProgramAccountsV2`'s index runs behind the chain (measured
   * 2026-09-14 against devnet: 33 to 59 slots, 13 to 24 seconds), so a sweep
   * can hand back a row older than one of these; those rows are skipped and
   * the entry is dropped once a sweep has caught up past it.
   */
  private freshWrites = new Map<string, bigint>();
  /** Ticket 08's qualify hold period, read once at construction like every
   *  other env-derived constant this service uses. */
  private readonly referralQualifySeconds: number;
  /** The Active pool's address (the `POOL_ID` PDA). Every pool-scoped row
   *  this service reads or writes is filtered or keyed by it, so a retired
   *  pool's rows in the same database are never read as current (ADR 0016). */
  private readonly activePool: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.parser = new EventParser(this.chain.programId, this.chain.program.coder);
    this.referralQualifySeconds = config.get("REFERRAL_QUALIFY_SECONDS", { infer: true });
    this.activePool = this.chain.poolAddress().toBase58();
  }

  onModuleInit(): void {
    this.watchSocket();
    this.subscribeToLogs();
    this.subscribeToSync();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const id of [this.subscriptionId, this.syncSubscriptionId]) {
      if (id !== undefined) await this.chain.connection.removeOnLogsListener(id);
    }
    await this.queue;
    await this.syncing;
  }

  // ---------------------------------------------------------------- reads

  getPlayers(): Promise<Player[]> {
    return this.prisma.player.findMany({ where: { poolAddress: this.activePool } });
  }

  /** The round the operator may still act on, newest first. */
  getOpenRound(): Promise<Round | null> {
    return this.prisma.round.findFirst({
      where: { poolAddress: this.activePool, status: { in: LIVE_ROUND_STATUSES } },
      orderBy: { id: "desc" },
    });
  }

  getEpoch(id: bigint): Promise<Epoch | null> {
    return this.prisma.epoch.findUnique({
      where: { poolAddress_id: { poolAddress: this.activePool, id } },
    });
  }

  /**
   * Positions still on chain whose Round is Settled, Forfeited or Voided,
   * across every such Round, so still worth a `settle_position`. Position has
   * no Prisma relation to Round (just its id), so this is two queries.
   */
  async unsettledPositions(): Promise<{ address: string; owner: string; roundId: bigint }[]> {
    const terminalRounds = await this.prisma.round.findMany({
      where: { poolAddress: this.activePool, status: { notIn: LIVE_ROUND_STATUSES } },
      select: { id: true },
    });
    if (terminalRounds.length === 0) return [];
    return this.prisma.position.findMany({
      where: {
        poolAddress: this.activePool,
        roundId: { in: terminalRounds.map((round) => round.id) },
      },
      select: { address: true, owner: true, roundId: true },
    });
  }

  /**
   * Terminal Rounds (Settled, Forfeited, Voided) with no Position left on
   * them and not yet marked closed (ops-and-envs ticket 08): what
   * `close_round` may still reclaim rent from. Two queries for the same
   * reason as `unsettledPositions`: Position has no Prisma relation to
   * Round. Oldest id first, so a long backlog drains in order.
   */
  async roundsToClose(): Promise<bigint[]> {
    const rounds = await this.prisma.round.findMany({
      where: { poolAddress: this.activePool, status: { notIn: LIVE_ROUND_STATUSES }, closed: false },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (rounds.length === 0) return [];
    const busyRounds = await this.prisma.position.findMany({
      where: { poolAddress: this.activePool, roundId: { in: rounds.map((round) => round.id) } },
      select: { roundId: true },
      distinct: ["roundId"],
    });
    const busy = new Set(busyRounds.map((position) => position.roundId));
    return rounds.map((round) => round.id).filter((id) => !busy.has(id));
  }

  /**
   * Ticket 08's daily bonus job. Every wallet that refers at least one other
   * wallet is a candidate; one it computes and records once for `epochId`
   * (via `createMany({ skipDuplicates: true })`, so a referrer newly
   * discovered on a later tick still gets a row, but an already-recorded one
   * keeps its original amount rather than drifting as the day goes on), then
   * hands back whatever is still unsent and not already granted on chain,
   * re-clamped against the freshest Player data first (see the loop below).
   */
  async referralGrantsDue(epochId: bigint): Promise<{ referrer: string; amount: bigint }[]> {
    const poolAddress = this.activePool;
    const pool = await this.prisma.pool.findUnique({ where: { address: poolAddress } });
    if (!pool) return [];

    // Referral is wallet-level and outlives any one pool; everything the
    // bonus is computed against below (Player, ReferralGrant) is the Active
    // pool's only, so a referee with no Player here counts for nothing
    // after a cutover (ADR 0016).
    const referrals = await this.prisma.referral.findMany({
      select: { referee: true, referrer: true, principal: true, aboveSince: true },
    });
    if (referrals.length === 0) return [];
    const byReferrer = new Map<
      string,
      { referee: string; principal: bigint; aboveSince: bigint | null }[]
    >();
    for (const row of referrals) {
      const list = byReferrer.get(row.referrer) ?? [];
      list.push({ referee: row.referee, principal: row.principal, aboveSince: row.aboveSince });
      byReferrer.set(row.referrer, list);
    }

    const referrerPlayers = await this.prisma.player.findMany({
      where: { poolAddress, owner: { in: [...byReferrer.keys()] } },
      select: { owner: true, principal: true, bonusEpoch: true, bonusGranted: true },
    });
    const playerByOwner = new Map(referrerPlayers.map((player) => [player.owner, player]));
    const now = nowSeconds();

    // Skip referrers with no Player or a Principal of 0: the operator cap on
    // grant_tickets would refuse them anyway (docs/plan/hexo-referrals
    // ticket 08's own instruction). alreadyGrantedToday mirrors the same
    // lazy reset the program applies to bonus_granted: a stale bonusEpoch
    // means today's counter has not actually been touched yet, so it reads
    // as 0 rather than whatever a previous epoch left behind.
    // referral-page ticket 05: each referrer's qualified referees, weighted
    // by their own basis (the same min(Principal, REFERRAL_BONUS_BASIS_CAP)
    // computeBonuses sums for the rate), for splitShares to divide their
    // grant across below.
    const qualifiedRefereesByReferrer = new Map<string, ShareWeight[]>();
    const inputs: ReferrerBonusInput[] = [...byReferrer].map(([referrer, refs]) => {
      const player = playerByOwner.get(referrer);
      const qualified = refs.filter((ref) =>
        isQualified(ref.aboveSince, now, this.referralQualifySeconds),
      );
      qualifiedRefereesByReferrer.set(
        referrer,
        qualified.map((ref) => ({
          referee: ref.referee,
          weight: ref.principal < REFERRAL_BONUS_BASIS_CAP ? ref.principal : REFERRAL_BONUS_BASIS_CAP,
        })),
      );
      return {
        referrer,
        principal: player?.principal ?? 0n,
        alreadyGrantedToday: player?.bonusEpoch === epochId ? player.bonusGranted : 0n,
        qualifiedReferralPrincipals: qualified.map((ref) => ref.principal),
      };
    });

    // beta-launch-fixes ticket 11: the pool-wide cap is shared across the
    // whole epoch, so a referrer who first qualifies late in the day is
    // scaled against the headroom earlier grants already used rather than
    // the full cap recomputed fresh — which used to compute an amount the
    // on-chain call then refused outright once summed with what earlier
    // grants this epoch had already spent.
    const recordedThisEpoch = await this.prisma.referralGrant.findMany({
      where: { poolAddress, epochId },
      select: { referrer: true, amount: true },
    });
    const alreadyGrantedThisEpoch = recordedThisEpoch.reduce(
      (sum, grant) => sum + grant.amount,
      0n,
    );
    const recordedReferrers = new Set(recordedThisEpoch.map((grant) => grant.referrer));
    // Already-recorded referrers keep their frozen amount (see the
    // `uncapped` comment below); only referrers with no row yet this epoch
    // are candidates for a fresh computation against the headroom.
    const newInputs = inputs.filter((input) => !recordedReferrers.has(input.referrer));

    const bonuses = computeBonuses(
      newInputs,
      pool.totalPrincipal,
      pool.bonusCapBps,
      alreadyGrantedThisEpoch,
    );
    if (bonuses.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        // referral-page ticket 05: shares are written in the same
        // transaction as the grant, with the same idempotency — only for a
        // referrer whose ReferralGrant row is new this tick, so a referrer
        // already recorded (whose amount is frozen the same way, see the
        // comment on `uncapped` below) does not get its shares re-derived
        // from qualified referees that may have changed since.
        const already = await tx.referralGrant.findMany({
          where: { poolAddress, epochId, referrer: { in: bonuses.map((bonus) => bonus.referrer) } },
          select: { referrer: true },
        });
        const alreadyWritten = new Set(already.map((row) => row.referrer));

        // skipDuplicates keys on (poolAddress, epochId, referrer): epoch ids
        // restart on every pool, so without poolAddress a retired pool's
        // epoch-1 row would silently swallow this one (ADR 0016).
        await tx.referralGrant.createMany({
          data: bonuses.map((bonus) => ({
            poolAddress,
            epochId,
            referrer: bonus.referrer,
            amount: bonus.amount,
            // referral-page ticket 04: written once here, like amount/
            // qualifiedCount/rateBps, and never touched by the re-clamp loop
            // below — it is defined as what the referrer would get without
            // their own Principal moving, so a later Principal change has
            // nothing to re-derive it from.
            uncapped: bonus.uncapped,
            qualifiedCount: bonus.qualifiedCount,
            rateBps: bonus.rateBps,
          })),
          skipDuplicates: true,
        });

        const shareRows = bonuses
          .filter((bonus) => !alreadyWritten.has(bonus.referrer))
          .flatMap((bonus) =>
            splitShares(bonus.amount, qualifiedRefereesByReferrer.get(bonus.referrer) ?? []).map(
              (share) => ({
                poolAddress,
                epochId,
                referrer: bonus.referrer,
                referee: share.referee,
                amount: share.amount,
              }),
            ),
          );
        if (shareRows.length > 0) {
          await tx.referralGrantShare.createMany({ data: shareRows, skipDuplicates: true });
        }
      });
    }

    // ticket 11: a deterministic order, so a batch built from this list is
    // the same set on a retry regardless of Postgres's own row order.
    const pending = await this.prisma.referralGrant.findMany({
      where: { poolAddress, epochId, txSig: null },
      select: { referrer: true, amount: true },
      orderBy: { referrer: "asc" },
    });

    // Re-clamp every already-recorded grant against the freshest Player
    // data: a referrer's Principal can move (a withdrawal) in the ticks
    // between when their row was written and when a batch actually sends
    // it. A stale amount above their current headroom would fail on chain
    // every tick forever, wedging every other referrer batched alongside
    // them (the exact failure the atomic-batch ponytail note in tick.ts
    // warns about), so the amount actually handed back, and the row
    // recording it, always reflect the latest Principal.
    const due: { referrer: string; amount: bigint }[] = [];
    const changed: { referrer: string; amount: bigint }[] = [];
    for (const grant of pending) {
      const player = playerByOwner.get(grant.referrer);
      if (player?.bonusEpoch === epochId) continue; // already granted on chain
      const cap = remainingGrantCap(player?.principal ?? 0n, 0n);
      const amount = grant.amount < cap ? grant.amount : cap;
      // Persisted even when it clamps all the way to 0, so a referrer whose
      // Principal has left entirely does not leave a stale positive amount
      // sitting on the row (ticket 11 reads this as "today's bonus").
      if (amount !== grant.amount) changed.push({ referrer: grant.referrer, amount });
      if (amount <= 0n) continue;
      due.push({ referrer: grant.referrer, amount });
    }
    if (changed.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const grant of changed) {
          await tx.referralGrant.update({
            where: {
              poolAddress_epochId_referrer: { poolAddress, epochId, referrer: grant.referrer },
            },
            data: { amount: grant.amount },
          });
          // referral-page ticket 05: rescale this referrer's shares off
          // their own existing amounts as the weight (they already sum to
          // the grant's old amount), so a shrink keeps the same proportions
          // and the shares stay exactly summed to the re-clamped amount,
          // without re-deriving them from referee Principal data that may
          // have moved again since they were written.
          const shares = await tx.referralGrantShare.findMany({
            where: { poolAddress, epochId, referrer: grant.referrer },
            select: { referee: true, amount: true },
          });
          if (shares.length === 0) continue;
          const rescaled = splitShares(
            grant.amount,
            shares.map((share) => ({ referee: share.referee, weight: share.amount })),
          );
          for (const share of rescaled) {
            await tx.referralGrantShare.update({
              where: {
                poolAddress_epochId_referrer_referee: {
                  poolAddress,
                  epochId,
                  referrer: grant.referrer,
                  referee: share.referee,
                },
              },
              data: { amount: share.amount },
            });
          }
        }
      });
    }
    return due;
  }

  async markReferralGrantsSent(
    epochId: bigint,
    referrers: readonly string[],
    txSig: string,
  ): Promise<void> {
    await this.prisma.referralGrant.updateMany({
      where: { poolAddress: this.activePool, epochId, referrer: { in: [...referrers] } },
      data: { txSig },
    });
  }

  // ------------------------------------------------------------- the tick

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Sync first: its full walk upserts the Active pool's Pool row, which
      // every Event, Epoch, Round, Player, Position and Cursor row written
      // after it references by foreign key (ADR 0016). On a brand-new pool
      // that walk is what creates the row at all.
      await this.requestSync();
      await this.catchUpEvents();
      await this.prisma.cursor.upsert({
        where: { poolAddress: this.activePool },
        create: { poolAddress: this.activePool, updatedAt: nowSeconds() },
        update: { updatedAt: nowSeconds() },
      });
      this.noteRecovery();
    } catch (error) {
      this.noteFailure("indexer tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  // --------------------------------------------------------- account sync

  /**
   * Every confirmed pool transaction changes some account, so each one
   * re-reads the accounts it touched. Not a sweep: `getProgramAccountsV2`'s
   * index runs 13 to 24 seconds behind the chain (measured 2026-09-14), so a
   * sweep fired by a log returns a snapshot from before the transaction that
   * fired it, and the mirror the browser reads would sit that far behind the
   * countdown. `getMultipleAccountsInfo` reads at the connection's own
   * commitment for one credit, against ten for the unpaginated walk this
   * replaced, and the periodic sweep stays as the safety net.
   *
   * Subscribed on the pool PDA, not the program: every instruction takes the
   * pool account, so "mentions the pool" is exactly "belongs to this pool".
   * Several pools share one program on devnet, and the events carry no pool
   * field to filter on afterwards.
   */
  private subscribeToSync(): void {
    this.syncSubscriptionId = this.chain.connection.onLogs(
      this.chain.poolAddress(),
      (logs, context) => {
        if (logs.err) return;
        void this.enqueue(() =>
          this.refreshFromLogs(logs.logs, BigInt(context.slot)),
        ).catch((error: unknown) =>
          this.noteFailure("log-triggered refresh failed", error),
        );
      },
      "confirmed",
    );
  }

  /**
   * Re-reads exactly the accounts one confirmed transaction touched.
   *
   * Most of them are named by the transaction's own events. Two instructions
   * emit none on their usual path — `request_round_randomness` moves the open
   * Round, and `request_draw` moves the epoch that just ended — so the open Round
   * and the two epochs either side of the pool's cursor are asked for every
   * time rather than derived from an event that is not there. That is four
   * addresses on a quiet transaction and a handful on a busy one, all in one
   * call.
   */
  private async refreshFromLogs(logs: string[], slot: bigint): Promise<void> {
    // The Pool goes in first: `wanted` is applied in insertion order, so its
    // row lands before the rows below that reference it (ADR 0016).
    const wanted = new Map<string, WantedAccount>();
    wanted.set(this.activePool, { kind: "pool" });
    // Every pool instruction can open, replace or close the proposal, and a
    // close leaves no account to read, so it is asked for every time.
    wanted.set(this.chain.venueProposalAddress().toBase58(), { kind: "venueProposal" });

    const [pool, openRound] = await Promise.all([
      this.prisma.pool.findUnique({ where: { address: this.activePool } }),
      this.getOpenRound(),
    ]);
    const currentEpochId = pool?.currentEpochId ?? 0n;
    for (const epochId of [currentEpochId, currentEpochId - 1n]) {
      if (epochId > 0n) {
        wanted.set(this.chain.epochAddress(epochId).toBase58(), { kind: "epoch" });
      }
    }
    if (openRound) {
      wanted.set(this.chain.roundAddress(openRound.id).toBase58(), { kind: "round" });
    }

    for (const event of decodeEventLogs(this.parser, logs)) {
      const epochId = eventField(event, "epochId");
      const roundId = eventField(event, "roundId");
      // JackpotPaid names its player `winner`; every other event says `owner`.
      const owner = eventField(event, "owner") ?? eventField(event, "winner");
      if (epochId !== undefined) {
        wanted.set(this.chain.epochAddress(BigInt(epochId)).toBase58(), { kind: "epoch" });
      }
      if (roundId !== undefined) {
        wanted.set(this.chain.roundAddress(BigInt(roundId)).toBase58(), { kind: "round" });
      }
      if (owner !== undefined) {
        wanted.set(this.chain.playerAddress(new PublicKey(owner)).toBase58(), { kind: "player" });
      }
      if (roundId !== undefined && owner !== undefined) {
        const round = this.chain.roundAddress(BigInt(roundId));
        wanted.set(this.chain.positionAddress(round, new PublicKey(owner)).toBase58(), {
          kind: "position",
          roundId: BigInt(roundId),
        });
      }
    }

    const addresses = [...wanted.keys()];
    const infos = await this.chain.connection.getMultipleAccountsInfo(
      addresses.map((address) => new PublicKey(address)),
    );
    for (const [index, address] of addresses.entries()) {
      // SAFETY: `wanted` is what `addresses` was built from, key for key.
      await this.applyAccount(address, wanted.get(address)!, infos[index]?.data, slot);
    }
  }

  /**
   * Writes one account read by `refreshFromLogs`. A Position is the only
   * account this program closes, so it is the only one whose absence means
   * "gone"; anything else missing is a read that raced its own transaction,
   * and the next log or sweep brings it in.
   */
  private async applyAccount(
    address: string,
    wanted: WantedAccount,
    data: Buffer | undefined,
    slot: bigint,
  ): Promise<void> {
    const coder = this.chain.program.coder.accounts;
    const pubkey = new PublicKey(address);
    if (data === undefined) {
      if (wanted.kind === "venueProposal") {
        // Closed by `cancel_venue`: absence is the fact.
        await this.prisma.venueProposal.deleteMany({ where: { poolAddress: this.activePool } });
        this.freshWrites.set(address, slot);
        return;
      }
      if (wanted.kind !== "position") return;
      await this.prisma.position.deleteMany({ where: { poolAddress: this.activePool, address } });
      this.freshWrites.set(address, slot);
      return;
    }
    const poolAddress = this.activePool;
    switch (wanted.kind) {
      case "pool": {
        const pool = coder.decode<DecodedPool>(ACCOUNT.pool, data);
        const row = poolRow(pubkey, pool, slot);
        await this.prisma.pool.upsert({ where: { address: row.address }, create: row, update: row });
        await this.mirrorLiveYield(row, pool);
        break;
      }
      case "venueProposal": {
        const row = venueProposalRow(
          coder.decode<DecodedVenueProposal>(ACCOUNT.venueProposal, data),
          poolAddress,
          slot,
        );
        await this.prisma.venueProposal.upsert({ where: { poolAddress }, create: row, update: row });
        break;
      }
      case "epoch": {
        const row = epochRow(coder.decode<DecodedEpoch>(ACCOUNT.epoch, data), poolAddress);
        await this.prisma.epoch.upsert({
          where: { poolAddress_id: { poolAddress, id: row.id } },
          create: row,
          update: row,
        });
        break;
      }
      case "round": {
        const row = roundRow(coder.decode<DecodedRound>(ACCOUNT.round, data), poolAddress);
        await this.prisma.round.upsert({
          where: { poolAddress_id: { poolAddress, id: row.id } },
          create: row,
          update: row,
        });
        break;
      }
      case "player": {
        const row = playerRow(coder.decode<DecodedPlayer>(ACCOUNT.player, data), poolAddress);
        await this.prisma.player.upsert({
          where: { poolAddress_owner: { poolAddress, owner: row.owner } },
          create: row,
          update: row,
        });
        break;
      }
      case "position": {
        const row = positionRow(
          pubkey,
          coder.decode<DecodedPosition>(ACCOUNT.position, data),
          wanted.roundId,
          poolAddress,
        );
        await this.prisma.position.upsert({
          where: { address: row.address },
          create: row,
          update: row,
        });
        break;
      }
    }
    this.freshWrites.set(address, slot);
  }

  /**
   * What a changed Pool implies besides its own row (ticket 14). One Yield
   * index point, at most one a minute, stamped with the pool's own sync time;
   * and the Weight tree's header and the root Weight of the current epoch.
   *
   * ponytail: the tree read is the whole account, about 56 bytes a Player, so
   * 10,000 Players is 720 KB per Pool change. Read the header and the
   * root's O(log n) nodes with `dataSlice` instead once that shows in the RPC
   * bill. A failed read leaves the last mirrored state and is logged, so a
   * tree the RPC cannot serve never stops the Pool row itself.
   */
  private async mirrorLiveYield(row: Prisma.PoolCreateInput, pool: DecodedPool): Promise<void> {
    const poolAddress = row.address;
    const at = BigInt(pool.lastSyncAt.toString());
    if (at > 0n) {
      const latest = await this.prisma.yieldIndexPoint.findFirst({
        where: { poolAddress },
        orderBy: { at: "desc" },
      });
      if (latest === null || at >= latest.at + YIELD_INDEX_MIN_GAP_S) {
        await this.prisma.yieldIndexPoint.createMany({
          data: [{ poolAddress, at, yieldIndex: pool.yieldIndex.toString() }],
          skipDuplicates: true,
        });
      }
    }
    try {
      const info = await this.chain.connection.getAccountInfo(pool.weightTree);
      if (info === null) return;
      const epochId = BigInt(pool.currentEpochId.toString());
      const prefix = prefixWeights(readNodes(info.data), epochId);
      const state = {
        nodeCount: BigInt(nodeCount(info.data)),
        epochId,
        rootWeight: (prefix[prefix.length - 1] as bigint).toString(),
      };
      await this.prisma.weightTreeState.upsert({
        where: { poolAddress },
        create: { poolAddress, ...state },
        update: state,
      });
    } catch (error) {
      this.noteFailure("weight tree mirror failed", error);
    }
  }

  /** True when the log path already wrote this address from a slot the
   *  sweep's snapshot predates, so the sweep's row is a step backwards. */
  private behindLogPath(pubkey: PublicKey, sweepSlot: bigint): boolean {
    const written = this.freshWrites.get(pubkey.toBase58());
    return written !== undefined && written > sweepSlot;
  }

  private requestSync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncAccounts();
        } while (this.syncAgain);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * Walks `getProgramAccountsV2` (a full, unfiltered walk on boot and once an
   * hour, an incremental `changedSinceSlot` walk every other sweep), sorted
   * by Anchor discriminator locally, then one Prisma transaction per type.
   *
   * Every account is checked against the PDA it must live at for the
   * configured pool. Epoch, Round and Player carry no pool field on chain,
   * and the walk returns every pool the program owns, so this is what keeps
   * a sibling pool's accounts from being written under the Active pool's
   * address (ADR 0016).
   *
   * A closed Position never appears here to begin with on an incremental
   * walk (an absent account looks identical to an unchanged one), so a
   * settled Position is not detected by its absence any more: the
   * `PositionSettled` event `persist()` ingests removes the row instead, the
   * moment it lands, sweep or no sweep. A full walk still deletes by absence
   * as a second guard, which is the only guard on an RPC without V2; a
   * missing Round account gets the same absence-based backstop, marked
   * closed rather than deleted (ticket 06).
   */
  async syncAccounts(): Promise<void> {
    const pool = this.chain.poolAddress();
    const poolAddress = this.activePool;
    const fullWalk =
      this.lastSyncedSlot === undefined ||
      this.v2Unsupported ||
      Date.now() - this.lastFullWalkAt >= FULL_WALK_INTERVAL_MS;
    const { slot, accounts } = await this.fetchAll(fullWalk ? undefined : this.lastSyncedSlot);

    const poolsSeen = accounts.get<DecodedPool>(ACCOUNT.pool).filter(({ pubkey }) => pubkey.equals(pool));
    // An incremental walk legitimately reports nothing when the Pool has not
    // changed; only a full walk finding it missing means misconfiguration.
    if (fullWalk && poolsSeen.length === 0) {
      throw new Error(`configured pool ${pool.toBase58()} is not on chain or does not decode with the current IDL`);
    }
    // Every write below skips an account the log path has already written
    // from a newer slot than this walk's snapshot: the V2 index runs behind
    // the chain, so without this a sweep would undo the live path's work.
    const pools = poolsSeen.filter(({ pubkey }) => !this.behindLogPath(pubkey, slot));
    await this.prisma.$transaction(
      pools
        .map(({ pubkey, account }) => {
          const row = poolRow(pubkey, account, slot);
          return this.prisma.pool.upsert({
            where: { address: row.address },
            create: row,
            update: row,
          });
        }),
    );
    for (const { pubkey, account } of pools) {
      await this.mirrorLiveYield(poolRow(pubkey, account, slot), account);
    }

    // The proposal exists only while open, so a full walk that does not see it
    // deletes the row, like the Position delete below; an incremental walk
    // cannot tell absent from unchanged and only upserts.
    const proposalAddress = this.chain.venueProposalAddress();
    if (!this.behindLogPath(proposalAddress, slot)) {
      const proposal = accounts
        .get<DecodedVenueProposal>(ACCOUNT.venueProposal)
        .find(({ pubkey }) => pubkey.equals(proposalAddress));
      if (proposal) {
        const row = venueProposalRow(proposal.account, poolAddress, slot);
        await this.prisma.venueProposal.upsert({ where: { poolAddress }, create: row, update: row });
      } else if (fullWalk) {
        await this.prisma.venueProposal.deleteMany({ where: { poolAddress } });
      }
    }

    const epochs = accounts.get<DecodedEpoch>(ACCOUNT.epoch);
    await this.prisma.$transaction(
      epochs
        .filter(
          ({ pubkey, account }) =>
            pubkey.equals(this.chain.epochAddress(BigInt(account.epochId.toString()), pool)) &&
            !this.behindLogPath(pubkey, slot),
        )
        .map(({ account }) => {
          const row = epochRow(account, poolAddress);
          return this.prisma.epoch.upsert({
            where: { poolAddress_id: { poolAddress, id: row.id } },
            create: row,
            update: row,
          });
        }),
    );

    const rounds = accounts.get<DecodedRound>(ACCOUNT.round).filter(({ pubkey, account }) =>
      pubkey.equals(this.chain.roundAddress(BigInt(account.roundId.toString()), pool)),
    );
    // Filtered at the write, not above: `roundIds` below needs every round
    // this walk saw, whether or not its row is the one being written.
    await this.prisma.$transaction(
      rounds
        .filter(({ pubkey }) => !this.behindLogPath(pubkey, slot))
        .map(({ account }) => {
          const row = roundRow(account, poolAddress);
          return this.prisma.round.upsert({
            where: { poolAddress_id: { poolAddress, id: row.id } },
            create: row,
            update: row,
          });
        }),
    );
    // A full walk sees when a Round account is gone (`close_round` reclaimed
    // its rent); an incremental walk cannot, the same reason it cannot see a
    // gone Position (absence looks identical to unchanged). Marked closed and
    // kept, not deleted, matching ops-and-envs ticket 08 and the `closed`
    // column's own docs: the row keeps its last mirrored state. This is the
    // backstop for a missed `RoundClosed` event, same as the Position delete
    // below is the backstop for a missed `PositionSettled` (ticket 06).
    if (fullWalk) {
      const liveRoundIds = rounds.map(({ account }) => BigInt(account.roundId.toString()));
      // Scoped to the Active pool: a retired pool's rounds are absent from
      // this walk too, but they are not this walk's to mark (ADR 0016).
      const stillOpen = await this.prisma.round.findMany({
        where: { poolAddress, id: { notIn: liveRoundIds }, closed: false },
        select: { id: true },
      });
      // The same `behindLogPath` guard as the upsert above, keyed by the
      // round's own address rather than the id Postgres keys it by: a round
      // just opened after this walk's stale snapshot (the V2 index runs 13
      // to 24 seconds behind, see `fetchAll`) is not in `liveRoundIds` either,
      // and must not be marked closed for that reason alone.
      const toClose = stillOpen
        .map((round) => round.id)
        .filter((id) => !this.behindLogPath(this.chain.roundAddress(id, pool), slot));
      if (toClose.length > 0) {
        await this.prisma.round.updateMany({
          where: { poolAddress, id: { in: toClose } },
          data: { closed: true },
        });
      }
    }

    const players = accounts.get<DecodedPlayer>(ACCOUNT.player);
    await this.prisma.$transaction(
      players
        .filter(
          ({ pubkey, account }) =>
            pubkey.equals(this.chain.playerAddress(account.owner, pool)) &&
            !this.behindLogPath(pubkey, slot),
        )
        .map(({ account }) => {
          const row = playerRow(account, poolAddress);
          return this.prisma.player.upsert({
            where: { poolAddress_owner: { poolAddress, owner: row.owner } },
            create: row,
            update: row,
          });
        }),
    );

    // beta-launch-fixes ticket 08: a websocket gap can miss a
    // WithdrawRequested/YieldCredited/JackpotPaid event for a referee, which
    // overstates (or understates) the Referral row's own tracked Principal
    // (see referral.ts's own docs on why that is tracked independently of
    // Player). A full walk sees every Player fresh, so each one reconciles
    // every Referral's principal and aboveSince against the mirrored Player,
    // the same crossing logic `applyReferralEvent` applies to a live event
    // (a `Deposited` carries the absolute new Principal, which is exactly
    // what reconciling against a snapshot needs). An incremental walk only
    // reports changed accounts, so this is skipped there rather than
    // reconciling every Referral against a mix of fresh and stale Player
    // rows.
    if (fullWalk) {
      const referrals = await this.prisma.referral.findMany({
        select: { referee: true, principal: true, aboveSince: true },
      });
      if (referrals.length > 0) {
        // Active pool only: a referee with no Player here yet keeps the
        // Principal their last event left (spec's "Referral job" decision).
        const referralPlayers = await this.prisma.player.findMany({
          where: { poolAddress, owner: { in: referrals.map((referral) => referral.referee) } },
          select: { owner: true, principal: true },
        });
        const principalByOwner = new Map(
          referralPlayers.map((player) => [player.owner, player.principal]),
        );
        const now = nowSeconds();
        const drifted = referrals.flatMap((referral) => {
          const actual = principalByOwner.get(referral.referee);
          if (actual === undefined || actual === referral.principal) return [];
          const next = applyReferralEvent(
            { principal: referral.principal, aboveSince: referral.aboveSince },
            { kind: "Deposited", principal: actual },
            now,
          );
          return [{ referee: referral.referee, ...next }];
        });
        if (drifted.length > 0) {
          await this.prisma.$transaction(
            drifted.map((update) =>
              this.prisma.referral.update({
                where: { referee: update.referee },
                data: { principal: update.principal, aboveSince: update.aboveSince },
              }),
            ),
          );
        }
      }
    }

    // Position stores its round's address, not its id, so the ids come from
    // the rounds decoded a moment ago. Rounds are never closed, so a position
    // of this pool always finds its round here.
    const roundIds = new Map(
      rounds.map(({ pubkey, account }) => [pubkey.toBase58(), BigInt(account.roundId.toString())]),
    );
    const positions = accounts.get<DecodedPosition>(ACCOUNT.position).flatMap(
      ({ pubkey, account }) => {
        const roundId = roundIds.get(account.round.toBase58());
        if (roundId === undefined) return [];
        if (!pubkey.equals(this.chain.positionAddress(account.round, account.owner))) return [];
        return [positionRow(pubkey, account, roundId, poolAddress)];
      },
    );
    const live = positions.map((row) => row.address);
    await this.prisma.$transaction([
      ...positions
        .filter((row) => !this.behindLogPath(new PublicKey(row.address), slot))
        .map((row) =>
          this.prisma.position.upsert({
            where: { address: row.address },
            create: row,
            update: row,
          }),
        ),
      // A full walk does see that a closed account is gone, so it stays a
      // second guard behind the `PositionSettled` event. An incremental walk
      // cannot: there, absence only means unchanged. A Position bought since
      // this walk's snapshot is not in `live` either, so the log path's
      // addresses are spared the same way its rows are.
      ...(fullWalk
        ? [
            // Scoped like the Round close above: absence from this pool's
            // walk says nothing about a retired pool's Positions.
            this.prisma.position.deleteMany({
              where: { poolAddress, address: { notIn: [...live, ...this.freshWrites.keys()] } },
            }),
          ]
        : []),
    ]);

    // Recorded only once every page of this walk has landed: a page failure
    // above throws before this line, so a partial walk never advances the
    // slot past pages it never read.
    if (fullWalk) this.lastFullWalkAt = Date.now();
    this.lastSyncedSlot = slot;
    // The sweep has caught up to everything written at or before its
    // snapshot, so those entries have nothing left to protect.
    for (const [address, written] of this.freshWrites) {
      if (written <= slot) this.freshWrites.delete(address);
    }
  }

  /**
   * `getProgramAccountsV2` has no typed method on web3.js's `Connection`
   * (probed 2026-09-14: available on the Free plan, not in
   * @solana/web3.js 1.98.4). Reaching into the connection's own internal
   * transport avoids opening a second `Connection`, so every call still
   * shares the one client's commitment, headers and retry behaviour; the
   * fake the tests substitute for `ChainService`'s connection implements the
   * same method, so this stays testable behind that fake.
   */
  private async programAccountsPage(
    paginationKey: string | undefined,
    changedSinceSlot: bigint | undefined,
  ): Promise<ProgramAccountsV2Response> {
    // SAFETY: `_rpcRequest` is web3.js's own private JSON-RPC transport,
    // the same one every typed `Connection` method calls internally. It is
    // absent from the public types because it is meant to stay internal.
    const connection = this.chain.connection as unknown as {
      _rpcRequest(
        method: string,
        params: unknown[],
      ): Promise<{
        result?: ProgramAccountsV2Response;
        error?: { code?: number; message: string };
      }>;
    };
    const response = await connection._rpcRequest("getProgramAccountsV2", [
      this.chain.programId.toBase58(),
      {
        encoding: "base64",
        withContext: true,
        ...(paginationKey !== undefined ? { paginationKey } : {}),
        ...(changedSinceSlot !== undefined ? { changedSinceSlot: Number(changedSinceSlot) } : {}),
      },
    ]);
    if (response.error) {
      if (isMethodNotFound(response.error)) throw new MethodNotFound();
      throw new Error(`getProgramAccountsV2 failed: ${response.error.message}`);
    }
    if (!response.result) {
      throw new Error("getProgramAccountsV2 returned no result");
    }
    return response.result;
  }

  /**
   * Every account the program owns (`changedSinceSlot` undefined), or only
   * the ones that changed since that slot, walked page by page and keyed by
   * type. `paginationKey` absent ends the walk.
   *
   * The returned slot is the first page's `context.slot`, the RPC's own
   * consistency point for this sweep, not the newest account seen: an
   * account that changes while the walk is still running is still ahead of
   * that slot, so the next sweep asks for it again instead of skipping it.
   */
  private async fetchAll(
    changedSinceSlot: bigint | undefined,
  ): Promise<{ slot: bigint; accounts: AccountsByType }> {
    const coder = this.chain.program.coder.accounts;
    let slot: bigint | undefined;
    let decoded: { pubkey: PublicKey; data: Buffer }[] = [];
    // ticket 08: give getProgramAccountsV2 another try after an hour, rather
    // than treating one "method not found" as true for the process's whole
    // life (a provider can add the extension later; see this flag's own
    // comment for the fallback-served false-positive case).
    if (
      this.v2Unsupported &&
      this.v2UnsupportedSince !== undefined &&
      Date.now() - this.v2UnsupportedSince >= V2_UNSUPPORTED_RESET_MS
    ) {
      this.v2Unsupported = false;
      this.v2UnsupportedSince = undefined;
    }
    if (!this.v2Unsupported) {
      const raw: RawProgramAccount[] = [];
      let paginationKey: string | undefined;
      // Security review ticket 14: `withRpcFallback` fails over per call,
      // with no stickiness, so a flaky primary can serve page 1 and the
      // fallback page 2 of the same walk. The two endpoints can sit at
      // different indexing lag, so the merged pages would not be one
      // consistent snapshot — exactly what the full walk's absence-based
      // Position delete and Round close (below) rely on. Pinning the whole
      // walk to whichever endpoint served its first page, and aborting (no
      // different than any other mid-walk failure: nothing has been written
      // to Postgres yet) the moment a later page comes from the other one,
      // keeps every page of one walk on one endpoint.
      let servedBy: "primary" | "fallback" | undefined;
      try {
        do {
          const page = await this.programAccountsPage(paginationKey, changedSinceSlot);
          const endpoint = rpcStatus(this.chain.connection).endpoint;
          if (servedBy === undefined) {
            servedBy = endpoint;
          } else if (endpoint !== servedBy) {
            throw new Error(
              "getProgramAccountsV2 walk failed over to a different RPC endpoint mid-walk; aborting this sweep rather than mixing two providers' snapshots",
            );
          }
          if (slot === undefined) slot = BigInt(page.context.slot);
          raw.push(...page.value.accounts);
          // Null and absent both mean "that was the last page"; see the
          // `paginationKey` note on ProgramAccountsV2Response.
          paginationKey = page.value.paginationKey ?? undefined;
        } while (paginationKey !== undefined);
      } catch (error: unknown) {
        if (!(error instanceof MethodNotFound)) throw error;
        // beta-launch-fixes ticket 08: `withRpcFallback` fails over per call
        // with no stickiness, so this one call landing on the fallback (a
        // brief primary hiccup) and getting "method not found" back does not
        // mean the primary lacks it too. Only disable the paginated walk
        // when the primary itself is the one that just answered that way.
        if (rpcStatus(this.chain.connection).endpoint === "primary") {
          this.logger.warn(
            "this RPC has no getProgramAccountsV2; every sweep walks all program accounts for the next hour",
          );
          this.v2Unsupported = true;
          this.v2UnsupportedSince = Date.now();
        } else {
          this.logger.debug(
            "getProgramAccountsV2 method-not-found came from the fallback RPC, not the primary; not disabling it",
          );
        }
        slot = undefined;
      }
      decoded = raw.map(({ pubkey, account }) => ({
        pubkey: new PublicKey(pubkey),
        data: Buffer.from(account.data[0], "base64"),
      }));
    }
    if (this.v2Unsupported) {
      // ponytail: no changedSinceSlot without V2, so a provider that lacks it
      // pays the full walk on every sweep. syncAccounts keeps absence-based
      // Position deletion in that mode, which a full walk can still see.
      const { context, value } = await this.chain.connection.getProgramAccounts(
        this.chain.programId,
        { withContext: true },
      );
      slot = BigInt(context.slot);
      decoded = value.map(({ pubkey, account }) => ({ pubkey, data: account.data }));
    }
    if (slot === undefined) {
      throw new Error("getProgramAccountsV2 returned no pages");
    }

    const byType = new Map<string, { pubkey: PublicKey; data: Buffer }[]>();
    for (const name of Object.values(ACCOUNT)) {
      // SAFETY: the interface types `memcmp` as `any`; BorshAccountsCoder
      // returns `{ offset: 0, bytes: base58(discriminator) }`.
      const memcmp = coder.memcmp(name) as { bytes: string };
      const discriminator = Buffer.from(bs58.decode(memcmp.bytes));
      byType.set(
        name,
        decoded.filter(({ data }) => data.subarray(0, discriminator.length).equals(discriminator)),
      );
    }
    return {
      slot,
      accounts: {
        // Accounts of an earlier program build (an abandoned pool from before
        // a layout change) still carry the discriminator but not the bytes;
        // they belong to no configured pool, so they are dropped silently.
        // `syncAccounts` raises when the configured pool itself is missing.
        get: <T>(name: string) =>
          (byType.get(name) ?? []).flatMap(({ pubkey, data }) => {
            try {
              return [{ pubkey, account: coder.decode<T>(name, data) }];
            } catch {
              return [];
            }
          }),
      },
    };
  }

  // --------------------------------------------------------- event ingest

  /**
   * Stores one transaction's events and advances the cursor in the same
   * database transaction, so a crash never leaves the cursor ahead of the
   * rows. The composite primary key makes a replayed batch a no-op.
   *
   * Returns the number of rows actually inserted.
   */
  async ingestLogs(batch: LogBatch): Promise<number> {
    const events = decodeEventLogs(this.parser, batch.logs);
    return this.persist(batch, events);
  }

  /**
   * `advanceCursor` (beta-launch-fixes ticket 08, default true): the live
   * websocket path (`subscribeToLogs`) passes `false`. Only the catch-up
   * poll (`ingestSignature`, driven by `catchUpEvents`) is allowed to move
   * `lastSignature`/`lastSlot`/`updatedAt`, so a gap between two live events
   * (a dropped socket, a missed notification) is always replayed: the
   * cursor never jumps ahead of a signature the catch-up walk has not
   * actually confirmed. `updatedAt` on that same row is the indexer's
   * freshness stamp (read as `cursor.ageSeconds` in api.service.ts's status
   * snapshot) — with this change it only advances when catch-up actually
   * consumed something, so a stalled backlog (a signature whose logs never
   * show up) correctly stops advancing it instead of a live event down the
   * same table masking the stall.
   */
  private persist(
    batch: LogBatch,
    events: DecodedEvent[],
    options: { advanceCursor: boolean } = { advanceCursor: true },
  ): Promise<number> {
    const poolAddress = this.activePool;
    const rows = events.map((event, index) => ({
      poolAddress,
      slot: batch.slot,
      signature: batch.signature,
      index,
      name: event.name,
      // SAFETY: an Anchor event always decodes to a struct, so `jsonify`
      // returned an object here, which is what jsonb columns take.
      data: event.data as Prisma.InputJsonObject,
      blockTime: batch.blockTime,
    }));
    // `settle_position` is what actually closes a Position account, whether
    // its Round settled or was voided, so `PositionSettled` is the one event
    // that means a row is gone; a batch settling several Positions at once
    // carries one such event per Position.
    const closed = events
      .map((event) => settledPosition(event))
      .filter((position): position is { owner: string; roundId: bigint } => position !== null);
    // ops-and-envs ticket 08: `close_round` closed these Round accounts; the
    // row keeps its last mirrored state (see `closedRound`'s own docs)
    // instead of being deleted or blanked, so this only flips one flag.
    const closedRounds = events
      .map((event) => closedRound(event))
      .filter((round): round is { id: bigint } => round !== null);
    // ticket 06: every owner this batch saw deposit, deduplicated so two
    // Deposited events for the same wallet in one batch check only once.
    const depositors = [
      ...new Set(
        events
          .filter((event) => event.name === "Deposited")
          .map((event) => eventField(event, "owner"))
          .filter((owner): owner is string => owner !== undefined),
      ),
    ];
    // ticket 07: this batch's Deposited/WithdrawRequested/YieldCredited/
    // compounded-JackpotPaid events, in order, for whichever owners turn out
    // to have a Referral row.
    const referralEvents = referralPrincipalEvents(events);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.event.createMany({ data: rows, skipDuplicates: true });
      for (const { owner, roundId } of closed) {
        await tx.position.deleteMany({ where: { poolAddress, owner, roundId } });
      }
      for (const { id } of closedRounds) {
        // updateMany, not update: a row this transaction has not seen yet
        // (an out-of-order replay) is a no-op here, and the next sync or
        // sweep still upserts the Round itself.
        await tx.round.updateMany({ where: { poolAddress, id }, data: { closed: true } });
      }
      for (const owner of depositors) {
        // ADR 0014: a wallet's first deposit gets it a ReferralCode, not a
        // depositor-owned InviteCode; InviteCode.ownerWallet is now
        // Admin-only. "First" means first ever, across pools: the check is
        // on ReferralCode itself, which is wallet-level, so a depositor from
        // a retired pool keeps the code they have and never trips the
        // unique owner index on their first deposit into a new one (ADR 0016).
        await ensureReferralCode(tx, owner);
      }
      if (referralEvents.length > 0 && created.count > 0) {
        // `created.count === 0` means every row in this batch already
        // existed (a replayed signature: a websocket reconnect or a
        // catch-up overlap, see "stores each event once" above). Unlike the
        // position-delete and invite-code create above, applying a delta
        // twice is not naturally idempotent, so a replay must skip this
        // block entirely rather than double-count the same Principal change.
        //
        // Seeded once from the DB and replayed in memory for the rest of
        // this batch, so a referee with two Principal-changing events in one
        // batch (a dip and a restore) chains off the first event's own
        // result instead of the row `findMany` read before either applied.
        const referees = [...new Set(referralEvents.map(({ owner }) => owner))];
        const existing = await tx.referral.findMany({ where: { referee: { in: referees } } });
        const state = new Map<string, ReferralQualificationState>(
          existing.map((row) => [row.referee, { principal: row.principal, aboveSince: row.aboveSince }]),
        );
        const blockTime = batch.blockTime ?? nowSeconds();
        for (const { owner, event } of referralEvents) {
          const current = state.get(owner);
          if (current === undefined) continue; // not a referee
          state.set(owner, applyReferralEvent(current, event, blockTime));
        }
        for (const [referee, next] of state) {
          await tx.referral.update({
            where: { referee },
            data: { principal: next.principal, aboveSince: next.aboveSince },
          });
        }
      }
      if (options.advanceCursor) {
        const cursor = await tx.cursor.findUnique({ where: { poolAddress } });
        // Only the catch-up poll walks backwards, and it must not drag the
        // resume point back with it.
        const reached = cursor?.lastSlot ?? null;
        if (reached === null || reached <= batch.slot) {
          const at = { lastSignature: batch.signature, lastSlot: batch.slot, updatedAt: nowSeconds() };
          await tx.cursor.upsert({
            where: { poolAddress },
            create: { poolAddress, ...at },
            update: at,
          });
        }
      }
      return created.count;
    });
  }

  /**
   * Replays every finalized signature the cursor has not seen. Runs on the
   * sweep, not only at boot: it is what actually guarantees no event is lost
   * when the websocket is down, and it costs one RPC call when nothing moved.
   *
   * Pages backwards with `before` rather than bounding one call with `until`:
   * `until` combined with `limit` only ever returns the newest `limit`
   * signatures, so a backlog longer than one page silently dropped whatever
   * sat between that page and the cursor (ticket 06). Paging keeps asking
   * for the next page back until either the cursor's own signature turns up
   * in one (the backlog ends there, exclusive) or a page comes back shorter
   * than a full page, meaning there is nothing older left. A fresh cursor
   * (first boot) walks all the way back to that address's first signature,
   * which only happens once.
   */
  private async catchUpEvents(): Promise<void> {
    // A new pool has no Cursor row, so this walks its whole history rather
    // than hunting for a retired pool's last signature (ADR 0016).
    const cursor = await this.prisma.cursor.findUnique({ where: { poolAddress: this.activePool } });
    const backlog: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.chain.connection.getSignaturesForAddress(
        this.chain.poolAddress(),
        { ...(before !== undefined ? { before } : {}), limit: SIGNATURE_PAGE },
        "finalized",
      );
      const reached = cursor?.lastSignature
        ? page.findIndex((info) => info.signature === cursor.lastSignature)
        : -1;
      backlog.push(...(reached === -1 ? page : page.slice(0, reached)));
      if (reached !== -1 || page.length < SIGNATURE_PAGE) break;
      // SAFETY: this branch only runs when `page.length >= SIGNATURE_PAGE`,
      // so the page has at least one entry.
      before = page[page.length - 1]!.signature;
    }

    // Newest first from the RPC, across however many pages that took; replay
    // oldest first so the cursor only moves forward. The whole backlog is one
    // `enqueue` call, not one per signature: `enqueue` is a plain FIFO, so a
    // live event arriving mid-page used to be able to schedule itself between
    // two still-unprocessed backlog signatures (ticket 13's security review)
    // once this signature's own `getTransaction` await returned control to
    // the event loop. A referee whose Principal-changing events span both
    // sides of that gap would then have them applied out of chronological
    // order, which is not idempotent to reordering the way the
    // position/invite-code side effects in `persist()` are (see
    // `applyReferralEvent`). Wrapping the loop keeps this whole backlog as
    // one queue slot, so nothing enqueued afterwards can land inside it.
    await this.enqueue(async () => {
      for (const info of [...backlog].reverse()) {
        const consumed = await this.ingestSignature(info);
        if (!consumed) return;
      }
    });
  }

  /**
   * False when the transaction's logs could not be read. The cursor then stays
   * put and the rest of the page waits for the next tick, because skipping it
   * would drop its events for good.
   */
  private async ingestSignature(info: ConfirmedSignatureInfo): Promise<boolean> {
    const batch: LogBatch = {
      signature: info.signature,
      slot: BigInt(info.slot),
      blockTime:
        info.blockTime === null || info.blockTime === undefined ? null : BigInt(info.blockTime),
      logs: [],
    };
    // A failed transaction committed nothing, so it has no events. The cursor
    // still moves past it, otherwise every tick re-lists it forever.
    if (info.err) {
      await this.persist(batch, []);
      return true;
    }
    const tx = await this.chain.connection.getTransaction(info.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages;
    if (!logs) {
      this.noteFailure(`no finalized logs yet for ${info.signature}`);
      return false;
    }
    await this.persist({ ...batch, logs }, decodeEventLogs(this.parser, logs));
    return true;
  }

  /**
   * `onLogs` carries no block time, and a finalized log arrives within a
   * second or two of finalization, so this timestamps the event from chain
   * time as the backend last observed it (ticket 04) instead of paying a
   * `getBlockTime` call per event. Never wall time: a local validator's chain
   * clock runs faster than it. `undefined` (nothing has read the clock yet)
   * stores as null, same as a backfilled transaction with no block time.
   *
   * beta-launch-fixes ticket 08: never advances the cursor. A websocket gap
   * between two live events used to be permanently unreplayable, because the
   * cursor had already jumped to whichever signature happened to arrive
   * after the gap; the next catch-up walk saw its own cursor already past
   * the missed signature and never went looking for it. Only `ingestSignature`
   * (the catch-up poll, via `catchUpEvents`) advances it now.
   */
  private subscribeToLogs(): void {
    this.subscriptionId = this.chain.connection.onLogs(
      this.chain.poolAddress(),
      (logs, context) => {
        if (logs.err) return;
        void this.enqueue(async () => {
          // Before the first sweep lands there may be no Pool row for the
          // Event's foreign key (a fresh pool, ADR 0016). Dropping the event
          // loses nothing: this path never moves the cursor, so catch-up
          // replays it once the sweep has written the Pool.
          if (this.lastSyncedSlot === undefined) return;
          const events = decodeEventLogs(this.parser, logs.logs);
          if (events.length === 0) return;
          await this.persist(
            {
              signature: logs.signature,
              slot: BigInt(context.slot),
              blockTime: this.chain.lastObservedChainTime() ?? null,
              logs: logs.logs,
            },
            events,
            { advanceCursor: false },
          );
        }).catch((error: unknown) => this.noteFailure("live log ingest failed", error));
      },
      "finalized",
    );
  }

  /**
   * web3.js owns the websocket: rpc-websockets reconnects it with its own
   * backoff and web3.js re-sends every subscription when it reopens, so a
   * second reconnect loop here would fight it. What is missing is visibility,
   * so the state transitions get logged once each.
   */
  private watchSocket(): void {
    // SAFETY: `_rpcWebSocket` is the rpc-websockets client the Connection
    // builds in its constructor. It is not in the public types, so a version
    // that drops it falls through to the warning instead of throwing. Nothing
    // here mutates it.
    const socket = (this.chain.connection as unknown as { _rpcWebSocket?: SocketLike })
      ._rpcWebSocket;
    if (typeof socket?.on !== "function") {
      this.logger.warn("no websocket handle on the connection; socket state is not logged");
      return;
    }
    socket.on("open", () => this.noteSocketState("connected"));
    socket.on("close", () => this.noteSocketState("disconnected, web3.js is reconnecting"));
    socket.on("error", () => this.noteSocketState("errored, web3.js is reconnecting"));
  }

  private noteSocketState(state: string): void {
    if (state === this.socketState) return;
    this.socketState = state;
    this.logger.log(`rpc websocket ${state}`);
  }

  /** Keeps one writer: the socket callback never interleaves with the poll. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** A failing RPC repeats on every sync; log the change, not the repetition. */
  private noteFailure(scope: string, error?: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const line = error === undefined ? scope : `${scope}: ${message}`;
    if (line === this.lastFailure) return;
    this.lastFailure = line;
    this.logger.error(line, error instanceof Error ? error.stack : undefined);
  }

  private noteRecovery(): void {
    if (this.lastFailure === undefined) return;
    this.lastFailure = undefined;
    this.logger.log("indexer recovered");
  }
}
