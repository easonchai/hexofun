/**
 * What the Ops console says about the pool's venue proposal (venue-switch
 * ticket 03). A pure function of the summary and the clock, so the four
 * states have a test: the read failed or is missing, no proposal, locked,
 * and past the lock.
 */
import type { OpsSummaryDto } from "../api.js";
import { duration, UNAVAILABLE } from "./format.js";

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
