/**
 * Ticket 11 (ops-and-envs): `Pool.shutdown` is irreversible (spec.md). Once
 * true the program refuses `deposit`, `buy_tickets`, `grant_tickets`,
 * `create_round`, `buy_position`, `begin_epoch`
 * and `draw`, and `process_withdraw` skips the epoch lock so a
 * request and its payout can land in one transaction (custody.rs). This file
 * is the one place that decides what a shut-down pool looks like in the UI,
 * so the banner, the vault and the buy-tickets widget all read the same text
 * off `GET /status`'s `shutdown` flag instead of re-deriving it.
 */

/** Shown once, at the top of the app, while the pool is shut down. */
export const SHUTDOWN_BANNER =
  "This pool is closed. Withdraw anytime, it pays out immediately.";

/** Short form for whatever a shutdown disables: deposit, buy tickets, the game board. */
export const SHUTDOWN_REASON = "pool is closed";

export type ShutdownWithdrawStep =
  | { kind: "none" }
  | { kind: "process-only" }
  | { kind: "request-and-process"; amount: bigint };

/**
 * What `shutdownWithdraw` (actions.ts) sends. `request_withdraw` refuses a
 * zero amount (`ZeroAmount`), so a Player with nothing new to request but an
 * earlier pending balance sends `process_withdraw` alone; one with neither
 * has nothing to sign.
 */
export function shutdownWithdrawStep(
  requestAmount: bigint,
  pendingWithdraw: bigint,
): ShutdownWithdrawStep {
  if (requestAmount > 0n) {
    return { kind: "request-and-process", amount: requestAmount };
  }
  if (pendingWithdraw > 0n) return { kind: "process-only" };
  return { kind: "none" };
}
