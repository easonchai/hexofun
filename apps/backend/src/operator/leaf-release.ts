// Which Player's Weight tree leaf the Operator may release this tick
// (mainnet-readiness-fixes 08). The Read model only nominates candidates; the
// decision is made off the Player account on chain, so a stale mirror row can
// never get a live Player's leaf released. The program re-checks everything,
// including the tree's Tickets, so this is a filter, not the safety.
import type { Idl, Program } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";

/** Candidates read from chain per tick. A stale row is skipped, so this only
 *  bounds the work when many mirror rows are stale at once. */
export const RELEASE_CANDIDATES = 10;

/** The Player fields a release depends on, off the account on chain. */
export interface LeafHolder {
  readonly owner: string;
  readonly leafIndex: number;
  readonly isHouse: boolean;
  readonly principal: bigint;
  readonly pendingWithdraw: bigint;
  readonly openPositions: number;
  /** The epoch the Player was last touched in. */
  readonly epochId: bigint;
}

type Decoded = Record<string, { toString(): string } | number | boolean | PublicKey | number[]>;

const big = (value: unknown): bigint => BigInt(String(value));

export function decodeLeafHolder(program: Program<Idl>, owner: string, data: Buffer): LeafHolder {
  const raw = program.coder.accounts.decode<Decoded>("player", data);
  return {
    owner,
    leafIndex: Number(raw.leafIndex),
    isHouse: raw.isHouse === true,
    principal: big(raw.principal),
    pendingWithdraw: big(raw.pendingWithdraw),
    openPositions: Number(raw.openPositions),
    epochId: big(raw.epochId),
  };
}

/**
 * Holds a leaf, owes nothing, has no Position open, and was last touched at
 * least two epochs ago, so neither readable epoch of the tree can still hold
 * Tickets it earned. Never the House.
 */
export function isReleasable(player: LeafHolder, currentEpochId: bigint): boolean {
  return (
    player.leafIndex > 0 &&
    !player.isHouse &&
    player.principal === 0n &&
    player.pendingWithdraw === 0n &&
    player.openPositions === 0 &&
    player.epochId + 2n <= currentEpochId
  );
}

/** The first releasable owner among `players` (null where an account is gone). */
export function firstReleasable(
  players: readonly (LeafHolder | null)[],
  currentEpochId: bigint,
): string | null {
  for (const player of players) {
    if (player !== null && isReleasable(player, currentEpochId)) return player.owner;
  }
  return null;
}
