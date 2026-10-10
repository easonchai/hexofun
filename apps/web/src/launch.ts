/**
 * Ticket 05 (deposit-only launch week): pure derivation for the "first draw
 * in" countdown Home, Vault and Dashboard show while `/state`'s `currentEpoch`
 * is null. No React, no chain I/O, so it is unit-testable on its own — see
 * `engine.ts`'s `dhmsParts` for the same split on the regular draw clock.
 */
import type { CurrentEpochDto } from "./api.js";
import { dhmsParts } from "./engine.js";

export interface LaunchCountdown {
  /** Whether `LAUNCH_AT` is configured at all. */
  readonly scheduled: boolean;
  /** Seconds until launch, floored at 0; null when unscheduled or the chain
   *  clock (`now`) is not known yet. */
  readonly remainingSeconds: bigint | null;
}

/** `launchAt` is `/state`'s ISO string (null once an Epoch exists, or when
 *  `LAUNCH_AT` was never configured); `now` is the chain clock, seconds. */
export function launchCountdown(
  launchAt: string | null,
  now: bigint | null,
): LaunchCountdown {
  if (launchAt === null) return { scheduled: false, remainingSeconds: null };
  if (now === null) return { scheduled: true, remainingSeconds: null };
  const launchSeconds = BigInt(Math.floor(Date.parse(launchAt) / 1000));
  const remaining = launchSeconds - now;
  return { scheduled: true, remainingSeconds: remaining > 0n ? remaining : 0n };
}

/** "First draw in DD:HH:MM:SS", "First draw in —" while `now` is unknown, or
 *  "Coming soon" with no `LAUNCH_AT` configured. */
export function launchCountdownLabel(countdown: LaunchCountdown): string {
  if (!countdown.scheduled) return "Coming soon";
  if (countdown.remainingSeconds === null) return "First draw in —";
  return `First draw in ${dhmsParts(countdown.remainingSeconds).join(":")}`;
}

export type PrizeCardState = "launch" | "paused" | "live";

/**
 * Ticket 02 (feature-gates): shared precedence for the Home and Dashboard
 * prize cards. The jackpot gate wins outright, even with a live epoch and
 * `jackpotPaused` false, and lands on the same "launch" branch the
 * deposit-only launch week already renders. Gate unset: no epoch yet is
 * "launch" only while `LAUNCH_AT` is scheduled, so "Coming soon" is reserved
 * for the gate; unscheduled, the screens show the clock at zero instead.
 * With an epoch, the chain's own `jackpotPaused` switch decides.
 */
export function prizeCardState(
  gated: boolean,
  hasEpoch: boolean,
  jackpotPaused: boolean,
  scheduled: boolean,
): PrizeCardState {
  if (gated || (!hasEpoch && scheduled)) return "launch";
  if (!hasEpoch) return "live";
  return jackpotPaused ? "paused" : "live";
}

/**
 * The prize the cards show. Once `request_draw` snapshots the ended epoch's
 * prize it is reserved out of the vault, so the new epoch's live figure drops
 * it; show the drawn-for amount until the draw finishes.
 */
export function prizeShown(epoch: Pick<CurrentEpochDto, "jackpotAmount" | "drawing">): string {
  const drawingFor = epoch.drawing?.jackpotAmount ?? "0";
  return BigInt(drawingFor) > 0n ? drawingFor : epoch.jackpotAmount;
}

/** The draw is running: the program says so, or the clock has run out. */
export function isDrawing(drawing: boolean, remaining: bigint | null): boolean {
  return drawing || (remaining !== null && remaining <= 0n);
}

/**
 * "NEXT DRAW IN" belongs above a countdown: the launch one or the live clock.
 * DRAWING… and DRAW PAUSED have nothing to count to.
 */
export function showsNextDrawLabel(
  state: PrizeCardState,
  drawing: boolean,
  remaining: bigint | null,
): boolean {
  return state === "launch" || (state === "live" && !isDrawing(drawing, remaining));
}
