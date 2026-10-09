/**
 * Money-path helpers. Everything is bigint atomic units; decimals come from the
 * pool's accepted-mint decimals. No floats ever touch these code paths.
 */

/** Render atomic units as a decimal string with `decimals` places. */
export function formatAtomic(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  if (decimals === 0) {
    return negative ? `-${digits}` : digits;
  }
  if (digits.length <= decimals) {
    return `${negative ? "-" : ""}0.${digits.padStart(decimals, "0")}`;
  }
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Render atomic units truncated (never rounded) to two decimal places, for
 * display. `1999970000` @ 6dp -> "1999.97", never "1999.98". Inputs, and
 * anything the app writes into one, use `formatAtomic` at full precision
 * instead — truncating those would make the parsed value lossy.
 */
export function formatAtomic2(value: bigint, decimals: number): string {
  const full = formatAtomic(value, decimals);
  const negative = full.startsWith("-");
  const unsigned = negative ? full.slice(1) : full;
  const dot = unsigned.indexOf(".");
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const frac = dot === -1 ? "" : unsigned.slice(dot + 1);
  const twoPlaces = `${frac}00`.slice(0, 2);
  return `${negative ? "-" : ""}${whole}.${twoPlaces}`;
}

/**
 * `formatAtomic2` with thousands separators in the whole part, for display
 * only: "1999.97" -> "1,999.97". Never feed the result back into a parser.
 */
export function formatMoney2(value: bigint, decimals: number): string {
  const text = formatAtomic2(value, decimals);
  const dot = text.indexOf(".");
  const whole = text.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}${text.slice(dot)}`;
}

/**
 * Keep typed amount text to digits, one dot and at most `places` decimals.
 * "12.3456" -> "12.34", "1.2.3" -> "1.23", "abc" -> "".
 */
export function clampDecimals(text: string, places: number): string {
  const clean = text.replace(/[^0-9.]/g, "");
  const dot = clean.indexOf(".");
  if (dot === -1) return clean;
  const whole = clean.slice(0, dot);
  const frac = clean.slice(dot + 1).replace(/\./g, "").slice(0, places);
  return `${whole}.${frac}`;
}

/** Parse user-entered decimal text into atomic units. Null when invalid. */
export function parseAtomic(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const raw = text.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const dot = raw.indexOf(".");
  const whole = dot === -1 ? raw : raw.slice(0, dot);
  const frac = dot === -1 ? "" : raw.slice(dot + 1);
  // Reject precision the mint cannot represent: "1.0005" at 3 decimals is lossy.
  if (frac.length > decimals) return null;
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Render a compact label for an address (first4…last4). */
export function formatAddress(address: string): string {
  return address.length <= 12
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** `current + step`, held at `cap` when one is given (the Vault's quick pills). */
export function addCapped(current: bigint, step: bigint, cap: bigint | null): bigint {
  const next = current + step;
  return cap !== null && next > cap ? cap : next;
}

/**
 * The Vault card's Yield line: the yield earned since the last settle as
 * two-decimal text, or null (no line) at 0 or while the read is unknown.
 */
export function unsettledYieldLine(atomic: string | undefined, decimals: number): string | null {
  if (atomic === undefined || BigInt(atomic) <= 0n) return null;
  return formatAtomic2(BigInt(atomic), decimals);
}

/**
 * The balance card's EARNINGS line. Null is the backend saying its events lag
 * the Player row, so any figure would be wrong: a dash, never "+$0.00".
 */
export function earningsLine(atomic: string | null, decimals: number): string {
  return atomic === null ? "—" : `+$${formatMoney2(BigInt(atomic), decimals)}`;
}

/**
 * The part of Principal that earns no Ticket yet: the deposit made in
 * `depositEpoch` while that epoch is still current, nothing once a later one
 * has begun.
 */
export function pendingTickets(
  pendingDeposit: bigint,
  depositEpoch: bigint | null,
  currentEpoch: bigint | null,
): bigint {
  const folded = depositEpoch !== null && currentEpoch !== null && depositEpoch < currentEpoch;
  return folded ? 0n : pendingDeposit;
}

/**
 * How `request_withdraw(amount)` splits (ADR 0020). The part up to the pending
 * deposit never held a Ticket, so it refunds in the same transaction. The rest
 * queues, stays in today's draw and pays after the epoch ends. Same
 * `min(amount, pending_deposit)` the program takes.
 */
export function splitWithdraw(
  amount: bigint,
  pendingDeposit: bigint,
): { payNow: bigint; queued: bigint } {
  const payNow = amount < pendingDeposit ? amount : pendingDeposit;
  return { payNow, queued: amount - payNow };
}

/**
 * Where a requested withdrawal stands, for the Vault's pending row.
 *
 * `pending` waits out the epoch it was requested in. `due` is past that
 * boundary, so `process_withdraw` will go through and the screen offers the
 * button. `processing` covers the gap between sending that transaction and
 * the read model catching up, which is when a second click would only fail
 * with `NothingPending`.
 */
export type PendingWithdrawal =
  | { kind: "none" }
  | { kind: "pending" | "due" | "processing"; amount: bigint; epoch: bigint };

/**
 * `shutdown` (ticket 11): `process_withdraw` skips the epoch-lock check
 * while the pool is shut down (custody.rs), so a pending amount is due the
 * moment it exists, whatever epoch it was requested in.
 */
export function pendingWithdrawal(
  amount: bigint,
  pendingEpoch: bigint,
  currentEpoch: bigint | null,
  payoutSent: boolean,
  shutdown: boolean,
): PendingWithdrawal {
  if (amount <= 0n) return { kind: "none" };
  if (payoutSent) return { kind: "processing", amount, epoch: pendingEpoch };
  // An unknown current epoch (backend unreachable) reads as not yet due: the
  // button would only fail with WithdrawalNotDue.
  const due = shutdown || (currentEpoch !== null && currentEpoch > pendingEpoch);
  return { kind: due ? "due" : "pending", amount, epoch: pendingEpoch };
}

/**
 * `cancel_withdraw` only clears the queued flag, so it works until a payout is
 * in flight. `processing` is the one state where it would race that payout.
 */
export const canCancelWithdraw = (p: PendingWithdrawal): boolean =>
  p.kind === "pending" || p.kind === "due";

/** The program refuses `deposit` while the pool is paused or impaired. */
export const depositOpen = (paused: boolean, impaired: boolean): boolean => !paused && !impaired;

/**
 * What `process_withdraw` pays for `amount` while the pool is impaired: the
 * pool's haircut share, rounded down. `factor` is the API's `haircutFactor`
 * (0 to 1), null when the pool is whole, which pays the full amount.
 */
export function haircutValue(amount: bigint, factor: number | null): bigint {
  if (factor === null || factor >= 1) return amount;
  const parts = BigInt(Math.floor(Math.max(factor, 0) * 1_000_000));
  return (amount * parts) / 1_000_000n;
}
