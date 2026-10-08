/**
 * Pure buy-tickets rules (docs/plan/hexo-referrals ticket 10): why the buy
 * button is disabled and whether the entry shows at all. The USDC-to-Tickets
 * rate is the backend's Game config now (ADR 0025), so there is no preview
 * here until ticket 24 reads it from `/game/config`. Kept out of Vault.tsx so the designer's
 * restyle doesn't touch any of this.
 */
import { SHUTDOWN_REASON } from "./shutdown.js";

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

/** The line under the allowance while a Pending deposit is not yet locked
 *  Principal, or null with none. */
export const pendingDepositNote = (pendingDeposit: bigint): string | null =>
  pendingDeposit > 0n ? "Your new deposit counts from the next epoch." : null;

/** The Bought Tickets entry shows only when neither the Vercel gate nor the
 *  on-chain pause says no. `onChainPaused` is null until `/pool` answers, and
 *  an unknown pause hides the entry rather than guess. */
export const buyTicketsVisible = (vercelGated: boolean, onChainPaused: boolean | null): boolean =>
  !vercelGated && onChainPaused === false;
