/**
 * Pure round-state derivation mirroring the program's enums. No React, no
 * chain I/O — everything here is unit-testable.
 */

export const ROUND_OPEN = 0;
export const ROUND_REQUESTED = 1;
export const ROUND_SETTLED = 2;
export const ROUND_FORFEITED = 3;
export const ROUND_VOIDED = 4;

export type Phase =
  | /** no round exists yet */ "idle"
  /** positions open: countdown to the close */
  | "mine"
  /** positions closed, before ends_at: the draw is in flight, no countdown */
  | "locked"
  /** past ends_at, not yet revealed: still drawing */
  | "settling"
  /** settled, forfeited or voided; waiting for the next round to open */
  | "awaiting";

export interface RoundLike {
  roundId: bigint;
  epochId: bigint;
  startsAt: bigint;
  endsAt: bigint;
  status: number;
  winningTile: number;
  pot: bigint;
  /** Tickets the House took from the pot at settlement; 0 until then. */
  houseCut: bigint;
  tileTotals: bigint[];
}

export interface PositionLike {
  tiles: bigint;
  stakePerTile: bigint;
}

/** Identity for a round; round ids are unique per pool. */
export const roundKey = (roundId: bigint): string => roundId.toString();

/** Positions stop `buffer` seconds before the round's ends_at. */
export function buyClosesAt(round: RoundLike, bufferSeconds: bigint): bigint {
  const close = round.endsAt - bufferSeconds;
  return close > round.startsAt ? close : round.startsAt;
}

export function phaseFor(
  round: RoundLike | null,
  now: bigint,
  bufferSeconds: bigint,
): Phase {
  if (!round) return "idle";
  // The clock decides first. A round Settled before ends_at stays "locked"
  // so the stage keeps its core while the reveal plays; "awaiting" only
  // starts at ends_at, which is also when the operator opens the next round.
  if (now < buyClosesAt(round, bufferSeconds)) return "mine";
  if (now < round.endsAt) return "locked";
  if (isRevealed(round) || round.status === ROUND_VOIDED) return "awaiting";
  return "settling";
}

/**
 * What the empty board says while no round is open (game-jackpot-pause 03).
 * No epoch yet means the pool is new and nothing has started, whatever the
 * game switch says: the operator opens no round before epoch 1. Otherwise
 * the game switch decides. Null means "nothing to say", so the board shows
 * its ordinary waiting state.
 *
 * `epochEndsAt` and `roundSeconds` add the last case (yield-claimer ticket
 * 21): a round that would end after the epoch does is never opened, so the
 * last `roundSeconds` of an epoch have no round to show. The label counts
 * down to the epoch end and goes away when the next epoch begins, because
 * the new epoch's end is a whole round away again.
 */
export function idleBoardLabel(
  roundOpen: boolean,
  epochStarted: boolean,
  gamePaused: boolean,
  now: bigint = 0n,
  epochEndsAt: bigint | null = null,
  roundSeconds: bigint = 0n,
): string | null {
  if (roundOpen) return null;
  if (!epochStarted) return "STARTS SOON";
  if (gamePaused) return "GAME PAUSED";
  if (epochEndsAt !== null && now + roundSeconds > epochEndsAt) {
    const left = epochEndsAt > now ? epochEndsAt - now : 0n;
    return `ROUND CLOSED, NEW DAY STARTS IN ${left}S`;
  }
  return null;
}

/** True once the round has a winning tile the program will pay against. */
export const isRevealed = (round: RoundLike): boolean =>
  round.status === ROUND_SETTLED || round.status === ROUND_FORFEITED;

/** What the reveal choreography should do right now for the remembered round. */
export type RevealDecision = "fire" | "wait" | "nothing";

/**
 * Pure reveal-firing rule: no timers, no refs. `remembered` is the first
 * revealed (Settled or Forfeited) Round the engine ever saw for this id,
 * kept independent of whatever Round the chain read currently returns.
 *
 * - No remembered result yet → "wait" (nothing to fire).
 * - The Round is already in `played` → "nothing" (never re-animate it).
 * - Otherwise "fire" now: the result arriving is the cue. The countdown ends
 *   at the close, so there is no zero to hold the laser for.
 */
export function decideReveal(
  remembered: RoundLike | null,
  played: ReadonlySet<string>,
): RevealDecision {
  if (!remembered) return "wait";
  if (played.has(roundKey(remembered.roundId))) return "nothing";
  return "fire";
}

export const covers = (mask: bigint, tile: number): boolean =>
  ((mask >> BigInt(tile)) & 1n) === 1n;

/**
 * Round reward in Tickets: (pot − House cut) × stake / staked-on-winning-tile,
 * floored. Only runs on settled rounds, so the stored cut is always present.
 */
export function expectedReward(
  round: RoundLike,
  position: PositionLike,
): bigint {
  if (round.status !== ROUND_SETTLED) return 0n;
  if (!covers(position.tiles, round.winningTile)) return 0n;
  const winningTotal = round.tileTotals[round.winningTile] ?? 0n;
  if (winningTotal === 0n) return 0n;
  return ((round.pot - round.houseCut) * position.stakePerTile) / winningTotal;
}

/**
 * Seconds until positions close, counting down through "mine" only. Zero in
 * every other phase: once locked, the draw is in flight and its length is
 * the oracle's, not the clock's, so there is nothing honest to count.
 */
export function secondsLeft(
  round: RoundLike,
  bufferSeconds: bigint,
  now: bigint,
): bigint {
  if (phaseFor(round, now, bufferSeconds) !== "mine") return 0n;
  return buyClosesAt(round, bufferSeconds) - now;
}

/** Display number 1..36 for a protocol tile index 0..35. */
export const displayTile = (tile: number): number => tile + 1;

/** MM:SS for the Syncopate timer. */
export function timerText(seconds: bigint): string {
  const total = Number(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(Math.min(59, total % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * HH:MM for a duration longer than a round: epoch countdowns and the
 * Vault's "unlocks in" note. Floors to the minute; negative (already past)
 * clamps to 00:00 rather than showing a sign.
 */
export function hmText(seconds: bigint): string {
  const total = seconds > 0n ? seconds : 0n;
  const hh = total / 3600n;
  const mm = (total % 3600n) / 60n;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

/**
 * [DD, HH, MM, SS] for the landing's draw clock. Negative (already
 * past) clamps to all zeros. Days are not capped at two digits.
 */
export function dhmsParts(seconds: bigint): [string, string, string, string] {
  const total = seconds > 0n ? seconds : 0n;
  const pad = (n: bigint): string => n.toString().padStart(2, "0");
  return [
    pad(total / 86400n),
    pad((total % 86400n) / 3600n),
    pad((total % 3600n) / 60n),
    pad(total % 60n),
  ];
}

/** The tiles + uniform stake remembered from the last manual deploy. */
export interface RememberedBoard {
  tiles: number[];
  stake: bigint;
}

export type AutoRoundDecision =
  | { action: "place"; tiles: number[]; stake: bigint }
  | { action: "skip"; reason: string };

/**
 * Whether auto-rounds should re-place the remembered board in a freshly
 * opened Round. Pure: no chain I/O, no React state.
 */
export function decideAutoRound(
  board: RememberedBoard | null,
  tickets: bigint,
  phase: Phase,
  hasPosition: boolean,
): AutoRoundDecision {
  if (!board) return { action: "skip", reason: "no remembered board" };
  if (board.tiles.length === 0)
    return { action: "skip", reason: "remembered board has no tiles" };
  if (board.stake <= 0n)
    return { action: "skip", reason: "remembered stake is zero" };
  if (hasPosition)
    return { action: "skip", reason: "position already placed this round" };
  if (phase !== "mine")
    return { action: "skip", reason: "round is not open for positions" };
  const spend = board.stake * BigInt(board.tiles.length);
  if (spend > tickets)
    return { action: "skip", reason: "stake exceeds Tickets" };
  return { action: "place", tiles: board.tiles, stake: board.stake };
}

export interface FeedRow {
  key: string;
  /** Short address label; "You" when it is the connected wallet. */
  who: string;
  /** Orange gain column, e.g. Tickets staked or "+reward". */
  action: string;
  tileLabel: string;
  /**
   * Round this row is about, set only for a RoundSettled or a rewarded
   * PositionSettled row — the only rows the activity feed ever holds for a
   * reveal. Absent on every other row, which is how the hold predicate knows
   * to never hold it.
   */
  roundId?: string;
}
