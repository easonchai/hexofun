/**
 * Yield-claimer ticket 16: the withdraw form's instant-or-queued decision, as
 * pure functions so the screen only renders it.
 *
 * `instant_withdraw` pays in one transaction, but only up to
 * min(Principal, Tickets) (the Tickets rule, progress-09), and only when free
 * idle plus the reserve's free liquidity covers it. Anything else goes through
 * `request_withdraw`, which pays after the day ends. While the pool is
 * impaired either path pays a haircut share of the amount (progress-10).
 */

/** `VenueIlliquid`: the reserve cannot cover the gap right now. */
export const VENUE_ILLIQUID_CODE = 6063;
/** `VenueShortReturn`: the redeem came back short. Same answer for the player. */
export const VENUE_SHORT_RETURN_CODE = 6070;
/** `InsufficientTickets`: the instant amount is past what Tickets allow. */
export const INSUFFICIENT_TICKETS_CODE = 6080;

/** True when an instant withdrawal failed for a reason the queued request avoids. */
export const offersQueue = (code: number | null): boolean =>
  code === VENUE_ILLIQUID_CODE || code === VENUE_SHORT_RETURN_CODE || code === INSUFFICIENT_TICKETS_CODE;

export type QueueReason = "over-limit" | "pool-short" | "venue-illiquid";

export interface WithdrawPlan {
  /** "instant" sends `instant_withdraw`; "queued" sends `request_withdraw`. */
  kind: "instant" | "queued";
  /** Why it is queued; null when instant. */
  reason: QueueReason | null;
  /** What the amount is paid as, after the haircut while impaired. */
  receive: bigint;
  /** What the haircut takes; 0 when the pool is not impaired. */
  haircut: bigint;
  /** Tickets left once the withdrawal has run. */
  ticketsAfter: bigint;
}

/** The most an instant withdrawal can take: the smaller of Principal and Tickets. */
export const instantLimit = (principal: bigint, tickets: bigint): bigint =>
  principal < tickets ? principal : tickets;

/** `amount` times the haircut share, floored like the program's own `haircut`. */
export function afterHaircut(amount: bigint, factor: number | null): bigint {
  if (factor === null || factor >= 1) return amount;
  const ppm = BigInt(Math.floor(Math.max(factor, 0) * 1_000_000));
  return (amount * ppm) / 1_000_000n;
}

export interface PlanInput {
  amount: bigint;
  principal: bigint;
  /** Tickets as the program will see them (`effectiveTickets` in lib/money). */
  tickets: bigint;
  /** `/pool?withdraw=` answer for this amount; null when unknown. */
  coverable: boolean | null;
  /** `live.haircutFactor`; null when not impaired. */
  haircutFactor: number | null;
  /** The instant transaction already failed illiquid: stay on the queue. */
  forceQueue: boolean;
}

/**
 * Unknown cover (`coverable` null, the read model unreachable) plans instant:
 * the transaction's own simulation refuses it before anything is signed, and
 * the form then offers the queue.
 */
export function planWithdraw(input: PlanInput): WithdrawPlan {
  const { amount, principal, tickets, coverable, haircutFactor, forceQueue } = input;
  const reason: QueueReason | null =
    amount > instantLimit(principal, tickets)
      ? "over-limit"
      : forceQueue
        ? "venue-illiquid"
        : coverable === false
          ? "pool-short"
          : null;
  const receive = afterHaircut(amount, haircutFactor);
  return {
    kind: reason === null ? "instant" : "queued",
    reason,
    receive,
    haircut: amount - receive,
    // Instant takes `amount` of both (amount <= Tickets); a request takes at most what is held.
    ticketsAfter: tickets > amount ? tickets - amount : 0n,
  };
}
