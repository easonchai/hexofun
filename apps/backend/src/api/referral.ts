// Referral qualification math (docs/plan/hexo-referrals ticket 07). Pure and
// DB-free, like invite-code.ts, so the indexer's event-driven aboveSince
// tracker and ticket 08's daily bonus job can both import it without pulling
// in Prisma.
//
// CONTEXT.md "Qualified referral": a wallet whose Referrer is set and whose
// Principal has stayed at or above 50 USDC for the last 7 days without a
// break. Dropping below ends it at once; it restarts from zero.

/** 50 USDC at 6 decimals, the qualify threshold on Principal. */
export const REFERRAL_QUALIFY_PRINCIPAL = 50_000_000n;

/** Default hold period, in seconds, before an above-threshold referee
 *  qualifies. Env override REFERRAL_QUALIFY_SECONDS lets devnet shorten it. */
export const DEFAULT_REFERRAL_QUALIFY_SECONDS = 604_800;

/** What the indexer tracks per referee: the Referral row's own `principal`
 *  and `aboveSince` columns. */
export interface ReferralQualificationState {
  /** The referee's Principal as of the last event this reducer applied. Not
   *  the live Player.principal: kept independently so events processed out
   *  of real-time order (a dip then a restore inside one indexer poll) still
   *  cross the threshold at the right moments instead of collapsing into
   *  whatever Principal happens to be by the time the row is read. */
  principal: bigint;
  /** Unix seconds Principal last crossed up through the threshold, or null
   *  while it is below (or has never been above). */
  aboveSince: bigint | null;
}

/** The four Principal-changing events spec.md "Qualification" lists, with
 *  `InstantWithdrawn` in place of the retired `YieldCredited` (live yield
 *  settles inside the money instructions and emits no event of its own).
 *  Deposited and InstantWithdrawn carry the absolute new Principal; the other
 *  two carry a delta applied to whatever Principal was immediately before. */
export type ReferralPrincipalEvent =
  | { kind: "Deposited"; principal: bigint }
  | { kind: "WithdrawRequested"; amount: bigint }
  | { kind: "InstantWithdrawn"; principal: bigint }
  | { kind: "JackpotPaid"; amount: bigint };

/** The referee's Principal immediately after `event`, given it was
 *  `previous` immediately before. Clamped at 0: the program never lets a
 *  withdrawal request exceed Principal, so a negative result here would only
 *  mean this tracker's own state had already drifted from the chain. */
export function nextPrincipal(previous: bigint, event: ReferralPrincipalEvent): bigint {
  switch (event.kind) {
    case "Deposited":
    case "InstantWithdrawn":
      return event.principal;
    case "WithdrawRequested": {
      const next = previous - event.amount;
      return next > 0n ? next : 0n;
    }
    case "JackpotPaid":
      return previous + event.amount;
  }
}

/**
 * One step of the aboveSince tracker: applies one Principal-changing event
 * and returns the new state. Sets `aboveSince` to `blockTime` the moment
 * Principal crosses up through `REFERRAL_QUALIFY_PRINCIPAL`, clears it the
 * moment Principal drops below, and otherwise leaves it untouched (staying
 * above does not restart the clock). Correct for a dip and a restore inside
 * one indexer poll only when events are applied one at a time, in slot
 * order, which is why this takes a single event rather than a snapshot.
 */
export function applyReferralEvent(
  state: ReferralQualificationState,
  event: ReferralPrincipalEvent,
  blockTime: bigint,
): ReferralQualificationState {
  const principal = nextPrincipal(state.principal, event);
  const above = principal >= REFERRAL_QUALIFY_PRINCIPAL;
  if (above && state.aboveSince === null) {
    return { principal, aboveSince: blockTime };
  }
  if (!above && state.aboveSince !== null) {
    return { principal, aboveSince: null };
  }
  return { principal, aboveSince: state.aboveSince };
}

/** True when `aboveSince` has held for `qualifySeconds` without a break. */
export function isQualified(
  aboveSince: bigint | null,
  now: bigint,
  qualifySeconds: number = DEFAULT_REFERRAL_QUALIFY_SECONDS,
): boolean {
  return aboveSince !== null && now - aboveSince >= BigInt(qualifySeconds);
}

/** Whole days left before a referee qualifies: 0 once qualified, null while
 *  Principal is below the threshold (aboveSince unset, nothing counting
 *  down). Ticket 11 reads this for "days to qualify". */
export function daysToQualify(
  aboveSince: bigint | null,
  now: bigint,
  qualifySeconds: number = DEFAULT_REFERRAL_QUALIFY_SECONDS,
): number | null {
  if (aboveSince === null) return null;
  const remaining = BigInt(qualifySeconds) - (now - aboveSince);
  if (remaining <= 0n) return 0;
  const SECONDS_PER_DAY = 86_400n;
  return Number((remaining + SECONDS_PER_DAY - 1n) / SECONDS_PER_DAY);
}
