/**
 * Pure round-state derivation over the API's Rounds (off-chain-tickets
 * ticket 18). No React, no I/O: everything here is unit-testable.
 */
import type { LastRoundDto, OpenRoundDto, PositionDto } from "./api.js";

export type Phase =
  | /** no Round is open (paused, epoch tail, or just restarted) */ "idle"
  /** a Round is open: countdown to its close */
  | "mine"
  /** bets are shut, no countdown: past the close before the server closes the Round, or an earlier Round still waits on its beacon */
  | "locked";

/** The open Round, with its close as unix seconds on the server's clock. */
export interface OpenRound {
  roundId: bigint;
  closeAt: bigint;
  /** Tickets staked on each tile, 36 of them. */
  tileTotals: bigint[];
}

export type ResultStatus = Exclude<LastRoundDto["status"], "open">;

/** The newest Round that is no longer open. */
export interface ResultRound {
  roundId: bigint;
  status: ResultStatus;
  /** Protocol tile 0..35 once settled. */
  tile: number | null;
}

export interface PositionLike {
  tiles: bigint;
  stakePerTile: bigint;
}

/** `/state`'s open Round → the engine's, or null on an idle board. */
export function openRoundFrom(dto: OpenRoundDto | null): OpenRound | null {
  if (dto === null || dto.status !== "open") return null;
  return {
    roundId: BigInt(dto.id),
    closeAt: BigInt(Math.floor(Date.parse(dto.closeAt) / 1000)),
    tileTotals: dto.tileTotals.map((total) => BigInt(total)),
  };
}

/** `/state`'s newest finished Round → the engine's. */
export function resultRoundFrom(dto: LastRoundDto | null): ResultRound | null {
  if (dto === null || dto.status === "open") return null;
  return { roundId: BigInt(dto.id), status: dto.status, tile: dto.tile };
}

/** The wallet's Positions by Round id, from `/state`. */
export function positionsFrom(dtos: readonly PositionDto[]): Map<string, PositionLike> {
  return new Map(
    dtos.map((dto) => [dto.roundId, { tiles: BigInt(dto.tiles), stakePerTile: BigInt(dto.stakePerTile) }]),
  );
}

/** Identity for a round; round ids are unique per pool. */
export const roundKey = (roundId: bigint): string => roundId.toString();

/**
 * The betting phase follows the open Round's clock. Pass `last` for the board:
 * the engine keeps the next Round open, so a just-closed Round that has no tile
 * yet is "locked" even though the open Round's countdown has not ended.
 */
export function phaseFor(open: OpenRound | null, now: bigint, last: ResultRound | null = null): Phase {
  if (!open) return "idle";
  if (last?.status === "closed") return "locked";
  return now < open.closeAt ? "mine" : "locked";
}

/** What the board says in the timer's spot once betting shuts. */
export type BoardResult = "DRAWING" | null;

/**
 * "DRAWING" from the moment betting shuts until the tile lands. A voided Round
 * shows nothing: its positions just clear. Callers pass `phaseFor(open, now, last)`,
 * so a next Round's countdown returns once the closed Round's tile has landed.
 */
export function boardResult(
  phase: Phase,
  open: OpenRound | null,
  last: ResultRound | null,
): BoardResult {
  if (phase === "mine") return null;
  if (open || last?.status === "closed" || last?.status === "revealed") return "DRAWING";
  return null;
}

/** Seconds until the open Round closes, during "mine"; zero otherwise. */
export function secondsLeft(open: OpenRound | null, now: bigint): bigint {
  return open && phaseFor(open, now) === "mine" ? open.closeAt - now : 0n;
}

/** The pot of the open Round: every tile's stake, added up. */
export const potOf = (open: OpenRound | null): bigint =>
  open ? open.tileTotals.reduce((sum, total) => sum + total, 0n) : 0n;

/** The longest a Round runs: opened one second past a minute, it closes at the minute after next. */
export const longestRoundSeconds = (roundSeconds: bigint): bigint => 2n * roundSeconds - 1n;
/** Reveal lag the epoch-tail rule leaves room for, on top of the longest Round. */
export const REVEAL_ALLOWANCE_SECONDS = 60n;

/**
 * What the empty board says while no Round is open. No epoch yet means the
 * pool is new and nothing has started, whatever the game switch says.
 * Otherwise the game switch decides, then the epoch tail: a Round the epoch
 * cannot hold, with its reveal, is refused, so the label counts down to the
 * epoch end and goes away when the next epoch begins. Anything else is blank:
 * the engine keeps a Round open, and a bet opens one if it is not.
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
  const tail = longestRoundSeconds(roundSeconds) + REVEAL_ALLOWANCE_SECONDS;
  if (epochEndsAt !== null && now + tail > epochEndsAt) {
    const left = epochEndsAt > now ? epochEndsAt - now : 0n;
    return `ROUND CLOSED, NEW DAY STARTS IN ${left}S`;
  }
  return null;
}

/** What the reveal choreography should do right now for the remembered result. */
export type RevealDecision = "fire" | "wait" | "nothing";

/**
 * Pure reveal-firing rule: no timers, no refs. `remembered` is the first
 * settled result the engine ever saw for this id, kept independent of
 * whatever Round `/state` currently calls the last one.
 *
 * - No remembered result yet → "wait" (nothing to fire).
 * - The Round is already in `played` → "nothing" (never re-animate it).
 * - Otherwise "fire" now: the result arriving is the cue.
 */
export function decideReveal(
  remembered: ResultRound | null,
  played: ReadonlySet<string>,
): RevealDecision {
  if (!remembered) return "wait";
  if (played.has(roundKey(remembered.roundId))) return "nothing";
  return "fire";
}

export const covers = (mask: bigint, tile: number): boolean =>
  ((mask >> BigInt(tile)) & 1n) === 1n;

/** Tiles in a Position's mask. */
export const tileCountOf = (mask: bigint): number => mask.toString(2).replace(/[^1]/g, "").length;

/** Tile indices (0..35) of a mask, ascending: the order the bet text lists them. */
export const tilesOfMask = (mask: bigint): number[] =>
  Array.from({ length: 36 }, (_, tile) => tile).filter((tile) => covers(mask, tile));

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
 * Whether auto-rounds should re-place the remembered board. Pure: no I/O, no
 * React state. With no Round open the bet opens the next one, so only the
 * moment betting is shut skips.
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
  if (phase === "locked")
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
