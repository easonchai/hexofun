// Spec §3.4: the steps, in order, at most one transaction per tick. Step 6a
// runs the venue cranks (deploy, recall, harvest) and 6b pays out the
// withdrawals whose epoch has ended. The epoch goes `begin_epoch` (3),
// `request_draw` (4), `draw` (5), `payout` (6). The program is custody only
// (off-chain-tickets ticket 10), so there are no Round steps. Step 4 waits until
// the ledger has booked `EpochBegan` and the Epoch row holds the snapshot, then
// commits it; step 6 pays with the winner's proof out of the same rows
// (ticket 12).
//
// Everything the steps touch arrives in the context, so a test drives them
// with a fabricated chain state and a recording `send`, and the service is
// left with nothing but plumbing.
import type { TransactionInstruction } from "@solana/web3.js";

import type { WinnerProof } from "../snapshot/epoch-draw";
import type { SnapshotCommitment } from "../snapshot/sum-tree";
import { EPOCH_STATUS, type EpochState, type PoolState } from "./chain-state";
import type { OperatorInstructions } from "./instructions";
import {
  decideVenue,
  drainAmount,
  EMPTY_VENUE_STATE,
  hasVenue,
  nextHarvestAt,
  shutdownRecallAmount,
  venueFailed,
  venueSucceeded,
  VENUE_EXPECTED_ERRORS,
  venueUnlocksAt,
  type VenueCrank,
  type VenueProposalState,
  type VenueState,
} from "./venue";

/**
 * How far apart the scheduler's slow safety tick runs (ticket 03, spec.md
 * "The Operator becomes deadline-driven"), and the ceiling `nextWakeAt` falls
 * back to when nothing on chain gives it a closer deadline. A mis-computed
 * deadline then degrades to "checked on this cadence", not a stall.
 */
export const SAFETY_INTERVAL_SECONDS = 60n;
/**
 * Pending withdrawals per transaction (step 6b). Smaller than the eight
 * instructions a transaction could otherwise take because each one carries three accounts of its own (owner, Player, the
 * owner's token account) plus an idempotent ATA creation, and eight of those
 * overflow a legacy transaction.
 */
export const WITHDRAW_BATCH_SIZE = 4;
/** What the program answers when the principal vault cannot cover a payout;
 *  `ChainService.mapSendError` puts the IDL name in `Error.message`. */
const SHORT_VAULT = "InsufficientVaultLiquidity";

/**
 * What `payout` answers when the proof does not stand against the committed
 * snapshot (programs/hex_vault/src/snapshot.rs). Retrying cannot change the
 * answer: the snapshot rows and the chain's root disagree, which a human
 * resolves (docs/ops/incidents.md, "Snapshot proof refused").
 */
export const PROOF_REFUSED: ReadonlySet<string> = new Set([
  "ProofWrongLength",
  "ProofIndexOutOfRange",
  "ProofRootMismatch",
  "ProofSumMismatch",
  "ProofRangeMismatch",
  "ZeroTicketLeaf",
]);

/**
 * `payout` failures that name the winner's accounts, not the proof: a leaf
 * owner with no Player account (a granted wallet that never deposited), or a
 * frozen or closed token account. Retrying cannot pay them, and throwing would
 * stop every later step, so the epoch waits out `payout_timeout` instead.
 */
const UNPAYABLE_WINNER = [
  "AccountNotInitialized",
  "ConstraintTokenMint",
  "ConstraintTokenOwner",
  "AccountFrozen",
  "custom program error: 0x11",
];

/** Every catch below narrows `unknown` the same way. */
const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Ticket 06: consecutive failed tries before a single owner's withdrawal is
 *  given up on for the rest of the epoch. Fixed and small, per the ticket. */
export const WITHDRAW_FAILURE_LIMIT = 3;

/**
 * Ticket 12: a drawn epoch with a human winner never rolls over just because
 * `payout_timeout` elapsed — it also waits for this much longer, so an admin
 * who is not yet being paged (a misconfigured `payout_timeout` shorter than
 * this) still gets a window to intervene before the prize is given up on.
 * The House has no such protection to wait for: rolling its own win back into
 * the pot costs nobody a payout.
 */
export const DRAWN_UNPAID_ALERT_SECONDS = 300n;

/**
 * Ticket 09: slack layered onto `epochNoProgress`'s deadline below, covering
 * RPC and indexer lag beyond the epoch's own VRF timeout. Fixed, like
 * `DRAWN_UNPAID_ALERT_SECONDS` above.
 */
export const NO_PROGRESS_SLACK_SECONDS = 300n;

/**
 * Ticket 09: whether `epoch` (the previous epoch, still draining through its
 * lifecycle) has missed the deadline by which it should have reached a
 * terminal status (Paid or RolledOver). The void/rollover paths in
 * `decide()` already self-heal a stuck Drawing or Drawn epoch on their own
 * timeouts; this is the backstop for whatever a timeout does not cover (an
 * Ended epoch whose `request_draw` keeps failing, most often), so it does not
 * need to know which phase is actually stuck.
 */
export function epochNoProgress(pool: PoolState, epoch: EpochState | null, now: bigint): boolean {
  if (epoch === null) return false;
  if (epoch.status === EPOCH_STATUS.PAID || epoch.status === EPOCH_STATUS.ROLLED_OVER) {
    return false;
  }
  const expectedDoneBy = epoch.endsAt + pool.vrfTimeout + NO_PROGRESS_SLACK_SECONDS;
  return now > expectedDoneBy;
}

/**
 * Ticket 09: an epoch drawn but sitting unpaid for more than a few minutes,
 * whether the winner is the House or a human and regardless of
 * `payout_timeout` — a page, not the rollover-gate decision step 6 already
 * makes off the same `DRAWN_UNPAID_ALERT_SECONDS` constant.
 */
export function epochDrawnUnpaid(epoch: EpochState | null, now: bigint): boolean {
  return (
    epoch !== null &&
    epoch.status === EPOCH_STATUS.DRAWN &&
    now > epoch.drawnAt + DRAWN_UNPAID_ALERT_SECONDS
  );
}

/** Ticket 06: what step 6b remembers about withdrawal cranking across ticks,
 *  scoped to one epoch (a new epoch starts the count clean). The service
 *  persists this across ticks; the pure function only reads and returns it. */
export interface WithdrawState {
  readonly epochId: bigint;
  /** Once a batch send has failed, every following tick sends the queue one
   *  at a time instead of batching, so one bad owner cannot block the rest. */
  readonly singleMode: boolean;
  /** Consecutive single-send failures per owner, this epoch. */
  readonly failures: ReadonlyMap<string, number>;
  /** Owners given up on for the rest of the epoch after `WITHDRAW_FAILURE_LIMIT`. */
  readonly skipped: ReadonlySet<string>;
}

const EMPTY_WITHDRAW_STATE = (epochId: bigint): WithdrawState => ({
  epochId,
  singleMode: false,
  failures: new Map(),
  skipped: new Set(),
});

export interface TickContext {
  /** Chain clock, not wall time: every deadline below is a chain timestamp. */
  readonly now: bigint;
  readonly pool: PoolState;
  readonly currentEpoch: EpochState | null;
  readonly previousEpoch: EpochState | null;
  readonly ix: OperatorInstructions;
  /** Ticket 06: null before any withdrawal has ever failed. */
  readonly lastWithdrawState: WithdrawState | null;
  /** Ticket 13: what the venue cranks remember, null before the first one ran. */
  readonly lastVenueState: VenueState | null;
  /** Venue-switch ticket 04: the pool's open venue proposal, null when none.
   *  Read off the proposal account every tick. */
  readonly venueProposal: VenueProposalState | null;
  /** The venue's free liquidity in atomic USDC, null when it cannot be read
   *  (the stub kind, a failed read). Asked only before a drain. */
  venueAvailable(): Promise<bigint | null>;
  /** Beta-launch-fixes ticket 05: holds step 3 back from the Pool's very
   *  first `begin_epoch` until this chain timestamp. Null runs step 3 as
   *  before (unconfigured, or the Pool already has an Epoch). */
  readonly launchAt: bigint | null;
  /** Has the oracle answered the request for this seed? */
  fulfilled(seed: Uint8Array): Promise<boolean>;
  /** Step 4: the ended epoch's snapshot commitment and the nonce to request
   *  its draw with, or null until the ledger has taken the snapshot. */
  drawRequest(
    epochId: bigint,
  ): Promise<{ readonly nonce: Uint8Array; readonly snapshot: SnapshotCommitment } | null>;
  /** Step 6: the winner's proof out of the stored snapshot, or null when the
   *  rows cannot back the root the chain holds. */
  payoutProof(epochId: bigint, target: bigint): Promise<WinnerProof | null>;
  /** The epoch whose proof was refused on an earlier tick, which step 6 then
   *  leaves alone. Null when none. */
  readonly snapshotMismatchEpoch: bigint | null;
  /** The principal vault's balance, in atomic units. Read only when a payout
   *  has already failed for want of liquidity, to size the shortfall. */
  principalVaultBalance(): Promise<bigint>;
  /**
   * Players from the Read model whose withdrawal request is payable now:
   * `pendingWithdraw > 0` and one of the program's three routes: the pool
   * moved past `pendingEpoch`, `now` is past `requestedAt + epochSeconds`, or
   * the pool is shut down. Oldest request first, so a long queue still drains
   * in order.
   */
  duePendingWithdrawals(
    currentEpochId: bigint,
    deadline: { now: bigint; epochSeconds: bigint; shutdown: boolean },
  ): Promise<{ owner: string; amount: bigint }[]>;
  send(instructions: TransactionInstruction[]): Promise<string>;
  /** Something an operator should read but that is not a failed tick: so far
   *  only a venue crank the program refused, which is retried later. */
  warn(message: string): void;
}

export interface TickOutcome {
  /** Instruction sent this tick, named as in the program, or null. */
  readonly action: string | null;
  /** Ticket 13: the venue cranks' updated memory, present only when a crank
   *  was sent, failed or escalated this tick. */
  readonly venueState?: VenueState;
  /**
   * How much the principal vault was short of everything step 6b owed, 0
   * when it covered them all. Present only on a tick that reached step 6b,
   * so a tick that acted earlier leaves the last reported figure standing.
   */
  readonly withdrawShortfall?: bigint;
  /** Ticket 06: this tick's withdrawal-cranking state, present whenever step
   *  6b ran, for the service to remember as next tick's `lastWithdrawState`. */
  readonly withdrawState?: WithdrawState;
  /**
   * Ticket 06: a failure in the venue or withdrawal step, recorded so the
   * service writes it as the tick's `lastError` even though the tick went on
   * to act rather than aborting. Absent when none of those steps failed this
   * tick.
   */
  readonly stepError?: string;
  /**
   * The draw step this tick would have sent but for the missing Epoch
   * snapshot (the ledger has not booked `EpochBegan` yet). The service logs it
   * once per epoch.
   */
  readonly snapshotPending?: { readonly step: "request_draw"; readonly epochId: bigint };
  /**
   * Off-chain-tickets ticket 12: the Drawn epoch whose winner proof was
   * refused or could not be built, which step 6 no longer retries; null when
   * there is none. Present on every tick, so the service can remember it and
   * `OperatorState.snapshotMismatch` follows it.
   */
  readonly snapshotMismatchEpoch?: bigint | null;
  /** Ticket 09: whether the previous epoch has missed its expected deadline
   *  to reach a terminal status. Present on every tick. */
  readonly epochNoProgress?: boolean;
  /** Ticket 09: whether the previous epoch drew a winner more than
   *  `DRAWN_UNPAID_ALERT_SECONDS` ago and still has not been paid. Present
   *  on every tick. */
  readonly drawnUnpaid?: boolean;
  /**
   * The chain timestamp at which this decision could next differ: an Epoch
   * ending, a VRF timeout, a venue deadline, or the safety interval when none
   * of those apply. Not a wall-clock
   * value and not a duration; the scheduler converts it (see
   * `operator.service.ts`).
   */
  readonly nextWakeAt: bigint;
}

/** `runTick`'s decision, before the deadline is attached. Every branch below
 *  still returns one of these; `runTick` is the thin wrapper that adds
 *  `nextWakeAt` in one place instead of at every return statement. */
type Decision = Omit<TickOutcome, "nextWakeAt">;

const NOTHING: Decision = { action: null };

/**
 * The next chain timestamp at which `decide` could return something
 * different, given the same ctx it just ran on. Pure: everything it reads
 * already lives on `ctx`, so it never touches the clock or the network.
 *
 * Acting this tick (`acted`) always makes that "now": a batched step
 * (the withdrawal queue) may have more left to do, and the state that
 * triggered the action is still the state on `ctx`, so recomputing off it
 * would otherwise just repeat the same boundary that already fired.
 */
function nextWakeAt(ctx: TickContext, acted: boolean): bigint {
  const { pool, currentEpoch, previousEpoch, now } = ctx;
  const candidates: bigint[] = [now + SAFETY_INTERVAL_SECONDS];

  if (acted) candidates.push(now);
  if (currentEpoch) candidates.push(currentEpoch.endsAt);
  // Ticket 13: the pre-end harvest window opens `HARVEST_LEAD_SECONDS` before
  // the epoch ends. Dropped by the `>= now` filter once it has opened.
  if (hasVenue(pool)) {
    const harvestAt = nextHarvestAt(currentEpoch, ctx.lastVenueState ?? EMPTY_VENUE_STATE);
    if (harvestAt !== null) candidates.push(harvestAt);
    // Venue-switch ticket 04: the drain starts the moment the lock ends.
    if (ctx.venueProposal) candidates.push(venueUnlocksAt(ctx.venueProposal));
  }
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    candidates.push(previousEpoch.requestedAt + pool.vrfTimeout);
  }
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    candidates.push(previousEpoch.drawnAt + pool.payoutTimeout);
  }
  // Ticket 05: wake right at the launch time instead of waiting out the
  // safety interval, so the countdown's end is when begin_epoch actually
  // fires. Dropped by the `>= now` filter below once launch has passed.
  if (pool.currentEpochId === 0n && ctx.launchAt !== null) {
    candidates.push(ctx.launchAt);
  }

  return candidates
    .filter((candidate) => candidate >= now)
    .reduce((soonest, candidate) => (candidate < soonest ? candidate : soonest));
}

/** Wall-clock ms until the scheduler should look again: the chain-seconds gap
 * to `deadline`, clamped to the safety interval and never negative. The clamp
 * is what keeps a fast local validator from under-serving the protocol: chain
 * time there can run ahead of wall time, so a raw `deadline - now` read as
 * wall-clock milliseconds would sleep past the point the safety tick exists
 * to catch. The caller re-reads the chain on every wake, so a clamp that
 * fires early costs one extra tick, never a stale one.
 */
export function msUntilWake(now: bigint, deadline: bigint): number {
  const chainSeconds = Number(deadline - now);
  const clamped = Math.min(Math.max(chainSeconds, 0), Number(SAFETY_INTERVAL_SECONDS));
  return clamped * 1000;
}

export async function runTick(ctx: TickContext): Promise<TickOutcome> {
  const decision = await decide(ctx);
  return { ...decision, nextWakeAt: nextWakeAt(ctx, decision.action !== null) };
}

async function decide(ctx: TickContext): Promise<Decision> {
  const { pool, currentEpoch, previousEpoch, now } = ctx;

  // Ticket 06: accumulated across the venue and withdrawal steps below, so a
  // failure in one of them never has to `return` (and so cut the tick short)
  // to be remembered. Every later `return` in this function is wrapped in
  // `finish()`, which folds these back in.
  let stepError: string | undefined;
  let withdrawStateOut: WithdrawState | undefined;
  let snapshotPending: Decision["snapshotPending"];
  let proofRefusedFor = ctx.snapshotMismatchEpoch;
  // Ticket 13: the venue cranks' memory, folded into every return the same way.
  let venueState = ctx.lastVenueState ?? EMPTY_VENUE_STATE;
  let venueChanged = false;
  // Ticket 09: computed once per tick, off the same ctx every branch below
  // reads, so every return (via `finish`) carries the same answer regardless
  // of which step acted.
  const noProgress = epochNoProgress(pool, previousEpoch, now);
  const drawnUnpaidNow = epochDrawnUnpaid(previousEpoch, now);
  const finish = (decision: Decision): Decision => ({
    ...decision,
    epochNoProgress: noProgress,
    drawnUnpaid: drawnUnpaidNow,
    ...(stepError !== undefined ? { stepError } : {}),
    ...(withdrawStateOut !== undefined ? { withdrawState: withdrawStateOut } : {}),
    ...(snapshotPending !== undefined ? { snapshotPending } : {}),
    // Clears itself once the epoch leaves Drawn (rolled over, or paid by hand).
    snapshotMismatchEpoch:
      proofRefusedFor !== null &&
      previousEpoch?.epochId === proofRefusedFor &&
      previousEpoch.status === EPOCH_STATUS.DRAWN
        ? proofRefusedFor
        : null,
    ...(venueChanged ? { venueState } : {}),
  });

  // 3. Begin Epoch: only once the previous Epoch (if any) has actually
  // finished, so no Epoch is ever left two behind. Refused in shutdown, so the
  // epoch loop stops here once the pool is shut down (spec.md "Shutdown").
  // Ticket 05: the Pool's very first begin_epoch (no Epoch yet) waits for
  // LAUNCH_AT, if configured, so deposits can open days before the first
  // Draw without an Epoch existing. Every later begin_epoch (currentEpoch
  // already exists) is unaffected.
  // game-jackpot-pause ticket 02: `begin_epoch` is refused while the jackpot
  // is paused, and a new pool starts that way, so no epoch begins until the
  // admin starts the jackpot.
  const launchReady = ctx.launchAt === null || now >= ctx.launchAt;
  const epochEnded =
    (pool.currentEpochId === 0n && launchReady) ||
    (currentEpoch !== null && now >= currentEpoch.endsAt);
  const previousDone =
    previousEpoch === null ||
    previousEpoch.status === EPOCH_STATUS.PAID ||
    previousEpoch.status === EPOCH_STATUS.ROLLED_OVER;
  if (!pool.shutdown && !pool.jackpotPaused && epochEnded && previousDone) {
    await ctx.send(await ctx.ix.beginEpoch(pool));
    return finish({ action: "begin_epoch" });
  }

  // 4. The ended epoch goes to the draw. `request_draw` commits the Epoch
  // snapshot's root, total and shape, so it waits until the ledger has booked
  // `EpochBegan` and the Epoch row holds them (`snapshot_pending`; the tick
  // falls through, so withdrawals are not held). An empty snapshot commits
  // zeros and the program rolls the epoch over. Refused in shutdown and while
  // the jackpot is paused, and the tick falls through in both. `begin_epoch`
  // and `rollover_epoch` are refused too, so an Ended epoch waits out the pause
  // the same way it always did.
  if (
    !pool.shutdown &&
    !pool.jackpotPaused &&
    previousEpoch?.status === EPOCH_STATUS.ENDED
  ) {
    const request = await ctx.drawRequest(previousEpoch.epochId);
    if (request === null) {
      snapshotPending = { step: "request_draw", epochId: previousEpoch.epochId };
    } else {
      await ctx.send(
        await ctx.ix.requestDraw(pool, previousEpoch.epochId, request.nonce, request.snapshot),
      );
      return finish({ action: "request_draw" });
    }
  }

  // 5. Waiting on the draw's randomness. `draw` is refused in shutdown
  // (ops-and-envs ticket 02); `rollover_epoch` is not, so a Drawing epoch
  // still moves on past its `vrf_timeout` instead of waiting forever.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    if (!pool.shutdown && (await ctx.fulfilled(previousEpoch.vrfSeed))) {
      await ctx.send(await ctx.ix.draw(pool, previousEpoch));
      return finish({ action: "draw" });
    }
    if (now > previousEpoch.requestedAt + pool.vrfTimeout) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch));
      return finish({ action: "rollover_epoch" });
    }
  }

  // 6. Drawn: `payout` carries the winner's leaf and proof, built from the
  // snapshot rows. Permissionless, and allowed after shutdown. If the proof
  // cannot be built or the chain refuses it, retrying cannot help: the tick
  // records it (`snapshotMismatchEpoch`, the SNAPSHOT_MISMATCH alert) and
  // leaves the epoch to the rollover below. A drawn epoch rolls over past
  // `payout_timeout`, so the prize stays in the vault for the next draw rather
  // than stranding the epoch forever. A winner is never rolled over until the
  // drawn-unpaid condition has had `DRAWN_UNPAID_ALERT_SECONDS` to page
  // someone, regardless of how short `payout_timeout` is set.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    const epochId = previousEpoch.epochId;
    if (proofRefusedFor !== epochId) {
      const proof = await ctx.payoutProof(epochId, previousEpoch.target);
      if (proof === null) {
        proofRefusedFor = epochId;
        ctx.warn(
          `epoch ${epochId}: the snapshot rows do not back the committed root, so no payout proof can be built; not retrying`,
        );
      } else {
        try {
          await ctx.send(await ctx.ix.payout(pool, epochId, proof));
          return finish({ action: "payout" });
        } catch (cause) {
          const message = errorMessage(cause);
          if (PROOF_REFUSED.has(message)) {
            proofRefusedFor = epochId;
            ctx.warn(`epoch ${epochId}: payout proof refused (${message}); not retrying`);
          } else if (UNPAYABLE_WINNER.some((marker) => message.includes(marker))) {
            ctx.warn(`epoch ${epochId}: the winner cannot be paid (${message}); rolling over after payout_timeout`);
          } else if (EXPECTED_ERRORS.has(message)) {
            ctx.warn(`epoch ${epochId}: payout skipped (${message})`);
          } else {
            // Not thrown: the rollover check, venue cranks and withdrawals
            // below still run. The next tick pays again.
            stepError = stepError ?? `payout failed: ${message}`;
          }
        }
      }
    }
    const alertHasFired = now > previousEpoch.drawnAt + DRAWN_UNPAID_ALERT_SECONDS;
    if (now > previousEpoch.drawnAt + pool.payoutTimeout && alertHasFired) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch));
      return finish({ action: "rollover_epoch" });
    }
  }

  // 6a. Venue cranks (ticket 13): harvest inside the last minutes of the
  // epoch, recall when free idle is under the floor, deploy what sits above
  // the target. All three are permissionless, so a failure is recorded and
  // cooled down but never throws: a failed harvest does not block the draw,
  // and nothing here holds up the withdrawals below it. The program
  // syncs and refreshes the klend reserve itself.
  /** Sends one crank. True when a transaction landed. */
  async function sendVenue(crank: VenueCrank): Promise<boolean> {
    try {
      await ctx.send(
        crank.kind === "deploy"
          ? await ctx.ix.deployToVenue(pool, crank.amount)
          : crank.kind === "recall"
            ? await ctx.ix.recall(pool, crank.amount)
            : crank.kind === "drain"
              ? await ctx.ix.drainVenue(pool, crank.amount)
              : crank.kind === "migrate"
                ? await ctx.ix.migrateVenue(pool)
                : await ctx.ix.harvest(pool),
      );
      venueState = venueSucceeded(venueState, crank.kind, currentEpoch?.epochId ?? null);
      venueChanged = true;
      return true;
    } catch (cause) {
      const message = errorMessage(cause);
      venueChanged = true;
      // Nothing was owed: as good as harvested for this epoch.
      if (crank.kind === "harvest" && message === "NothingToHarvest") {
        venueState = venueSucceeded(venueState, "harvest", currentEpoch?.epochId ?? null);
        return false;
      }
      venueState = venueFailed(venueState, crank.kind, now);
      if (VENUE_EXPECTED_ERRORS.has(message)) {
        ctx.warn(`${crank.kind} refused, retrying in a while: ${message}`);
      } else {
        stepError = stepError ?? `${crank.kind} failed: ${message}`;
      }
      return false;
    }
  }

  if (hasVenue(pool)) {
    // The liquidity read is a round trip, so it waits until a drain or the
    // shutdown recall is due.
    const drainDue =
      drainAmount(pool, ctx.venueProposal, null, now) !== null ||
      shutdownRecallAmount(pool, null) !== null;
    const crank = decideVenue({
      pool,
      vaultBalance: await ctx.principalVaultBalance(),
      now,
      currentEpoch,
      state: venueState,
      proposal: ctx.venueProposal,
      venueAvailable: drainDue ? await ctx.venueAvailable() : null,
    });
    if (crank && (await sendVenue(crank))) {
      return finish({
        action:
          crank.kind === "deploy"
            ? "deploy_to_venue"
            : crank.kind === "drain"
              ? "drain_venue"
              : crank.kind === "migrate"
                ? "migrate_venue"
                : crank.kind,
      });
    }
  }

  // 6b. Pay out the withdrawals whose epoch has ended. Permissionless on the
  // program side, so the operator only pays the fee; it runs behind every
  // step above, which is what keeps a late return from the yield venue from
  // delaying a draw or a payout. A vault too short to cover the
  // next batch has already tried a recall in 6a (a vault under what is queued
  // is under the idle floor); when that cannot cover it either, it reports the
  // gap and waits for USDC to come back, retrying on the following tick.
  const withdrawStateIn =
    ctx.lastWithdrawState?.epochId === pool.currentEpochId
      ? ctx.lastWithdrawState
      : EMPTY_WITHDRAW_STATE(pool.currentEpochId);
  // Impaired, every payout is the Haircut value, so the program wants the
  // owner's own signature and the crank sends nothing until the pool recovers.
  const due = pool.impaired
    ? []
    : (
        await ctx.duePendingWithdrawals(pool.currentEpochId, {
          now: ctx.now,
          epochSeconds: pool.epochSeconds,
          shutdown: pool.shutdown,
        })
      ).filter(
        (entry) => !withdrawStateIn.skipped.has(entry.owner),
      );
  let withdrawShortfall = 0n;
  if (due.length > 0) {
    // Ticket 06: once a batch send has failed, every following tick pays the
    // queue one at a time instead — a single bad owner cannot then block
    // anyone behind them, at the cost of one payout per tick instead of
    // `WITHDRAW_BATCH_SIZE`.
    let batch: typeof due = [];
    let offset = 0;
    let landed = false;
    // `NothingPending` means the chain already paid the owner (the mirror lags,
    // or the depositor cranked their own). The error does not name the owner,
    // so a batch that hits it is halved until the offender is alone; that owner
    // is dropped for this tick without a failure count, and the rest are sent.
    const pay = async (entries: typeof due): Promise<void> => {
      try {
        await ctx.send(await ctx.ix.processWithdrawals(pool, entries));
        landed = true;
      } catch (cause) {
        if (errorMessage(cause) !== "NothingPending") throw cause;
        if (entries.length === 1) return;
        const mid = entries.length >> 1;
        await pay(entries.slice(0, mid));
        await pay(entries.slice(mid));
      }
    };
    try {
      // A batch whose every owner was already paid sends nothing; take the next.
      while (!landed && offset < due.length) {
        batch = due.slice(offset, offset + (withdrawStateIn.singleMode ? 1 : WITHDRAW_BATCH_SIZE));
        offset += batch.length;
        await pay(batch);
      }
      if (!landed) {
        withdrawStateOut = withdrawStateIn;
        return finish({ ...NOTHING, withdrawShortfall });
      }
      const failures = new Map(withdrawStateIn.failures);
      for (const entry of batch) failures.delete(entry.owner);
      withdrawStateOut = {
        epochId: pool.currentEpochId,
        // Back to batching once a send lands cleanly with nothing left
        // waiting behind it; otherwise keep cranking singly until it does.
        singleMode: withdrawStateIn.singleMode && due.length > offset,
        failures,
        skipped: withdrawStateIn.skipped,
      };
      return finish({ action: "process_withdraw", withdrawShortfall: 0n });
    } catch (cause) {
      const message = errorMessage(cause);
      if (message === SHORT_VAULT) {
        // The batch that was actually tried, not the whole queue: the
        // program refused to pay these four, and sizing the gap against a
        // queue of forty would ask the admin to bring back ten times the
        // principal the next transaction needs.
        const owed = batch.reduce((sum, entry) => sum + entry.amount, 0n);
        const held = await ctx.principalVaultBalance();
        withdrawShortfall = owed > held ? owed - held : 0n;
        ctx.warn(
          `principal vault holds ${held} against ${owed} of due withdrawals; short by ${withdrawShortfall}`,
        );
        withdrawStateOut = withdrawStateIn;
      } else if (!withdrawStateIn.singleMode) {
        // First failure of a batch: never blame a specific owner yet, just
        // switch strategy so the next tick isolates the bad one.
        withdrawStateOut = { ...withdrawStateIn, singleMode: true };
        stepError =
          stepError ??
          `withdrawal batch failed, retrying one at a time: ${message}`;
      } else {
        const owner = batch[0]?.owner;
        if (owner === undefined) throw cause;
        const count = (withdrawStateIn.failures.get(owner) ?? 0) + 1;
        const failures = new Map(withdrawStateIn.failures);
        const skipped = new Set(withdrawStateIn.skipped);
        if (count >= WITHDRAW_FAILURE_LIMIT) {
          failures.delete(owner);
          skipped.add(owner);
          ctx.warn(
            `withdrawal to ${owner} failed ${count} times in a row; skipping for the rest of epoch ${pool.currentEpochId}`,
          );
        } else {
          failures.set(owner, count);
        }
        withdrawStateOut = { epochId: pool.currentEpochId, singleMode: true, failures, skipped };
        stepError = stepError ?? `withdrawal to ${owner} failed: ${message}`;
      }
    }
  } else {
    withdrawStateOut = withdrawStateIn;
  }

  return finish({ ...NOTHING, withdrawShortfall });
}

/**
 * Program errors that mean "someone already did this" or "not yet". Every one
 * of them is a race between the tick's read and its transaction landing, so
 * they are noise, not failures. Names come from the IDL error table, which is
 * what `ChainService.mapSendError` puts in `Error.message`.
 */
export const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  // `request_draw` resent for an epoch a previous tick already sent to the draw.
  "EpochNotAwaitingDraw",
  "EpochNotDrawing",
  "EpochNotDrawn",
  "EpochNotEnded",
  // A pending withdrawal the Player mirror still shows: either a depositor
  // cranked their own payout first (the UI offers that), or a second
  // request re-stamped `pending_epoch` to the epoch now running.
  "NothingPending",
  // The admin's shutdown() landed between this tick's read of `pool.shutdown`
  // and one of the steps it gates confirming (ops-and-envs ticket 02): the
  // gates above make this rare, not impossible, and the next tick reads the
  // now-shut-down pool and stops asking.
  "PoolShutDown",
  // The oracle answered between the tick's read and its void/rollover
  // landing, which is exactly the race the program guard exists for.
  "RandomnessAlreadyFulfilled",
  "RandomnessNotFulfilled",
  "VrfTimeoutNotElapsed",
  "WithdrawalNotDue",
]);
