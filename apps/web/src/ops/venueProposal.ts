/**
 * What the Ops console says about the pool's venue proposal (venue-switch
 * ticket 03). A pure function of the summary and the clock, so the four
 * states have a test: the read failed or is missing, no proposal, locked,
 * and past the lock.
 */
import type { OpsSummaryDto } from "../api.js";
import { duration, UNAVAILABLE, usdc } from "./format.js";

export type ProposalView =
  | { state: "unavailable" }
  | { state: "none" }
  | {
      state: "locked" | "unlocked";
      kind: string;
      reserve: string;
      /** "in 3 h" while locked, "2 h ago" once past. */
      unlock: string;
      unlocksAt: string;
    };

const KIND_NAMES: Readonly<Record<number, string>> = { 0: "klend", 1: "stub", 2: "kVault" };

export const venueKindName = (kind: number | null | undefined): string =>
  kind == null ? UNAVAILABLE : (KIND_NAMES[kind] ?? `unknown (${kind})`);

/** `nowSeconds` is the viewer's clock; the lock is judged on chain time, so
 *  within a few seconds of the program's own check. The migration button of a
 *  later ticket re-checks on chain. */
export function proposalView(
  summary: Pick<OpsSummaryDto, "venueProposal">,
  nowSeconds: number,
): ProposalView {
  const proposal = summary.venueProposal;
  // An older backend has no field at all: unknown, not "none".
  if (proposal === undefined) return { state: "unavailable" };
  if (proposal === null) return { state: "none" };
  const left = Number(proposal.unlocksAt) - nowSeconds;
  const locked = left > 0;
  return {
    state: locked ? "locked" : "unlocked",
    kind: venueKindName(proposal.venueKind),
    reserve: proposal.klendReserve,
    unlock: locked ? `in ${duration(left)}` : `${duration(-left)} ago`,
    unlocksAt: new Date(Number(proposal.unlocksAt) * 1000).toISOString(),
  };
}

export type DrainAccess = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the connected wallet may call `drain_venue`, as the program will
 * judge it: the Admin and the Operator always, anyone while a proposal is
 * open. The reason is shown beside the disabled button. An older backend with
 * no proposal or operator field gives "unknown", never an allowance.
 */
export function drainAccess(
  summary: Pick<OpsSummaryDto, "venueProposal" | "admin" | "operatorKey">,
  wallet: string | null,
): DrainAccess {
  if (wallet === null) return { allowed: false, reason: "Connect a wallet to drain." };
  if (summary.venueProposal === undefined) {
    return { allowed: false, reason: "Cannot tell whether a venue proposal is open." };
  }
  if (summary.venueProposal !== null) return { allowed: true };
  if (summary.admin == null || summary.operatorKey == null) {
    return { allowed: false, reason: "Cannot tell who the Admin and Operator are." };
  }
  if (wallet === summary.admin || wallet === summary.operatorKey) return { allowed: true };
  return {
    allowed: false,
    reason: "With no venue proposal open, only the Admin or the Operator may drain.",
  };
}

export type MigrateAccess = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether `migrate_venue` would be accepted now, as far as the summary can
 * tell: a proposal is open, its lock has elapsed and the position is at or
 * under `min_venue_move`. Anyone may call it, so no wallet is involved. The
 * program checks again on chain; this only decides whether to offer the
 * button and what to say when it is off.
 */
export function migrateAccess(
  summary: Pick<OpsSummaryDto, "venueProposal" | "venueValue" | "venueParams">,
  nowSeconds: number,
): MigrateAccess {
  const proposal = summary.venueProposal;
  if (proposal === undefined) {
    return { allowed: false, reason: "Cannot tell whether a venue proposal is open." };
  }
  if (proposal === null) return { allowed: false, reason: "No venue proposal is open." };
  const left = Number(proposal.unlocksAt) - nowSeconds;
  if (left > 0) return { allowed: false, reason: `The lock ends in ${duration(left)}.` };
  if (!summary.venueParams) {
    return { allowed: false, reason: "Cannot tell the minimum venue move." };
  }
  if (BigInt(summary.venueValue) > BigInt(summary.venueParams.minVenueMove)) {
    return {
      allowed: false,
      reason: `The old venue still holds ${usdc(summary.venueValue)}. Drain it first.`,
    };
  }
  return { allowed: true };
}

/** `min_venue_move`'s default, 100 USDC: above it, step 3 has not lowered the dust line yet. */
export const DEFAULT_MIN_VENUE_MOVE = 100_000_000n;

/**
 * The venue switch step the pool is on, numbered as runbook.md's "Migration"
 * (1 prepare, 2 propose, 3 lower the dust line, 4 wait out the lock, 5 drain,
 * 6 migrate, 7 resume deploys, 8 restore the dust line). Null when the summary
 * cannot tell. With no proposal and nothing left to finish, 1: the next move
 * is the CLI's.
 */
export function venueStep(
  summary: Pick<OpsSummaryDto, "venueProposal" | "venueValue" | "venueParams" | "deployPaused">,
  nowSeconds: number,
): number | null {
  const view = proposalView(summary, nowSeconds);
  if (view.state === "unavailable" || !summary.venueParams) return null;
  const minMove = BigInt(summary.venueParams.minVenueMove);
  const lowered = minMove < DEFAULT_MIN_VENUE_MOVE;
  if (view.state === "locked") return lowered ? 4 : 3;
  if (view.state === "unlocked") return BigInt(summary.venueValue) > minMove ? 5 : 6;
  if (summary.deployPaused) return 7;
  return lowered ? 8 : 1;
}
