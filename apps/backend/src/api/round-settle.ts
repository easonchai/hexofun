// Tile derivation and settle math for a Round, pure and DB-free
// (off-chain-tickets ticket 17, spec "Round lifecycle" and "Settle", research 03).
import { createHash } from "node:crypto";

import { TILE_COUNT } from "./bet";

const BPS_DENOMINATOR = 10_000n;
const U32 = 2 ** 32;
/** Rejection bound: a u32 at or above this is redrawn so `u32 mod 36` is uniform. */
const REJECT_AT = U32 - (U32 % TILE_COUNT);
const TILE_DOMAIN = "hexvault/round/v1";

/**
 * `sha256("hexvault/round/v1" || seed || signature || roundId_le_u64 || ctr_le_u32)`,
 * first four bytes read little-endian like the other integers in the preimage;
 * `ctr` counts from 0 and bumps while the sample falls in the rejected tail.
 */
export function deriveTile(seed: Buffer, signature: Buffer, roundId: bigint): { tile: number; ctr: number } {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(roundId);
  for (let ctr = 0; ; ctr++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(ctr);
    const x = createHash("sha256").update(TILE_DOMAIN).update(seed).update(signature).update(id).update(counter).digest();
    const sample = x.readUInt32LE(0);
    if (sample < REJECT_AT) return { tile: sample % TILE_COUNT, ctr };
  }
}

export interface SettlePosition {
  owner: string;
  /** 36-bit mask, bit n set for tile n. */
  tiles: bigint;
  stakePerTile: bigint;
  /** An EpochBegan reset already gave this stake back (ADR 0020), so the settle must not. */
  restored: boolean;
}

export interface SettleRow {
  owner: string;
  reason: "reward" | "refund" | "house_credit";
  delta: bigint;
}

export const tileCount = (mask: bigint): bigint => {
  let n = 0n;
  for (let m = mask; m > 0n; m >>= 1n) n += m & 1n;
  return n;
};

const covers = (mask: bigint, tile: number): boolean => ((mask >> BigInt(tile)) & 1n) === 1n;

/** The Round's pot: every Position's tiles times its stake. */
export const potOf = (positions: readonly SettlePosition[]): bigint =>
  positions.reduce((sum, p) => sum + tileCount(p.tiles) * p.stakePerTile, 0n);

/**
 * Ledger rows for a revealed Round. A covering Position gets its stake on the
 * tile plus its pro-rata share of the losers' pot after the House cut (just the
 * share when a reset already returned the stake). The House gets the cut, plus
 * the few Tickets lost to rounding the shares down, so the rows add up to the
 * pot; a tile nobody covered forfeits the whole pot to the House, uncut.
 */
export function settleRows(
  positions: readonly SettlePosition[],
  tile: number,
  houseCutBps: number,
  house: string,
): { houseCut: bigint; rows: SettleRow[] } {
  const pot = potOf(positions);
  const winners = positions.filter((p) => covers(p.tiles, tile));
  const onTile = winners.reduce((sum, p) => sum + p.stakePerTile, 0n);
  if (onTile === 0n) return { houseCut: 0n, rows: [{ owner: house, reason: "house_credit", delta: pot }] };

  const losersPot = pot - onTile;
  const houseCut = (losersPot * BigInt(houseCutBps)) / BPS_DENOMINATOR;
  const payable = losersPot - houseCut;
  const shares = winners.map((p) => (payable * p.stakePerTile) / onTile);
  const rows: SettleRow[] = winners.map((p, i) => ({
    owner: p.owner,
    reason: "reward",
    delta: p.restored ? shares[i]! : p.stakePerTile + shares[i]!,
  }));
  const toHouse = houseCut + payable - shares.reduce((sum, s) => sum + s, 0n);
  if (toHouse > 0n) rows.push({ owner: house, reason: "house_credit", delta: toHouse });
  return { houseCut, rows };
}

/** A void refunds every stake whole, no cut; a stake a reset already returned books nothing. */
export function voidRows(positions: readonly SettlePosition[]): SettleRow[] {
  return positions
    .filter((p) => !p.restored)
    .map((p) => ({ owner: p.owner, reason: "refund", delta: tileCount(p.tiles) * p.stakePerTile }));
}
