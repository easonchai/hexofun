// The Operator's three venue cranks (yield-claimer ticket 13): deploy idle
// USDC above the idle band, recall when it falls under the floor, and harvest
// once per epoch before it ends. Pure over a fabricated pool, so the
// decisions are tested without a chain; `tick.ts` sends what this picks.
//
// All three are permissionless on the program side and the program enforces
// every limit again (`DeployExceedsIdle`, `RecallExceedsTarget`,
// `VenueMoveTooSmall` and so on). The numbers here only decide when asking is
// worth a transaction, so a rounding difference costs one failed, cooled-down
// attempt and never a wrong transfer.
import { PublicKey } from "@solana/web3.js";

import type { EpochState, PoolState } from "./chain-state";

/** Harvest runs inside this many seconds before `epoch_end`, so the prize
 *  share is in the jackpot vault when `request_draw` snapshots it. */
export const HARVEST_LEAD_SECONDS = 600n;
/** After a crank fails, it is not tried again for this many chain seconds. The
 *  safety tick runs every 60 s, so this is what stops a refused crank from
 *  turning into a send per minute. */
export const VENUE_RETRY_SECONDS = 600n;

const BPS = 10_000n;

export type VenueKind = "deploy" | "recall" | "harvest";

export type VenueCrank =
  | { readonly kind: "deploy"; readonly amount: bigint }
  | { readonly kind: "recall"; readonly amount: bigint }
  | { readonly kind: "harvest" };

/** What the cranks remember between ticks. The service keeps it in memory; a
 *  restart at worst repeats a harvest the program answers with
 *  `NothingToHarvest`, or retries a failed crank a few minutes early. */
export interface VenueState {
  /** The epoch whose pre-end harvest already landed. */
  readonly harvestedEpoch: bigint | null;
  /** Chain time of each crank's last failed attempt. */
  readonly failedAt: Readonly<Partial<Record<VenueKind, bigint>>>;
}

export const EMPTY_VENUE_STATE: VenueState = { harvestedEpoch: null, failedAt: {} };

/** A crank landed (`NothingToHarvest` counts for harvest: nothing was owed). */
export function venueSucceeded(
  state: VenueState,
  kind: VenueKind,
  epochId: bigint | null,
): VenueState {
  const failedAt = { ...state.failedAt };
  delete failedAt[kind];
  return {
    harvestedEpoch: kind === "harvest" && epochId !== null ? epochId : state.harvestedEpoch,
    failedAt,
  };
}

export function venueFailed(state: VenueState, kind: VenueKind, now: bigint): VenueState {
  return { ...state, failedAt: { ...state.failedAt, [kind]: now } };
}

/** Whether `kind` is out of its cool-down. */
export function venueReady(state: VenueState, kind: VenueKind, now: bigint): boolean {
  const failedAt = state.failedAt[kind];
  return failedAt === undefined || now >= failedAt + VENUE_RETRY_SECONDS;
}

/**
 * Program errors a venue crank can hit when the pool moved between the tick's
 * read and its send. They are logged as a warning, not recorded as a tick
 * error; the cool-down in `VenueState` is what keeps them from repeating.
 */
export const VENUE_EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  "BelowPendingWithdrawals",
  "DeployExceedsIdle",
  "DeployPaused",
  "PoolImpaired",
  "PoolShutDown",
  "RecallExceedsTarget",
  "RecallNotNeeded",
  "ReserveLiquidityTooLow",
  "ReserveShareCapExceeded",
  "VenueIlliquid",
  "VenueMoveTooSmall",
  // A venue change is proposed: deploys wait for the Admin to cancel or
  // execute it. Expected, so a warning and a cool-down, not an alert.
  "VenueProposalOpen",
]);

/** An unpinned pool has `Pubkey::default()` for its klend program. */
export const hasVenue = (pool: PoolState): boolean => !pool.klendProgram.equals(PublicKey.default);

/** Free idle: the principal vault less what Pending withdrawals have claimed.
 *  Negative when the vault holds less than is queued. */
export const freeIdle = (pool: PoolState, vaultBalance: bigint): bigint =>
  vaultBalance - pool.pendingWithdrawals;

/** What the idle band is a share of: free idle plus the venue position,
 *  never negative. */
function bandBase(pool: PoolState, vaultBalance: bigint): bigint {
  const total = freeIdle(pool, vaultBalance) + pool.venueValue;
  return total > 0n ? total : 0n;
}

/** The program rounds the target up, so the band is never undershot. */
export function idleTarget(pool: PoolState, vaultBalance: bigint): bigint {
  return (bandBase(pool, vaultBalance) * BigInt(pool.idleTargetBps) + BPS - 1n) / BPS;
}

/**
 * Held back from a deploy. `deploy_to_venue` syncs before it checks the
 * amount, and the sync books the yield earned since `venueValue` was last
 * written, which raises the idle target by the target's share of that gain.
 * An exact-fit amount then fails with DeployExceedsIdle every time once the
 * venue holds anything. 1 bp of the position covers a gain of 0.1% at a 10%
 * target: about a week at a 5% supply rate.
 */
const deployMargin = (pool: PoolState): bigint => pool.venueValue / 10_000n;

function idleFloor(pool: PoolState, vaultBalance: bigint): bigint {
  return (bandBase(pool, vaultBalance) * BigInt(pool.idleFloorBps)) / BPS;
}

/**
 * The recall that brings free idle back up to the target, or null when
 * nothing worthwhile can be recalled. The program takes a recall of at least
 * `min_venue_move`, or exactly the gap between the vault and the queued
 * withdrawals, so a small queued withdrawal can always be made payable. Never
 * more than the venue holds.
 */
export function recallAmount(pool: PoolState, vaultBalance: bigint): bigint | null {
  let amount = idleTarget(pool, vaultBalance) - freeIdle(pool, vaultBalance);
  if (amount > pool.venueValue) amount = pool.venueValue;
  if (amount >= pool.minVenueMove && amount > 0n) return amount;
  const short = pool.pendingWithdrawals > vaultBalance ? pool.pendingWithdrawals - vaultBalance : 0n;
  return short > 0n && short <= pool.venueValue ? short : null;
}

/** Inside the last `HARVEST_LEAD_SECONDS` of the current epoch, once. */
function harvestDue(
  pool: PoolState,
  currentEpoch: EpochState | null,
  now: bigint,
  state: VenueState,
): boolean {
  if (currentEpoch === null || pool.impaired) return false;
  if (state.harvestedEpoch === currentEpoch.epochId) return false;
  if (now < currentEpoch.endsAt - HARVEST_LEAD_SECONDS || now >= currentEpoch.endsAt) return false;
  // `feeOwed` and `prizeOwed` only move at a sync, so a position that has
  // been earning since the last one still counts.
  return pool.venueValue > 0n || pool.feeOwed + pool.prizeOwed > 0n;
}

/** The chain time harvest next becomes due, for the scheduler's deadline, or
 *  null when this epoch is already harvested. */
export function nextHarvestAt(
  currentEpoch: EpochState | null,
  state: VenueState,
): bigint | null {
  if (currentEpoch === null || state.harvestedEpoch === currentEpoch.epochId) return null;
  return currentEpoch.endsAt - HARVEST_LEAD_SECONDS;
}

/**
 * The one venue crank this tick should send, or null. Harvest first, because
 * its window closes; then recall, because an under-floor vault is what makes
 * a refund redeem from the venue; then deploy.
 *
 * Deploy waits out a deploy pause and an impaired venue, and nothing deploys
 * after Shutdown. Recall and harvest stay available then (harvest is refused
 * only while impaired).
 */
export function decideVenue(input: {
  readonly pool: PoolState;
  readonly vaultBalance: bigint;
  readonly now: bigint;
  readonly currentEpoch: EpochState | null;
  readonly state: VenueState;
}): VenueCrank | null {
  const { pool, vaultBalance, now, currentEpoch, state } = input;
  if (!hasVenue(pool)) return null;

  if (venueReady(state, "harvest", now) && harvestDue(pool, currentEpoch, now, state)) {
    return { kind: "harvest" };
  }

  const free = freeIdle(pool, vaultBalance);
  if (venueReady(state, "recall", now) && free < idleFloor(pool, vaultBalance)) {
    const amount = recallAmount(pool, vaultBalance);
    if (amount !== null) return { kind: "recall", amount };
  }

  if (
    venueReady(state, "deploy", now) &&
    !pool.deployPaused &&
    !pool.impaired &&
    !pool.shutdown
  ) {
    const amount = free - idleTarget(pool, vaultBalance) - deployMargin(pool);
    if (amount > 0n && amount >= pool.minVenueMove) return { kind: "deploy", amount };
  }
  return null;
}
