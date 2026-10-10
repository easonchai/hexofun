/** Board and state-machine helpers mirroring the program's enums and tile encoding. */

export const TILE_COUNT = 36;

/** Parse "1,7,22" into a u64 tile bitmask (tile N = bit N). */
export function tilesToMask(text: string): bigint | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (!/^\d+$/.test(piece)) return null;
    const tile = Number(piece);
    if (tile < 0 || tile >= TILE_COUNT) return null;
    seen.add(tile);
  }
  let mask = 0n;
  for (const tile of seen) mask |= 1n << BigInt(tile);
  return mask;
}

/** Inverse of tilesToMask: bitmask -> sorted tile numbers. */
export function maskToTiles(mask: bigint): number[] {
  const tiles: number[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    if ((mask >> BigInt(tile)) & 1n) tiles.push(tile);
  }
  return tiles;
}

/** Number of set bits in the u64 mask. */
export function popcount(mask: bigint): number {
  let count = 0;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    if ((mask >> BigInt(tile)) & 1n) count += 1;
  }
  return count;
}

/** 6x6 coordinate label, e.g. tile 7 -> "row 2, col 2". */
export function tileGridLabel(tile: number): string {
  const row = Math.floor(tile / 6) + 1;
  const col = (tile % 6) + 1;
  return `row ${row}, col ${col}`;
}

/**
 * A status reaches the UI either as the on-chain u8 (from a decoded account)
 * or as a decimal string (from the API, which serializes integers as strings).
 * This is the one shape the client is deliberately tolerant about.
 */
export type StatusValue = number | string;

export const EPOCH_STATUS = [
  "Open",
  "Ended",
  "Drawing",
  "Drawn",
  "Paid",
  "Rolled over",
] as const;

export const ROUND_STATUS = [
  "Open",
  "Requested",
  "Settled",
  "Forfeited",
  "Voided",
] as const;

/** Label a status given as the u8 index, its decimal string, or its name. */
export function labelStatus(
  table: readonly string[],
  value: StatusValue,
): string {
  if (typeof value === "string") {
    const index = Number(value);
    return Number.isInteger(index) ? (table[index] ?? value) : value;
  }
  return table[value] ?? `unknown (${value})`;
}

export const labelEpochStatus = (value: StatusValue): string =>
  labelStatus(EPOCH_STATUS, value);

export const labelRoundStatus = (value: StatusValue): string =>
  labelStatus(ROUND_STATUS, value);
