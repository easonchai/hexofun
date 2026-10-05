/**
 * Pure buy-tickets math (docs/plan/hexo-referrals ticket 10): what a USDC
 * purchase is worth in tonight's draw, why the buy button is disabled and
 * whether the entry shows at all. Kept out of Vault.tsx so the designer's
 * restyle doesn't touch any of this.
 */
import { SHUTDOWN_REASON } from "./shutdown.js";

/** `amount × tickets_per_usdc`, mirroring `buy_tickets`' checked multiply. */
export function ticketsFromUsdc(amountAtomic: bigint, ticketsPerUsdc: number): bigint {
  return amountAtomic * BigInt(ticketsPerUsdc);
}

/**
 * What `tickets` bought right now are worth in tonight's draw, as an
 * equivalent count of full-day tickets. The draw selects by Weight (tickets
 * × time held), not by ticket count, so a purchase at day start is worth its
 * full face value and one made in the draw's last minute is worth almost
 * nothing: `tickets × secondsLeft / epochSeconds` (spec.md "Vault").
 */
export function drawValue(
  tickets: bigint,
  secondsLeft: bigint,
  epochSeconds: bigint,
): bigint {
  if (epochSeconds <= 0n || tickets <= 0n) return 0n;
  const clamped =
    secondsLeft <= 0n ? 0n : secondsLeft > epochSeconds ? epochSeconds : secondsLeft;
  return (tickets * clamped) / epochSeconds;
}

/** Why the buy-tickets button is disabled, or null when it can be pressed. */
export function buyDisabledReason(opts: {
  paused: boolean;
  /** ticket 11: `buy_tickets` refuses outright once the pool is shut down. */
  shutdown: boolean;
  principal: bigint;
  allowanceLeft: bigint;
}): string | null {
  if (opts.shutdown) return SHUTDOWN_REASON;
  if (opts.paused) return "pool is paused";
  if (opts.principal <= 0n) return "deposit first";
  if (opts.allowanceLeft <= 0n) return "today's buy allowance is spent";
  return null;
}

/** The Bought Tickets entry shows only when neither the Vercel gate nor the
 *  on-chain pause says no. `onChainPaused` is null until `/pool` answers, and
 *  an unknown pause hides the entry rather than guess. */
export const buyTicketsVisible = (vercelGated: boolean, onChainPaused: boolean | null): boolean =>
  !vercelGated && onChainPaused === false;
