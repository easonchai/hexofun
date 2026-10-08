/**
 * Phone stake bar view model. Pure derivation so the bar's numbers and copy
 * cannot drift from the control panel's own inputs and cost computation
 * (`stake * tiles`, the same formula `ControlPanel` uses for "PER ROUND" /
 * "TICKETS IN").
 *
 * The closed state is the second between the client clock reaching the open
 * Round's `closeAt` and the server closing it. With no Round open the bar is
 * "editing": the next bet opens one.
 */
import { formatAtomic, formatAtomic2, parseAtomic } from "../lib/money.js";
import { tileCountOf, type Phase, type PositionLike } from "../engine.js";

export type StakeBarState = "editing" | "placed" | "closed";

export interface StakeBarModel {
  state: StakeBarState;
  /** "Tickets per Tile", formatted. */
  ticketsPerTile: string;
  /** Tiles selected (editing/closed) or tiles in the placed Position, formatted. */
  tilesSelected: string;
  /** Total Tickets in, formatted. Matches the panel's own cost computation. */
  ticketsIn: string;
  /** Button label: the phase copy in the closed state, otherwise a call to action. */
  label: string;
}

const CLOSED_LABEL = "REVEALING…";

/** Derives the stake bar's model from the panel's own inputs and the Round phase. */
export function stakeBarModel(
  stakeText: string,
  selected: number[],
  position: PositionLike | null,
  phase: Phase,
  decimals: number,
): StakeBarModel {
  const fmt = (value: bigint): string => formatAtomic2(value, decimals);
  const fmtCount = (count: number): string => formatAtomic(BigInt(count), 0);

  const editingNumbers = (): Omit<StakeBarModel, "state" | "label"> => {
    const stake = parseAtomic(stakeText, decimals) ?? 0n;
    const tiles = Math.max(selected.length, 0);
    return {
      ticketsPerTile: fmt(stake),
      tilesSelected: fmtCount(tiles),
      ticketsIn: fmt(stake * BigInt(tiles)),
    };
  };

  const placedNumbers = (
    active: PositionLike,
  ): Omit<StakeBarModel, "state" | "label"> => {
    const tiles = tileCountOf(active.tiles);
    return {
      ticketsPerTile: fmt(active.stakePerTile),
      tilesSelected: fmtCount(tiles),
      ticketsIn: fmt(active.stakePerTile * BigInt(tiles)),
    };
  };

  if (phase === "locked") {
    return {
      state: "closed",
      ...(position ? placedNumbers(position) : editingNumbers()),
      label: CLOSED_LABEL,
    };
  }

  // One Position per wallet per Round: no top-up, so the bar says what happened.
  if (position) {
    return { state: "placed", ...placedNumbers(position), label: "BET PLACED" };
  }

  return { state: "editing", ...editingNumbers(), label: "DEPLOY" };
}
