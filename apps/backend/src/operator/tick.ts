// Spec §3.4: the steps, in order, at most one transaction per tick. Step 6a
// runs the venue cranks (deploy, recall, harvest) and 6b pays out the
// withdrawals whose epoch has ended. Round steps (1-2) run before the Epoch
// steps (3+) so a Round can never straddle an Epoch boundary; `begin_epoch`
// (3) waits for both the sweep and the previous Epoch to be settled. The
// epoch goes `begin_epoch`, `request_draw` (4), `draw` (5), `payout` (6)
// (yield-claimer ticket 13: no registration step any more).
//
// Everything the steps touch arrives in the context, so a test drives them
// with a fabricated chain state and a recording `send`, and the service is
// left with nothing but plumbing.
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import {
  EPOCH_STATUS,
  ROUND_STATUS,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
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

/** Instructions per transaction for the two batched steps (spec §3.4). */
export const BATCH_SIZE = 8;
/** Step 7 waits this long past a settled/forfeited `lastRound.endsAt` before
 *  opening the next Round. The reveal now fires the moment the draw lands,
 *  usually before `endsAt`, so one second of slack is all it needs. */
export const REVEAL_SECONDS = 1n;
/**
 * How far apart the scheduler's slow safety tick runs (ticket 03, spec.md
 * "The Operator becomes deadline-driven"), and the ceiling `nextWakeAt` falls
 * back to when nothing on chain gives it a closer deadline. A mis-computed
 * deadline then degrades to "checked on this cadence", not a stall.
 */
export const SAFETY_INTERVAL_SECONDS = 60n;
/**
 * Pending withdrawals per transaction (step 6b). Smaller than BATCH_SIZE
 * because each one carries three accounts of its own (owner, Player, the
 * owner's token account) plus an idempotent ATA creation, and eight of those
 * overflow a legacy transaction.
 */
export const WITHDRAW_BATCH_SIZE = 4;
/** What the program answers when the principal vault cannot cover a payout;
 *  `ChainService.mapSendError` puts the IDL name in `Error.message`. */
const SHORT_VAULT = "InsufficientVaultLiquidity";

/**
 * Markers in a failed `payout`'s message that mean this winner cannot be
 * paid at all, so step 6 warns and leaves the epoch Drawn for the
 * `payout_timeout` rollover to take. Every other failure is a real one and
 * has to reach `runOnce()`, or an RPC blip would look like an unpayable
 * winner and retry silently with no `lastError` until the timeout.
 *
 * `payout`'s non-House branch no longer has a `winner_token` account at all
 * (docs/plan/hexo-referrals ticket 02): the prize compounds into
 * `principal_vault`, a pool-owned PDA, so a non-House winner has nothing left
 * here that can independently be uninitialized, wrong-mint, wrong-owner or
 * frozen the way an arbitrary external token account could. These markers
 * now only have a real "unpayable winner" case on a House win, whose prize
 * still lands in the externally-owned `treasury`/`buyback_reserve` accounts
 * pinned at `create_pool` (see ADR 0010 and ticket 02's Comments). The
 * strings themselves are unchanged: they are Anchor's and SPL Token's own
 * generic account-constraint names, so they still match whichever account in
 * the transaction actually failed, House-only or not. SPL Token's codes are
 * in neither error table, so a frozen destination arrives as the raw custom
 * error code instead; both spellings are listed because a test names the
 * error and a validator names the code. Only SPL Token and this program run
 * in a payout transaction, and this program's codes start at 0x1770, so 0x11
 * can only be SPL Token's.
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

const cannotPayWinner = (cause: unknown): boolean =>
  UNPAYABLE_WINNER.some((marker) => errorMessage(cause).includes(marker));

/**
 * `grant_tickets`' operator-path cap errors (ticket 04). `computeBonuses`'
 * pool-wide scale-down is a best effort, not a guarantee: other grant
 * activity already counted against the epoch (an admin grant, an earlier
 * batch this same tick loop sent) can leave less headroom than it assumed
 * when a referrer's row was written.
 */
const GRANT_CAP_EXCEEDED = ["DailyPlayerGrantCapExceeded", "DailyPoolGrantCapExceeded"];

const capExceeded = (cause: unknown): boolean =>
  GRANT_CAP_EXCEEDED.some((marker) => errorMessage(cause).includes(marker));

/** Ticket 06: consecutive failed tries before a single owner's withdrawal is
 *  given up on for the rest of the epoch. Fixed and small, per the ticket. */
export const WITHDRAW_FAILURE_LIMIT = 3;

/**
 * Ticket 12: how many times in a row an *expected* race (see
 * `EXPECTED_ERRORS`) has hit the same action and target. The first two are
 * noise — a read that lost a race with a transaction already in flight — but
 * the third means something is actually wedged (a stale mirror row, most
 * often), so it graduates into a real, recorded tick error instead of being
 * swallowed forever.
 */
export const EXPECTED_ERROR_REPEAT_LIMIT = 3;

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
  /** The Round at `pool.openRoundId`, null when none is open. */
  readonly openRound: RoundState | null;
  /** The Round at `pool.nextRoundId - 1`, the most recently created one
   *  (open or already terminal). Null when none has ever been created. */
  readonly lastRound: RoundState | null;
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
  /** Ticket 12: how many times in a row each `action:target` key has hit an
   *  expected error. Empty before anything has repeated. */
  readonly lastExpectedErrors: ReadonlyMap<string, number>;
  /** Ticket 21: the epoch whose skipped round was last reported, null before
   *  the first one. */
  readonly lastRoundSkipEpochId: bigint | null;
  /** Beta-launch-fixes ticket 05: holds step 3 back from the Pool's very
   *  first `begin_epoch` until this chain timestamp. Null runs step 3 as
   *  before (unconfigured, or the Pool already has an Epoch). */
  readonly launchAt: bigint | null;
  /** Has the oracle answered the request for this seed? */
  fulfilled(seed: Uint8Array): Promise<boolean>;
  /** The principal vault's balance, in atomic units. Read only when a payout
   *  has already failed for want of liquidity, to size the shortfall. */
  principalVaultBalance(): Promise<bigint>;
  /**
   * Players from the Read model whose withdrawal request is payable now:
   * `pendingWithdraw > 0` and `pendingEpoch < currentEpochId`. Oldest
   * request first, so a long queue still drains in order.
   */
  duePendingWithdrawals(
    currentEpochId: bigint,
  ): Promise<{ owner: string; amount: bigint }[]>;
  /**
   * Every qualifying referrer's daily bonus for `epochId` not yet sent
   * (docs/plan/hexo-referrals ticket 08), computed and recorded before it is
   * ever handed back, so a crash or restart resumes instead of double
   * granting. Empty once every grant for the epoch is sent or already
   * granted on chain.
   */
  referralGrantsDue(epochId: bigint): Promise<{ referrer: string; amount: bigint }[]>;
  /** Records the signature of a batch of grants just sent. */
  markReferralGrantsSent(
    epochId: bigint,
    referrers: readonly string[],
    txSig: string,
  ): Promise<void>;
  /**
   * Positions still on chain whose Round has reached a terminal status
   * (Settled, Forfeited, Voided), across every such Round, not just the
   * newest, with the Round id so step 2 can group a batch by Round.
   */
  unsettledPositions(): Promise<
    { address: string; owner: string; roundId: bigint }[]
  >;
  /** Positions a confirmed `settle_position` just closed; keep them out of
   *  later `unsettledPositions` results. */
  forgetPositions(addresses: string[]): Promise<void>;
  /**
   * Terminal Rounds with no Position left on them and not yet marked
   * closed (ops-and-envs ticket 08): what `close_round` may still reclaim
   * rent from. Oldest id first.
   */
  roundsToClose(): Promise<bigint[]>;
  /** A Round `close_round` was just sent for; keep it out of later
   *  `roundsToClose` results until the indexer mirrors `RoundClosed`. */
  forgetRound(id: bigint): void;
  /**
   * Owner of the Player whose leaf in the Weight tree holds the drawn epoch's
   * target, read from the tree and the Player accounts on chain (ticket 13: no
   * Read model table holds Weight ranges any more). Null when none does yet.
   */
  winner(epoch: EpochState): Promise<string | null>;
  send(instructions: TransactionInstruction[]): Promise<string>;
  /** Something an operator should read but that is not a failed tick: so far
   *  only a payout that would not land, which step 6 retries. */
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
   * Ticket 06: a failure in the withdrawal, settle-position or close-round
   * step, recorded so the service writes it as the tick's `lastError` even
   * though the tick went on to act (possibly reaching `create_round`) rather
   * than aborting. Absent when none of those steps failed this tick.
   */
  readonly stepError?: string;
  /** Ticket 12: the updated expected-error repeat counts, present only when
   *  a step this tick recorded, cleared or escalated one. */
  readonly expectedErrors?: ReadonlyMap<string, number>;
  /** Ticket 21: set on the first tick of an epoch that holds back a round
   *  because it would end after the epoch does. Absent on every later tick of
   *  that epoch, so the service logs it once. */
  readonly roundSkip?: { readonly epochId: bigint; readonly endsAt: bigint };
  /** Ticket 09: whether the previous epoch has missed its expected deadline
   *  to reach a terminal status. Present on every tick. */
  readonly epochNoProgress?: boolean;
  /** Ticket 09: whether the previous epoch drew a winner more than
   *  `DRAWN_UNPAID_ALERT_SECONDS` ago and still has not been paid. Present
   *  on every tick. */
  readonly drawnUnpaid?: boolean;
  /**
   * The chain timestamp at which this decision could next differ: a Round
   * closing, an Epoch ending, a VRF timeout, the reveal wait after the last
   * Round, or the safety interval when none of those apply. Not a wall-clock
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
 * (the settle sweep, the withdrawal queue) may have more left to do, and the state that
 * triggered the action is still the state on `ctx`, so recomputing off it
 * would otherwise just repeat the same boundary that already fired.
 */
function nextWakeAt(ctx: TickContext, acted: boolean): bigint {
  const { pool, currentEpoch, previousEpoch, openRound, lastRound, now } = ctx;
  const candidates: bigint[] = [now + SAFETY_INTERVAL_SECONDS];

  if (acted) candidates.push(now);
  if (openRound?.status === ROUND_STATUS.OPEN) {
    candidates.push(openRound.endsAt - pool.closeBuffer);
    // The void deadline for a round whose request never landed; the
    // request retries every safety tick until then.
    candidates.push(openRound.endsAt + pool.vrfTimeout);
  }
  if (openRound?.status === ROUND_STATUS.REQUESTED) {
    candidates.push(openRound.requestedAt + pool.vrfTimeout);
  }
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
  if (
    pool.openRoundId === 0n &&
    lastRound &&
    lastRound.status !== ROUND_STATUS.VOIDED
  ) {
    candidates.push(lastRound.endsAt + REVEAL_SECONDS);
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
  const { pool, currentEpoch, previousEpoch, openRound, now } = ctx;

  // Ticket 06/12: accumulated across steps 2, 2c and 6b below, so a failure
  // in one of them never has to `return` (and so cut the tick short) to be
  // remembered — every later `return` in this function is wrapped in
  // `finish()`, which folds these back in.
  let stepError: string | undefined;
  let expectedErrors = ctx.lastExpectedErrors;
  let expectedErrorsChanged = false;
  let withdrawStateOut: WithdrawState | undefined;
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
    ...(expectedErrorsChanged ? { expectedErrors } : {}),
    ...(withdrawStateOut !== undefined ? { withdrawState: withdrawStateOut } : {}),
    ...(venueChanged ? { venueState } : {}),
  });

  /**
   * Ticket 12: runs one expected-error-prone send. On success, clears any
   * repeat count for `key`. On an `AccountNotInitialized` race, `alreadyGone`
   * runs (closing the local bookkeeping the same way a confirmed send would)
   * and the attempt is treated as done. On any other member of
   * `EXPECTED_ERRORS`, the repeat count for `key` goes up; the third time,
   * it escalates into `stepError` instead of being swallowed again. Anything
   * else is a real failure (ticket 06): recorded as `stepError` immediately.
   * Either way, throwing is never how this reports a failure — the caller
   * falls through to the next step.
   */
  async function attempt(
    key: string,
    send: () => Promise<void>,
    alreadyGone: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await send();
      if (expectedErrors.has(key)) {
        const next = new Map(expectedErrors);
        next.delete(key);
        expectedErrors = next;
        expectedErrorsChanged = true;
      }
      return true;
    } catch (cause) {
      const message = errorMessage(cause);
      if (message === "AccountNotInitialized") {
        await alreadyGone();
        return true;
      }
      if (EXPECTED_ERRORS.has(message)) {
        const count = (expectedErrors.get(key) ?? 0) + 1;
        const next = new Map(expectedErrors);
        next.set(key, count);
        expectedErrors = next;
        expectedErrorsChanged = true;
        if (count >= EXPECTED_ERROR_REPEAT_LIMIT) {
          stepError = stepError ?? `${key} failed ${count} times in a row: ${message}`;
        }
        return false;
      }
      stepError = stepError ?? `${key} failed: ${message}`;
      return false;
    }
  }

  // 1. Round: an Open round past its close asks for randomness, the same
  // instant `buy_position` starts refusing (program §2.3); Requested and
  // fulfilled settles; Requested past `vrf_timeout` voids. Runs first so a
  // Round can never straddle the boundary step 3 might open next.
  if (openRound) {
    if (openRound.status === ROUND_STATUS.OPEN) {
      // Still Open `vrf_timeout` past its end means every request so far
      // failed to land (ORAO refusing, a dropped transaction): stop retrying
      // and take the program's own exit (beta-launch-fixes ticket 02), or
      // the round holds every Position and no new round opens.
      if (now > openRound.endsAt + pool.vrfTimeout) {
        await ctx.send(await ctx.ix.voidRound(pool, openRound));
        return finish({ action: "void_round" });
      }
      if (now >= openRound.endsAt - pool.closeBuffer) {
        await ctx.send(await ctx.ix.requestRoundRandomness(pool, openRound));
        return finish({ action: "request_round_randomness" });
      }
    }
    if (openRound.status === ROUND_STATUS.REQUESTED) {
      if (await ctx.fulfilled(openRound.vrfSeed)) {
        await ctx.send(await ctx.ix.settleRound(pool, openRound));
        return finish({ action: "settle_round" });
      }
      if (now > openRound.requestedAt + pool.vrfTimeout) {
        await ctx.send(await ctx.ix.voidRound(pool, openRound));
        return finish({ action: "void_round" });
      }
    }
  }

  // 2. Sweep: unsettled Positions on any Round that is Settled, Forfeited or
  // Voided, not just the newest one. Grouped by Round because a batch settles
  // within one Round; one batch, and one Round, per tick, as before. Ticket
  // 06: a failure here (of any kind) is recorded, not thrown, so it never
  // blocks the epoch or round loops below it.
  const sweep = await ctx.unsettledPositions();
  const [firstUnsettled] = sweep;
  if (firstUnsettled) {
    const roundId = firstUnsettled.roundId;
    const batch = sweep
      .filter((position) => position.roundId === roundId)
      .slice(0, BATCH_SIZE);
    const addresses = batch.map((position) => position.address);
    const sent = await attempt(
      `settle_position:${roundId}`,
      async () => {
        await ctx.send(await ctx.ix.settlePositions(pool, roundId, batch));
        // The accounts are closed now, but the indexer can keep (or briefly
        // resurrect) their rows for a few sweeps; tell the context so no
        // later tick resends settle_position and gets AccountNotInitialized.
        await ctx.forgetPositions(addresses);
      },
      () => ctx.forgetPositions(addresses),
    );
    if (sent) return finish({ action: "settle_position" });
  }

  // 2c. Close a terminal Round once nothing settled on it is still owed
  // (ops-and-envs ticket 08): reclaims its rent for the operator.
  // Permissionless on the program side and never refused in shutdown, so
  // this runs whether or not the pool is shut down. Ticket 06: a failure
  // here is recorded, not thrown, same as step 2.
  const [roundToClose] = await ctx.roundsToClose();
  if (roundToClose !== undefined) {
    const sent = await attempt(
      `close_round:${roundToClose}`,
      async () => {
        await ctx.send(await ctx.ix.closeRound(pool, roundToClose));
        // The account is closed now, but the indexer mirrors that off the
        // RoundClosed event asynchronously; tell the context so an immediate
        // next tick does not resend close_round and get AccountNotInitialized.
        ctx.forgetRound(roundToClose);
      },
      async () => ctx.forgetRound(roundToClose),
    );
    if (sent) return finish({ action: "close_round" });
  }

  // 3. Begin Epoch: only once the Round and the sweep above are clear, and
  // the previous Epoch (if any) has actually finished, so no Epoch is ever
  // left two behind. Refused in shutdown, so the epoch loop stops here
  // once the pool is shut down (spec.md "Shutdown").
  // Ticket 05: the Pool's very first begin_epoch (no Epoch yet) waits for
  // LAUNCH_AT, if configured, so deposits can open days before the first
  // Draw without an Epoch existing to reset a bought Ticket. Every later
  // begin_epoch (currentEpoch already exists) is unaffected.
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
  if (
    !pool.shutdown &&
    !pool.jackpotPaused &&
    epochEnded &&
    pool.openRoundId === 0n &&
    previousDone
  ) {
    await ctx.send(await ctx.ix.beginEpoch(pool));
    return finish({ action: "begin_epoch" });
  }

  // 3b. Referral bonuses (ticket 08): once per epoch, right after
  // begin_epoch, credit each qualifying referrer's daily bonus for the
  // epoch that just began, so it counts for the full day. referralGrantsDue
  // computes and records the whole epoch's bonuses the first time it is
  // asked (the ReferralGrant table's own uniqueness makes that idempotent
  // across restarts), then hands back whatever is still unsent; batched the
  // same way step 4 batches registrations. `grant_tickets` is refused in
  // shutdown (ops-and-envs ticket 02), so this stops with the rest of the
  // epoch loop. It is refused while the jackpot is paused too
  // (game-jackpot-pause ticket 02); the grants stay due and go out once the
  // jackpot restarts.
  if (!pool.shutdown && !pool.jackpotPaused && currentEpoch) {
    const grants = await ctx.referralGrantsDue(currentEpoch.epochId);
    if (grants.length > 0) {
      const batch = grants.slice(0, BATCH_SIZE);
      try {
        const signature = await ctx.send(await ctx.ix.grantTickets(pool, batch));
        await ctx.markReferralGrantsSent(
          currentEpoch.epochId,
          batch.map((grant) => grant.referrer),
          signature,
        );
        return finish({ action: "grant_tickets" });
      } catch (cause) {
        if (!capExceeded(cause)) throw cause;
        // referralGrantsDue re-clamps every grant against the freshest
        // Player data it has before handing it back, so this should now
        // only fire on drift the indexer has not caught up with yet (a very
        // recent withdrawal), not the stale-forever case it used to. The
        // error itself does not say which referrer in the batch tripped it,
        // so every one of them is logged with the amount that was tried;
        // ponytail: still one atomic transaction, so all of them wait for
        // the next tick's freshly re-clamped retry rather than just the
        // culprit. Splitting the batch on a repeated failure is the upgrade
        // path if that ever bites in practice.
        ctx.warn(
          `referral bonus grant for epoch ${currentEpoch.epochId} exceeded the on-chain cap ` +
            `for one of [${batch.map((grant) => `${grant.referrer}:${grant.amount}`).join(", ")}]: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
        );
      }
    }
  }

  // 4. The ended epoch goes to the draw. `request_draw` snapshots the Weight
  // tree's total and the jackpot vault, so it sends the epoch straight to
  // Drawing, or rolls it over when it holds no Weight or a prize under
  // `min_jackpot`. Refused in shutdown and while the jackpot is paused, and
  // the tick falls through in both so withdrawals and rounds are not held.
  // `begin_epoch` and `rollover_epoch` are refused too, so an Ended epoch
  // waits out the pause the same way it always did.
  if (
    !pool.shutdown &&
    !pool.jackpotPaused &&
    previousEpoch?.status === EPOCH_STATUS.ENDED
  ) {
    await ctx.send(await ctx.ix.requestDraw(pool, previousEpoch.epochId));
    return finish({ action: "request_draw" });
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

  // 6. Drawn: pay whoever owns the leaf the target landed in. A winner
  // whose token account is frozen or closed cannot be paid at all, so past
  // `payout_timeout` the epoch rolls over instead and the prize stays in the
  // vault for the next draw rather than stranding this epoch forever. Ticket
  // 12: a human (non-House) winner is never rolled over until the
  // drawn-unpaid condition has had `DRAWN_UNPAID_ALERT_SECONDS` to page
  // someone, regardless of how short `payout_timeout` is set.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    const winner = await ctx.winner(previousEpoch);
    const isHouse = winner !== null && winner === pool.house.toBase58();
    const alertHasFired = now > previousEpoch.drawnAt + DRAWN_UNPAID_ALERT_SECONDS;
    const timedOut =
      now > previousEpoch.drawnAt + pool.payoutTimeout && (isHouse || alertHasFired);
    if (winner) {
      try {
        await ctx.send(
          await ctx.ix.payout(pool, previousEpoch.epochId, new PublicKey(winner)),
        );
        return finish({ action: "payout" });
      } catch (cause) {
        if (!cannotPayWinner(cause)) throw cause;
        ctx.warn(
          `payout of epoch ${previousEpoch.epochId} to ${winner} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    if (timedOut) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch));
      return finish({ action: "rollover_epoch" });
    }
    // Retried next tick rather than treated as an error: either the payout
    // will start landing, or no leaf holds the target yet.
  }

  // 6a. Venue cranks (ticket 13): harvest inside the last minutes of the
  // epoch, recall when free idle is under the floor, deploy what sits above
  // the target. All three are permissionless, so a failure is recorded and
  // cooled down but never throws: a failed harvest does not block the draw,
  // and nothing here holds up the withdrawals or rounds below it. The program
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
  // delaying a round, a draw or a payout. A vault too short to cover the
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
    : (await ctx.duePendingWithdrawals(pool.currentEpochId)).filter(
        (entry) => !withdrawStateIn.skipped.has(entry.owner),
      );
  let withdrawShortfall = 0n;
  if (due.length > 0) {
    // Ticket 06: once a batch send has failed, every following tick pays the
    // queue one at a time instead — a single bad owner cannot then block
    // anyone behind them, at the cost of one payout per tick instead of
    // `WITHDRAW_BATCH_SIZE`.
    const batch = withdrawStateIn.singleMode ? due.slice(0, 1) : due.slice(0, WITHDRAW_BATCH_SIZE);
    try {
      await ctx.send(await ctx.ix.processWithdrawals(pool, batch));
      const failures = new Map(withdrawStateIn.failures);
      for (const entry of batch) failures.delete(entry.owner);
      withdrawStateOut = {
        epochId: pool.currentEpochId,
        // Back to batching once a send lands cleanly with nothing left
        // waiting behind it; otherwise keep cranking singly until it does.
        singleMode: withdrawStateIn.singleMode && due.length > batch.length,
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
      } else if (message === "OpenPositions") {
        // A Position is still on the board: step 5 settles it, and a later
        // tick pays. No alert, no failure count and no skip, but one at a
        // time so the owners behind this one are not held by the whole batch.
        // ponytail: an owner whose Position stays open holds the single-mode
        // queue behind them, bounded by how fast step 5 settles it.
        withdrawStateOut = { ...withdrawStateIn, singleMode: true };
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

  // 7. Open the next round, if a whole one still fits in this epoch, and the
  // previous Round's reveal has had time to play: no viewer should see a new
  // countdown while the last Round's laser is still landing.
  // game-jackpot-pause ticket 02: `create_round` is refused under the game
  // pause as well as the global `paused`, so both hold the round loop.
  const lastRound = ctx.lastRound;
  const revealDone =
    lastRound === null ||
    lastRound.status === ROUND_STATUS.VOIDED ||
    now >= lastRound.endsAt + REVEAL_SECONDS;
  if (
    pool.openRoundId === 0n &&
    !pool.paused &&
    !pool.gamePaused &&
    currentEpoch &&
    revealDone
  ) {
    if (now + pool.roundSeconds <= currentEpoch.endsAt) {
      await ctx.send(
        await ctx.ix.createRound(pool, now, now + pool.roundSeconds),
      );
      return finish({ action: "create_round", withdrawShortfall });
    }
    // Ticket 21: the round would end after the epoch does, which `buy_position`
    // refuses. Reported once per epoch, not once per tick.
    const skip =
      ctx.lastRoundSkipEpochId !== currentEpoch.epochId
        ? { roundSkip: { epochId: currentEpoch.epochId, endsAt: currentEpoch.endsAt } }
        : {};
    return finish({ ...NOTHING, withdrawShortfall, ...skip });
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
  // `close_round` resent for a Round a previous, now-restarted process
  // already closed (ops-and-envs ticket 08): the in-memory `forgetRound`
  // memory does not survive a restart, and the indexer's own mirror of
  // `RoundClosed` may not have landed yet either, so `roundsToClose` can
  // still hand back an id whose account is already gone on chain.
  "AccountNotInitialized",
  // `request_draw` resent for an epoch a previous tick already sent to the draw.
  "EpochNotAwaitingDraw",
  "EpochNotDrawing",
  "EpochNotDrawn",
  "EpochNotEnded",
  // A pending withdrawal the Player mirror still shows: either a depositor
  // cranked their own payout first (the UI offers that), or a second
  // request re-stamped `pending_epoch` to the epoch now running.
  "NothingPending",
  "NotPreviousEpoch",
  // `process_withdraw` for a Player whose Position is not settled yet.
  "OpenPositions",
  // The admin's shutdown() landed between this tick's read of `pool.shutdown`
  // and one of the steps it gates confirming (ops-and-envs ticket 02): the
  // gates above make this rare, not impossible, and the next tick reads the
  // now-shut-down pool and stops asking.
  "PoolShutDown",
  // The oracle answered between the tick's read and its void/rollover
  // landing, which is exactly the race the program guard exists for.
  "RandomnessAlreadyFulfilled",
  "RandomnessNotFulfilled",
  "RoundAlreadyOpen",
  "RoundNotEnded",
  "RoundNotOpen",
  "RoundNotRequested",
  "RoundNotSettled",
  "VrfTimeoutNotElapsed",
  "WithdrawalNotDue",
]);
