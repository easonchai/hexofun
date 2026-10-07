// The crank (spec §3.4). This file is plumbing only: read the chain, hand
// `runTick` everything it needs, write down what happened, then sleep until
// the deadline it returned instead of ticking on a fixed interval (ticket 03).
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import { fetchKvaultView } from "../chain/kvault";
import { VENUE_KIND } from "../chain/venue-kind";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  decodeRound,
  ROUND_STATUS,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { INDEXER_QUERIES, type IndexerQueries } from "./indexer-queries";
import { OperatorInstructions } from "./instructions";
import { SparringService } from "./sparring";
import {
  EXPECTED_ERRORS,
  msUntilWake,
  runTick,
  SAFETY_INTERVAL_SECONDS,
  type TickContext,
  type TickOutcome,
  type WithdrawState,
} from "./tick";
import type { VenueState } from "./venue";
import { isFulfilled, randomnessAddress } from "./vrf";
import { leafHoldingTarget, readNodes } from "./weight-tree";

/** How long a settled Position's address is remembered; well past any sweep lag. */
const SETTLED_MEMORY_MS = 5 * 60_000;
/** How many drawn epochs' winners are remembered; one is ever needed at a
 *  time, the rest only cover a payout retried after the epoch has moved on. */
const WINNER_MEMORY = 4;
/** The slow safety net alongside the deadline-driven sleep (ticket 03): runs
 *  regardless, so a mis-computed deadline degrades to "checked on this
 *  cadence" rather than a stall. Same cadence `nextWakeAt` falls back to. */
const SAFETY_INTERVAL_MS = Number(SAFETY_INTERVAL_SECONDS) * 1000;

/** `runTick`'s outcome plus the wall-clock ms until the scheduler should look
 *  again: the chain-time deadline converted once, here, so both the DB write
 *  and the self-rescheduling timer agree on the same number. */
interface OperatorTickResult extends TickOutcome {
  readonly waitMs: number;
}

@Injectable()
export class OperatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperatorService.name);
  private readonly instructions: OperatorInstructions;
  private readonly testVrf: boolean;
  private readonly lookupTables = new Map<string, AddressLookupTableAccount>();
  /** Single-flight: an overrunning tick skips the one that would overlap it. */
  private running = false;
  /** The in-flight tick, if any (ticket 10): `onModuleDestroy` awaits this
   *  so a restart does not cut a send in half. */
  private currentTick: Promise<OperatorTickResult> | null = null;
  /** The self-rescheduling deadline sleep; cleared and replaced on every
   *  tick, on `wake()`, and on shutdown. */
  private deadlineTimer: NodeJS.Timeout | null = null;
  /**
   * Positions this operator has already settled, by address, with when. The
   * indexer's sweep can re-insert one for a few seconds after the close: the
   * sync fired by the settle's own log can snapshot the chain before the
   * close is visible. A closed Position never comes back, so remembering the
   * address is always safe; the timestamp only bounds the map.
   */
  private settled = new Map<string, number>();
  /** Same idea as `settled`, for Rounds `close_round` was just sent for
   *  (ops-and-envs ticket 08): keeps an immediate next tick from resending
   *  it before the indexer's `RoundClosed` mirror lands. */
  private closingRounds = new Map<bigint, number>();
  /** Epoch id to the owner whose leaf held its target. A target never moves
   *  once drawn, so a retried payout does not re-read the whole tree. */
  private winners = new Map<bigint, string>();
  /** Ticket 06: withdrawal-cranking state across ticks (see `WithdrawState`). */
  private lastWithdrawState: WithdrawState | null = null;
  /** Ticket 12: expected-error repeat counts across ticks, by `action:target`. */
  private lastExpectedErrors = new Map<string, number>();
  /** Ticket 13: what the venue cranks remember across ticks (see `VenueState`). */
  private lastVenueState: VenueState | null = null;
  /** Ticket 21: the epoch whose skipped round was last logged. */
  private lastRoundSkipEpochId: bigint | null = null;
  /** Ticket 05: holds step 3's very first `begin_epoch` back until this chain
   *  timestamp; null when `LAUNCH_AT` is unset. */
  private readonly launchAt: bigint | null;
  /** Logged once, the first tick that sees the pool shut down, so the
   *  epoch and round loops stopping is announced instead of just
   *  going quiet (ops-and-envs ticket 08). Shutdown is irreversible, so
   *  this never needs to reset. */
  private shutdownAnnounced = false;
  /**
   * The Round randomness address currently watched via subscription, and its
   * websocket subscription id (ticket 04): kept in sync with `openRound` on
   * every tick, not only the one that sent `request_round_randomness`, so a
   * restart mid-wait re-subscribes instead of falling back to polling. The
   * subscription only shortens the wait by calling `wake()`; `decide()`'s own
   * `fulfilled` check inside a tick stays the one authoritative read.
   */
  private randomnessWatch: { address: string; subscriptionId: number } | undefined;

  constructor(
    private readonly chain: ChainService,
    private readonly prisma: PrismaService,
    @Inject(INDEXER_QUERIES) private readonly indexer: IndexerQueries,
    private readonly sparring: SparringService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    const launchAtIso = config.get("LAUNCH_AT", { infer: true });
    this.launchAt =
      typeof launchAtIso === "string" && launchAtIso.length > 0
        ? BigInt(Math.floor(Date.parse(launchAtIso) / 1000))
        : null;
    // Which randomness account the program expects depends on how it was
    // compiled, and the IDL is the only thing that travels with the build.
    this.testVrf = chain.program.idl.instructions.some(
      (ix) => ix.name === "testFulfill",
    );
    if (this.testVrf) {
      this.logger.warn(
        "program is a test-vrf build: randomness is fabricated, not ORAO's",
      );
    }

    this.instructions = new OperatorInstructions(
      chain.program,
      chain.programId,
      chain.keypair.publicKey,
      this.testVrf,
    );
  }

  onModuleInit(): void {
    this.runAndScheduleNext().catch((cause) =>
      this.logger.error("scheduling failed", cause as Error),
    );
  }

  /** Ticket 10: awaits the in-flight tick, so a deploy or restart does not
   *  cut a send in half. Nest only calls this when `enableShutdownHooks()`
   *  has been called (main.ts). */
  async onModuleDestroy(): Promise<void> {
    this.clearDeadlineTimer();
    if (this.currentTick) {
      await this.currentTick.catch(() => {
        // runOnce() never rejects (see tick()'s comment); this is just in
        // case a future change makes it, so shutdown still proceeds.
      });
    }
    if (this.randomnessWatch) {
      await this.chain.connection.removeAccountChangeListener(
        this.randomnessWatch.subscriptionId,
      );
      this.randomnessWatch = undefined;
    }
  }

  /** The slow net (spec.md "Operator becomes deadline-driven"): runs on its
   *  own cadence regardless of the deadline timer, so a mis-computed deadline
   *  degrades to a delay rather than a stall. */
  @Interval(SAFETY_INTERVAL_MS)
  async safetyTick(): Promise<void> {
    try {
      await this.runAndScheduleNext();
    } catch (cause) {
      this.logger.error("safety tick failed", cause as Error);
    }
  }

  /** For a subscription (ticket 04) to call once it notices something the
   *  last computed deadline did not account for: cancels the pending sleep
   *  and looks now instead of waiting for it. */
  wake(): void {
    this.clearDeadlineTimer();
    this.runAndScheduleNext().catch((cause) =>
      this.logger.error("scheduling failed", cause as Error),
    );
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** Runs one tick, then sleeps until its returned deadline. Every entry
   *  point (boot, the safety tick, `wake()`) funnels through here so only one
   *  sleep is ever pending. */
  private async runAndScheduleNext(): Promise<void> {
    this.clearDeadlineTimer();
    const result = await this.tick();
    // null: another caller already owns `running` and will reschedule once
    // it finishes, so scheduling here too would double the pending sleep.
    if (result === null) return;
    this.deadlineTimer = setTimeout(() => {
      this.runAndScheduleNext().catch((cause) =>
        this.logger.error("scheduling failed", cause as Error),
      );
    }, result.waitMs);
  }

  /** Single-flight: an overrunning tick is skipped rather than queued behind
   *  itself. Exposed for the localnet test, which drives it directly. */
  async tick(): Promise<OperatorTickResult | null> {
    if (this.running) return null;
    this.running = true;
    const inFlight = this.runOnce();
    this.currentTick = inFlight;
    try {
      return await inFlight;
    } finally {
      this.running = false;
      if (this.currentTick === inFlight) this.currentTick = null;
    }
  }

  /** One pass of spec §3.4. Never throws: a failed tick is state, not a crash. */
  async runOnce(): Promise<OperatorTickResult> {
    let ctx: TickContext | undefined;
    try {
      ctx = await this.context();
      if (ctx.pool.shutdown && !this.shutdownAnnounced) {
        this.shutdownAnnounced = true;
        this.logger.log(
          "pool is shut down: the epoch and new-round loops have stopped; " +
            "settling already-open rounds, paying an already-drawn epoch and processing withdrawals continue",
        );
      }
      const outcome = await runTick(ctx);
      this.syncRandomnessWatch(ctx.openRound);
      if (outcome.withdrawState) this.lastWithdrawState = outcome.withdrawState;
      if (outcome.venueState) this.lastVenueState = outcome.venueState;
      if (outcome.expectedErrors) this.lastExpectedErrors = new Map(outcome.expectedErrors);
      if (outcome.roundSkip) {
        this.lastRoundSkipEpochId = outcome.roundSkip.epochId;
        this.logger.log(
          `not opening a round: it would end after epoch ${outcome.roundSkip.epochId} ends at ${outcome.roundSkip.endsAt}`,
        );
      }
      if (outcome.action) this.logger.log(`sent ${outcome.action}`);
      if (outcome.stepError) this.logger.warn(`tick step failed: ${outcome.stepError}`);
      // A new Round exists on chain now; the Sparring player buys in without
      // waiting for its own (much slower) safety tick to notice.
      if (outcome.action === "create_round") this.sparring.wake();
      const waitMs = msUntilWake(ctx.now, outcome.nextWakeAt);
      await this.writeState(outcome, outcome.stepError ?? null, waitMs);
      return { ...outcome, waitMs };
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error(String(cause), { cause });
      // A failed read never produced a deadline to convert; back off by the
      // safety interval rather than retrying immediately.
      const waitMs = SAFETY_INTERVAL_MS;
      const nextWakeAt = (ctx?.now ?? 0n) + SAFETY_INTERVAL_SECONDS;
      if (EXPECTED_ERRORS.has(error.message)) {
        // Lost a race with someone else's transaction (or our own, confirmed
        // after we read). The next tick reads the newer state and moves on.
        this.logger.debug(`skipped: ${error.message}`);
        await this.safeWriteState({ action: null }, null, waitMs);
        return { action: null, nextWakeAt, waitMs };
      }
      // Anchor and web3 hang the program logs off the cause; they name the
      // instruction and the account that failed, which the message does not.
      const logs = (error.cause as { logs?: string[] } | undefined)?.logs;
      this.logger.error(
        `tick failed: ${error.message}${logs ? `\n${logs.join("\n")}` : ""}`,
        error.stack,
      );
      await this.safeWriteState({ action: null }, error.message, waitMs);
      return { action: null, nextWakeAt, waitMs };
    }
  }

  /**
   * `writeState` wrapped so a Postgres blip on the catch path (a failing
   * tick, of all times) cannot reject out of `runOnce` and crash the process
   * (ticket 10). The success path's own `writeState` call is left as is:
   * failing to record a *successful* tick's outcome is a real bug worth
   * surfacing, not something to swallow silently.
   */
  private async safeWriteState(
    outcome: Pick<TickOutcome, "action" | "withdrawShortfall">,
    error: string | null,
    waitMs: number,
  ): Promise<void> {
    try {
      await this.writeState(outcome, error, waitMs);
    } catch (cause) {
      this.logger.error("failed to record tick state", cause as Error);
    }
  }

  private async context(): Promise<TickContext> {
    const poolAddress = this.chain.poolAddress();
    const [poolInfo, clockInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        poolAddress,
        SYSVAR_CLOCK_PUBKEY,
      ]);
    if (!poolInfo) {
      throw new Error(
        `pool ${poolAddress.toBase58()} does not exist; run bootstrap first`,
      );
    }
    const decoded = decodePool(this.chain.program, poolAddress, poolInfo.data);
    // A kVault pool's accounts come from the vault state, read fresh every
    // tick because the curator can change the allocation list, and its
    // transactions need the vault's lookup table (venue-switch ticket 06).
    const tables: AddressLookupTableAccount[] = [];
    let pool = decoded;
    if (decoded.venueKind === VENUE_KIND.kvault) {
      const kvault = await fetchKvaultView(
        this.chain.connection,
        decoded.klendMarket,
        decoded.klendProgram,
      );
      pool = { ...decoded, kvault };
      tables.push(await this.lookupTable(kvault.lookupTable));
    }
    const now = clockUnixTimestamp(clockInfo?.data);
    this.chain.recordChainTime(now);

    const { currentEpoch, previousEpoch, openRound, lastRound } =
      await this.readCycle(pool);

    return {
      now,
      pool,
      currentEpoch,
      previousEpoch,
      openRound,
      lastRound,
      ix: this.instructions,
      lastWithdrawState: this.lastWithdrawState,
      lastVenueState: this.lastVenueState,
      lastExpectedErrors: this.lastExpectedErrors,
      lastRoundSkipEpochId: this.lastRoundSkipEpochId,
      launchAt: this.launchAt,
      fulfilled: (seed) => this.fulfilled(seed),
      principalVaultBalance: () => this.principalVaultBalance(),
      duePendingWithdrawals: (currentEpochId) =>
        this.duePendingWithdrawals(currentEpochId),
      referralGrantsDue: (epochId) => this.indexer.referralGrantsDue(epochId),
      markReferralGrantsSent: (epochId, referrers, txSig) =>
        this.indexer.markReferralGrantsSent(epochId, referrers, txSig),
      unsettledPositions: async () =>
        (await this.indexer.unsettledPositions()).filter(
          (position) => !this.settled.has(position.address),
        ),
      forgetPositions: async (addresses) => {
        const now = Date.now();
        for (const [address, at] of this.settled) {
          if (now - at > SETTLED_MEMORY_MS) this.settled.delete(address);
        }
        for (const address of addresses) this.settled.set(address, now);
      },
      roundsToClose: async () =>
        (await this.indexer.roundsToClose()).filter((id) => !this.closingRounds.has(id)),
      forgetRound: (id) => {
        const now = Date.now();
        for (const [closedId, at] of this.closingRounds) {
          if (now - at > SETTLED_MEMORY_MS) this.closingRounds.delete(closedId);
        }
        this.closingRounds.set(id, now);
      },
      winner: (epoch) => this.winner(pool, epoch),
      send: (instructions) =>
        tables.length === 0
          ? this.chain.send(instructions)
          : this.chain.send(instructions, undefined, tables),
      warn: (message) => this.logger.warn(message),
    };
  }

  /** The vault's lookup table changes rarely; one read per process. */
  private async lookupTable(key: PublicKey): Promise<AddressLookupTableAccount> {
    const cached = this.lookupTables.get(key.toBase58());
    if (cached) return cached;
    const { value } = await this.chain.connection.getAddressLookupTable(key);
    if (!value) throw new Error(`lookup table ${key.toBase58()} does not exist`);
    this.lookupTables.set(key.toBase58(), value);
    return value;
  }

  /** Current epoch, previous epoch, open round and last round in one
   *  `getMultipleAccounts`. */
  private async readCycle(pool: PoolState): Promise<{
    currentEpoch: EpochState | null;
    previousEpoch: EpochState | null;
    openRound: RoundState | null;
    lastRound: RoundState | null;
  }> {
    const wanted: PublicKey[] = [];
    const currentIndex =
      pool.currentEpochId > 0n
        ? wanted.push(this.chain.epochAddress(pool.currentEpochId)) - 1
        : -1;
    const previousIndex =
      pool.currentEpochId > 1n
        ? wanted.push(this.chain.epochAddress(pool.currentEpochId - 1n)) - 1
        : -1;
    const roundIndex =
      pool.openRoundId > 0n
        ? wanted.push(this.chain.roundAddress(pool.openRoundId)) - 1
        : -1;
    // `nextRoundId - 1` is the most recently created Round, open or already
    // terminal; equal to `openRoundId` while one is open. Round ids start at
    // 1, so `nextRoundId <= 1` means none has ever been created.
    const lastRoundIndex =
      pool.nextRoundId > 1n
        ? wanted.push(this.chain.roundAddress(pool.nextRoundId - 1n)) - 1
        : -1;
    if (wanted.length === 0) {
      return {
        currentEpoch: null,
        previousEpoch: null,
        openRound: null,
        lastRound: null,
      };
    }

    const infos = await this.chain.connection.getMultipleAccountsInfo(wanted);
    const epochAt = (index: number): EpochState | null => {
      const data = index >= 0 ? infos[index]?.data : undefined;
      return data ? decodeEpoch(this.chain.program, data) : null;
    };
    const roundAt = (index: number): RoundState | null => {
      const data = index >= 0 ? infos[index]?.data : undefined;
      return data ? decodeRound(this.chain.program, data) : null;
    };

    return {
      currentEpoch: epochAt(currentIndex),
      previousEpoch: epochAt(previousIndex),
      openRound: roundAt(roundIndex),
      lastRound: roundAt(lastRoundIndex),
    };
  }

  private async fulfilled(seed: Uint8Array): Promise<boolean> {
    const address = randomnessAddress(this.chain.programId, seed, this.testVrf);
    const info = await this.chain.connection.getAccountInfo(address);
    return isFulfilled(info?.data);
  }

  /**
   * Ticket 04: watches the Requested Round's randomness address so a
   * fulfilment wakes the operator immediately, instead of waiting for
   * `nextWakeAt`'s `vrfTimeout` fallback. Idempotent (a repeat call for the
   * same Round is a no-op) and self-correcting: called after every tick with
   * the freshly-read `openRound`, so it starts watching a Round found already
   * Requested at boot, and stops watching one that just settled or voided.
   * A subscription that drops is re-established by web3.js itself (it owns
   * the websocket and resubscribes on reconnect); a fulfilment that arrives
   * in that gap is still caught by the safety tick's own `fulfilled` check.
   */
  private syncRandomnessWatch(openRound: RoundState | null): void {
    const wanted =
      openRound?.status === ROUND_STATUS.REQUESTED
        ? randomnessAddress(this.chain.programId, openRound.vrfSeed, this.testVrf).toBase58()
        : undefined;
    if (wanted === this.randomnessWatch?.address) return;
    if (this.randomnessWatch) {
      void this.chain.connection.removeAccountChangeListener(
        this.randomnessWatch.subscriptionId,
      );
      this.randomnessWatch = undefined;
    }
    if (wanted === undefined) return;
    const subscriptionId = this.chain.connection.onAccountChange(
      new PublicKey(wanted),
      (info) => {
        if (isFulfilled(info.data)) this.wake();
      },
      "confirmed",
    );
    this.randomnessWatch = { address: wanted, subscriptionId };
  }

  private async principalVaultBalance(): Promise<bigint> {
    const address = this.chain.principalVaultAddress();
    try {
      return (await getAccount(this.chain.connection, address)).amount;
    } catch (cause) {
      if (cause instanceof TokenAccountNotFoundError) {
        throw new Error(
          `principal vault ${address.toBase58()} does not exist; run bootstrap first`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /** Step 6b's queue, straight off the Player mirror. Oldest request first,
   *  so a batch that only covers part of the queue still drains it in order. */
  private async duePendingWithdrawals(
    currentEpochId: bigint,
  ): Promise<{ owner: string; amount: bigint }[]> {
    const players = await this.prisma.player.findMany({
      where: {
        poolAddress: this.chain.poolAddress().toBase58(),
        pendingWithdraw: { gt: 0 },
        pendingEpoch: { lt: currentEpochId },
      },
      orderBy: { pendingEpoch: "asc" },
      select: { owner: true, pendingWithdraw: true },
    });
    return players.map((player) => ({
      owner: player.owner,
      amount: player.pendingWithdraw,
    }));
  }

  /**
   * The owner of the leaf that holds the drawn epoch's target (spec §3.4 step
   * 6, ADR 0018). The target indexes into the epoch's Weight, so the answer
   * comes from the Weight tree: find the leaf, then the Player account that
   * was assigned it. No Read model table holds this, so a mirror gap cannot
   * cost a winner their Prize. Null when no leaf holds the target.
   *
   * ponytail: scans every Player account of the program once per drawn epoch
   * (fine at beta scale, same trade `ApiService.liveWeights` makes), cached
   * in `winners`. Add a `getProgramAccounts` memcmp filter on `leaf_index` if
   * it ever grows.
   */
  private async winner(pool: PoolState, epoch: EpochState): Promise<string | null> {
    const cached = this.winners.get(epoch.epochId);
    if (cached !== undefined) return cached;

    const treeInfo = await this.chain.connection.getAccountInfo(pool.weightTree);
    if (!treeInfo) throw new Error(`weight tree ${pool.weightTree.toBase58()} does not exist`);
    const leaf = leafHoldingTarget(readNodes(treeInfo.data), epoch);
    if (leaf === null) return null;

    interface DecodedPlayer {
      owner: PublicKey;
      leafIndex: number;
    }
    // SAFETY: `program.account` is keyed by plain strings in `Program<Idl>`
    // (no generated per-account types), same reason `instructions.ts`'s
    // `method()` casts; the shape is checked structurally by `DecodedPlayer`.
    const accountNamespace = this.chain.program.account as unknown as Record<
      string,
      { all(): Promise<{ publicKey: PublicKey; account: DecodedPlayer }[]> } | undefined
    >;
    const playerAccounts = accountNamespace.player;
    if (!playerAccounts) throw new Error("player account namespace is missing from the IDL");
    const hit = (await playerAccounts.all()).find(
      ({ publicKey, account }) =>
        account.leafIndex === leaf && publicKey.equals(this.chain.playerAddress(account.owner)),
    );
    if (!hit) return null;

    const owner = hit.account.owner.toBase58();
    this.winners.set(epoch.epochId, owner);
    for (const id of [...this.winners.keys()].slice(0, -WINNER_MEMORY)) this.winners.delete(id);
    return owner;
  }

  /**
   * The clock is read here, not at the start of the tick: `outcome` only
   * exists once `ctx.send` has resolved, so this timestamp reflects when the
   * transaction actually confirmed rather than when the tick began reading
   * state. A slow devnet confirmation must not read as a stall (ticket 01).
   *
   * `nextWakeAt` is written from the same wall clock, `waitMs` past it: a
   * wall-clock value alongside a wall-clock `lastTickAt`, so `GET /status`
   * and the web summary never have to reason about chain time (ticket 03).
   */
  private async writeState(
    outcome: Pick<
      TickOutcome,
      | "action"
      | "withdrawShortfall"
      | "withdrawState"
      | "epochNoProgress"
      | "drawnUnpaid"
    >,
    error: string | null,
    waitMs: number,
  ): Promise<void> {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const fields = {
      lastTickAt: nowSeconds,
      nextWakeAt: nowSeconds + BigInt(Math.round(waitMs / 1000)),
      lastError: error,
      // Ticket 09: written only on a tick that completed without error, so
      // OPERATOR_FAILING can tell "still ticking, still failing" from "just
      // recovered".
      ...(error === null ? { lastSuccessAt: nowSeconds } : {}),
      ...(outcome.action === null ? {} : { lastAction: outcome.action }),
      // Absent on a tick that acted before step 6b: nothing looked, so the
      // last reported figure is still the best one /status has.
      ...(outcome.withdrawShortfall === undefined
        ? {}
        : { withdrawShortfall: outcome.withdrawShortfall }),
      // Ticket 06: how many owners step 6b has given up on for the epoch,
      // for the new alert condition naming the count.
      ...(outcome.withdrawState === undefined
        ? {}
        : { withdrawSkippedCount: outcome.withdrawState.skipped.size }),
      // Ticket 09: present on every tick that reaches decide(), so these
      // always reflect the freshest read.
      ...(outcome.epochNoProgress === undefined ? {} : { epochNoProgress: outcome.epochNoProgress }),
      ...(outcome.drawnUnpaid === undefined ? {} : { drawnUnpaid: outcome.drawnUnpaid }),
    };
    const poolAddress = this.chain.poolAddress().toBase58();
    try {
      await this.prisma.operatorState.upsert({
        where: { poolAddress },
        create: { poolAddress, ...fields },
        update: fields,
      });
    } catch (cause) {
      // OperatorState references the Pool row (ADR 0016), and the indexer,
      // not the operator, writes that row. On a fresh database the first
      // tick can land before the indexer's first sync, and a pool that is
      // not bootstrapped has no row at all. Nothing is lost by skipping: the
      // next tick writes the whole state again. P2003 is the only foreign
      // key this upsert has, so anything else still throws.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2003") {
        this.logger.warn(
          `tick state not recorded: the indexer has not mirrored pool ${poolAddress} yet`,
        );
        return;
      }
      throw cause;
    }
  }
}
