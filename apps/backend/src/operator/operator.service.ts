// The crank (spec §3.4). This file is plumbing only: read the chain, hand
// `runTick` everything it needs, write down what happened, then sleep until
// the deadline it returned instead of ticking on a fixed interval (ticket 03).
import {
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

import { decodeReserve } from "../api/live-yield";
import { ChainService } from "../chain/chain.service";
import { fetchKvaultView, withdrawable } from "../chain/kvault";
import { VENUE_KIND } from "../chain/venue-kind";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  decodeVenueProposal,
  type EpochState,
  type PoolState,
} from "./chain-state";
import { claimNonce, readCommitment, winnerProof } from "../snapshot/epoch-draw";
import { OperatorInstructions } from "./instructions";
import { grantReferralBonuses } from "./referral-grants";
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
  /** Ticket 06: withdrawal-cranking state across ticks (see `WithdrawState`). */
  private lastWithdrawState: WithdrawState | null = null;
  /** Ticket 13: what the venue cranks remember across ticks (see `VenueState`). */
  private lastVenueState: VenueState | null = null;
  /** The last `step:epoch` the tick reported as waiting on the snapshot, so
   *  the log line appears once per step and epoch, not once per tick. */
  private lastSnapshotPending: string | null = null;
  /** The Drawn epoch whose payout proof was refused (ticket 12). Kept in memory
   *  only: a restart tries the payout once more, which fails the same way and
   *  records it again. */
  private snapshotMismatchEpoch: bigint | null = null;
  /** Ticket 05: holds step 3's very first `begin_epoch` back until this chain
   *  timestamp; null when `LAUNCH_AT` is unset. */
  private readonly launchAt: bigint | null;
  private readonly referralQualifySeconds: number;
  /** Logged once, the first tick that sees the pool shut down, so the
   *  epoch loop stopping is announced instead of just
   *  going quiet (ops-and-envs ticket 08). Shutdown is irreversible, so
   *  this never needs to reset. */
  private shutdownAnnounced = false;
  constructor(
    private readonly chain: ChainService,
    private readonly prisma: PrismaService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    const launchAtIso = config.get("LAUNCH_AT", { infer: true });
    this.referralQualifySeconds = config.get("REFERRAL_QUALIFY_SECONDS", { infer: true });
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
          "pool is shut down: the epoch loop has stopped; " +
            "paying an already-drawn epoch and processing withdrawals continue",
        );
      }
      const outcome = await runTick(ctx);
      if (outcome.withdrawState) this.lastWithdrawState = outcome.withdrawState;
      if (outcome.venueState) this.lastVenueState = outcome.venueState;
      this.snapshotMismatchEpoch = outcome.snapshotMismatchEpoch ?? null;
      if (outcome.snapshotPending) {
        const { step, epochId } = outcome.snapshotPending;
        const key = `${step}:${epochId}`;
        if (key !== this.lastSnapshotPending) {
          this.lastSnapshotPending = key;
          this.logger.log(`snapshot_pending: ${step} for epoch ${epochId} waits for the ledger to take the Epoch snapshot`);
        }
      }
      if (outcome.action) this.logger.log(`sent ${outcome.action}`);
      // The job runs whatever the chain steps reported; a step error wins the slot.
      const referralError = await this.grantReferralBonuses();
      const stepError = outcome.stepError ?? referralError;
      if (stepError) this.logger.warn(`tick step failed: ${stepError}`);
      const waitMs = msUntilWake(ctx.now, outcome.nextWakeAt);
      await this.writeState(outcome, stepError ?? null, waitMs);
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

  /** Off-chain-tickets 22: the Referral bonus job, a database write with no
   *  chain transaction, so it runs beside the tick's steps. Returns the error
   *  text for the tick's `lastError`, or undefined. */
  private async grantReferralBonuses(): Promise<string | undefined> {
    try {
      const granted = await grantReferralBonuses(this.prisma, {
        poolAddress: this.chain.poolAddress().toBase58(),
        operator: this.chain.keypair.publicKey.toBase58(),
        now: BigInt(Math.floor(Date.now() / 1000)),
        qualifySeconds: this.referralQualifySeconds,
      });
      if (granted > 0) this.logger.log(`granted the Referral bonus to ${granted} referrers`);
      return undefined;
    } catch (cause) {
      return `referral bonus job failed: ${errorText(cause)}`;
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
    const [poolInfo, clockInfo, proposalInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        poolAddress,
        SYSVAR_CLOCK_PUBKEY,
        this.chain.venueProposalAddress(poolAddress),
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

    const { currentEpoch, previousEpoch } = await this.readCycle(pool);
    const poolKey = poolAddress.toBase58();

    return {
      now,
      pool,
      currentEpoch,
      previousEpoch,
      ix: this.instructions,
      lastWithdrawState: this.lastWithdrawState,
      lastVenueState: this.lastVenueState,
      // The account exists only while a proposal is open (venue-switch ticket 03).
      venueProposal:
        proposalInfo && proposalInfo.owner.equals(this.chain.programId)
          ? decodeVenueProposal(this.chain.program, proposalInfo.data)
          : null,
      venueAvailable: () => this.venueAvailable(pool),
      launchAt: this.launchAt,
      fulfilled: (seed) => this.fulfilled(seed),
      drawRequest: async (epochId) => {
        const snapshot = await readCommitment(this.prisma, poolKey, epochId);
        return snapshot === null
          ? null
          : { snapshot, nonce: await claimNonce(this.prisma, poolKey, epochId) };
      },
      payoutProof: (epochId, target) => winnerProof(this.prisma, poolKey, epochId, target),
      snapshotMismatchEpoch: this.snapshotMismatchEpoch,
      principalVaultBalance: () => this.principalVaultBalance(),
      duePendingWithdrawals: (currentEpochId, deadline) =>
        this.duePendingWithdrawals(currentEpochId, deadline),
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

  /** Current epoch and previous epoch in one `getMultipleAccounts`. */
  private async readCycle(pool: PoolState): Promise<{
    currentEpoch: EpochState | null;
    previousEpoch: EpochState | null;
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
    if (wanted.length === 0) return { currentEpoch: null, previousEpoch: null };

    const infos = await this.chain.connection.getMultipleAccountsInfo(wanted);
    const epochAt = (index: number): EpochState | null => {
      const data = index >= 0 ? infos[index]?.data : undefined;
      return data ? decodeEpoch(this.chain.program, data) : null;
    };

    return { currentEpoch: epochAt(currentIndex), previousEpoch: epochAt(previousIndex) };
  }

  private async fulfilled(seed: Uint8Array): Promise<boolean> {
    const address = randomnessAddress(this.chain.programId, seed, this.testVrf);
    const info = await this.chain.connection.getAccountInfo(address);
    return isFulfilled(info?.data);
  }

  /**
   * The venue's free liquidity, which sizes a drain step: the pinned klend
   * reserve's, or what the kVault can pay out now (read this tick). Null
   * for any other kind and when the read fails: the drain then asks for the
   * whole position and the program's `VenueIlliquid` is the judge.
   */
  private async venueAvailable(pool: PoolState): Promise<bigint | null> {
    if (pool.venueKind === VENUE_KIND.kvault && pool.kvault) {
      try {
        return withdrawable(pool.kvault);
      } catch {
        return null; // no funded allocation: the drain asks for the lot and the program judges
      }
    }
    if (pool.venueKind !== VENUE_KIND.klend) return null;
    try {
      const info = await this.chain.connection.getAccountInfo(pool.klendReserve);
      return info ? decodeReserve(info.data).available : null;
    } catch (cause) {
      this.logger.warn(`could not read the venue's liquidity: ${(cause as Error).message}`);
      return null;
    }
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
    deadline: { now: bigint; epochSeconds: bigint; shutdown: boolean },
  ): Promise<{ owner: string; amount: bigint }[]> {
    // The same three routes `process_withdraw` accepts (custody.rs): the epoch
    // moved on, `now > requested_at + epoch_seconds`, or the pool is shut down.
    const players = await this.prisma.player.findMany({
      where: {
        poolAddress: this.chain.poolAddress().toBase58(),
        pendingWithdraw: { gt: 0 },
        ...(deadline.shutdown
          ? {}
          : {
              OR: [
                { pendingEpoch: { lt: currentEpochId } },
                { requestedAt: { lt: deadline.now - deadline.epochSeconds } },
              ],
            }),
      },
      orderBy: [{ pendingEpoch: "asc" }, { requestedAt: "asc" }],
      select: { owner: true, pendingWithdraw: true },
    });
    return players.map((player) => ({
      owner: player.owner,
      amount: player.pendingWithdraw,
    }));
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
      | "snapshotMismatchEpoch"
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
      ...(outcome.snapshotMismatchEpoch === undefined
        ? {}
        : { snapshotMismatch: outcome.snapshotMismatchEpoch !== null }),
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

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
