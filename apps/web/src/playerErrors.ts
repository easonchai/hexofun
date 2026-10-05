/**
 * Maps a program error, or a bare Anchor error code, to player-facing copy.
 * Ticket 09 (production-hardening): every screen that used to show
 * `error.message` goes through `decodePlayerError` instead, and ticket 08's
 * send helper will hand `decodeErrorCode` the numeric code from its own
 * `failed(code)` result directly. Copy uses the screen's words (CONTEXT.md):
 * "day" not epoch, "Tickets" not entries.
 */
import { currentPage, reportError } from "./errorReport.js";
import { idl } from "./idl.js";
import {
  INSUFFICIENT_TICKETS_CODE,
  VENUE_ILLIQUID_CODE,
  VENUE_SHORT_RETURN_CODE,
} from "./instantWithdraw.js";

const GENERIC = "Something went wrong. Try again in a moment.";

/** `NothingPending`: the operator's crank already paid this withdrawal. */
export const NOTHING_PENDING_CODE = 6038;

const QUEUE_COPY =
  "The pool can't pay that out instantly right now. Queue it and it pays after the day ends.";

/** Hand-written copy for the codes players actually run into. */
const HAND_WRITTEN: Record<number, string> = {
  6001: "The pool is paused right now. Try again once it reopens.", // PoolPaused
  6003: "Enter an amount greater than zero.", // ZeroAmount
  6005: "You don't have enough Tickets for that.", // InsufficientEntries
  6012: "This round is closed to new plays. Wait for the next one.", // RoundClosed
  6036: "The vault is being topped up. Try the payout again in a few minutes.", // InsufficientVaultLiquidity
  [NOTHING_PENDING_CODE]: "Already paid out. Refreshing your balance.", // NothingPending
  6051: "This pool is closed. Withdrawals still work; nothing else does.", // PoolShutDown
  6058: "The game is paused right now. Try again once it restarts.", // GamePaused
  6059: "The daily draw is paused, so Tickets can't be bought right now.", // JackpotPaused
  6077: "The pool's lending rate is a moment out of date. Try again.", // ReserveStale
  // yield-claimer ticket 16: the instant withdraw's refusals. The form offers
  // the queued request next to the first two, so the copy says so.
  [VENUE_ILLIQUID_CODE]: QUEUE_COPY, // VenueIlliquid
  [VENUE_SHORT_RETURN_CODE]: QUEUE_COPY, // VenueShortReturn
  [INSUFFICIENT_TICKETS_CODE]:
    "Only Tickets you still hold can leave at once. The rest unlocks at the next daily reset, or you can queue it.", // InsufficientTickets
};

const IDL_MESSAGE_BY_CODE = new Map(
  (idl.errors ?? []).map((entry) => [entry.code, entry.msg] as const),
);
const CODE_BY_NAME = new Map(
  (idl.errors ?? []).map((entry) => [entry.name, entry.code] as const),
);
/** Matches a whole error-variant name; word boundaries keep e.g.
 *  `InsufficientVault` from matching inside `InsufficientVaultLiquidity`. */
const NAME_PATTERN = new RegExp(`\\b(${[...CODE_BY_NAME.keys()].join("|")})\\b`);

/** Player copy for a known Anchor error code: hand-written, then the IDL's own message. */
export function decodeErrorCode(code: number): string {
  return HAND_WRITTEN[code] ?? IDL_MESSAGE_BY_CODE.get(code) ?? GENERIC;
}

function firstGroup(pattern: RegExp, text: string): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

/**
 * Pulls an Anchor error code out of a raw error's text: the structured
 * "Error Code: X. Error Number: N." Anchor logs when a `.rpc()` send fails,
 * the `"Custom":N` an RPC simulation result carries, or a bare
 * `custom program error: 0x...`. Returns null when none of those show up,
 * e.g. a network error or a wallet rejection.
 */
function extractCode(text: string): number | null {
  const byNumber = firstGroup(/error number:\s*(\d+)/i, text);
  if (byNumber) return Number(byNumber);
  const byCustom = firstGroup(/"custom":\s*(\d+)/i, text);
  if (byCustom) return Number(byCustom);
  const byHex = firstGroup(/custom program error:\s*0x([0-9a-f]+)/i, text);
  if (byHex) return parseInt(byHex, 16);
  const byName = firstGroup(NAME_PATTERN, text);
  return byName ? (CODE_BY_NAME.get(byName) ?? null) : null;
}

/**
 * What every send path's catch block calls instead of reading
 * `error.message` directly. The raw error still reaches `console.error` for
 * debugging; the player only ever sees the decoded copy.
 */
export function decodePlayerError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  console.error(text);
  const code = extractCode(text);
  return code === null ? GENERIC : decodeErrorCode(code);
}

const EXPIRED_TEXT = "Transaction expired. Try again.";

/**
 * Player copy for `actions.ts`'s `SendResult` once a call site has ruled out
 * `landed` (ticket 08): `expired` gets its own "try again" line, and
 * `failed(code, message)` feeds `code` straight into `decodeErrorCode`,
 * skipping the text-parsing `decodePlayerError` needs for a thrown error.
 * The raw `message` still reaches `console.error` for debugging.
 */
export function decodeSendFailure(
  result: { kind: "expired" } | { kind: "failed"; code: number | null; message: string },
): string {
  if (result.kind === "expired") return EXPIRED_TEXT;
  console.error(result.message);
  // Ticket 16: a landed-but-failed send is a genuinely broken money path,
  // worth reaching the maintainers for; "expired" (a dropped confirmation,
  // the player's answer is "try again") is not.
  reportError({
    code: failureReason(result),
    message: result.message,
    page: currentPage(),
  });
  return decodeErrorCode(result.code ?? -1);
}

/**
 * A short machine code for analytics (posthog-analytics tickets 03/04):
 * `program_error_N`, `expired`, or `unknown_error`. The same shape
 * `reportError` gets, never the raw message.
 */
export function failureReason(
  result: { kind: "expired" } | { kind: "failed"; code: number | null },
): string {
  if (result.kind === "expired") return "expired";
  return result.code === null ? "unknown_error" : `program_error_${result.code}`;
}

/** The Anchor error code inside a thrown error, or null. The Vault reads it to
 *  offer the queued request when an instant withdraw was refused at send. */
export function thrownCode(error: unknown): number | null {
  return extractCode(error instanceof Error ? error.message : String(error));
}

/** `failureReason` for a thrown error, via the same text parsing as `decodePlayerError`. */
export function thrownReason(error: unknown): string {
  const code = extractCode(error instanceof Error ? error.message : String(error));
  return failureReason({ kind: "failed", code });
}
