// The Rounds half of `GET /state` (off-chain-tickets ticket 16, board fields
// from ticket 18): the open Round, the newest finished one, the wallet's own
// Positions in both, and the id the next Round will take. Takes a Prisma client
// so `getState` can read it inside its own snapshot transaction.
import type { Prisma, RoundStatus } from "@prisma/client";

import { VOID_AFTER_MS } from "./drand";

/** A settled Round shows as the result this long after its `closeAt`. */
export const LAST_ROUND_WINDOW_S = 120;

export interface RoundStateView {
  /** One past the pool's newest Round id: the id a bet must name to open a Round. */
  nextRoundId: bigint;
  openRound: {
    id: bigint;
    openAt: Date;
    closeAt: Date;
    status: RoundStatus;
    tileTotals: string[];
    seedCommitment: string;
  } | null;
  /**
   * The newest played (non-empty) Round that is not open. A Round still waiting on its beacon
   * stays until it settles or voids, and a voided one shows for the same
   * window after the void as a settled one does after the reveal, so the board
   * can say "REVEALING" and then "ROUND VOIDED" however long the relays took.
   */
  lastRound: { id: bigint; status: RoundStatus; tile: number | null; seedCommitment: string } | null;
  /** The owner's Positions in `openRound` and `lastRound`; empty without an owner. */
  positions: { roundId: bigint; tiles: bigint; stakePerTile: bigint }[];
}

export async function readRoundState(
  db: Prisma.TransactionClient,
  poolAddress: string,
  now: Date,
  owner?: string,
): Promise<RoundStateView> {
  const since = (seconds: number): Date => new Date(now.getTime() - seconds * 1000);
  const [newest, finished] = await Promise.all([
    db.round.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } }),
    db.round.findFirst({
      where: {
        poolAddress,
        // The engine opens a Round every minute, most of them empty; an empty one is never the result (ADR 0026).
        pot: { gt: 0n },
        OR: [
          { status: "closed" },
          { status: { in: ["revealed", "settled"] }, closeAt: { gte: since(LAST_ROUND_WINDOW_S) } },
          // A void happens `VOID_AFTER_MS` past the beacon's emission, which follows `closeAt`.
          { status: "voided", closeAt: { gte: since(LAST_ROUND_WINDOW_S + VOID_AFTER_MS / 1000) } },
        ],
      },
      orderBy: { id: "desc" },
    }),
  ]);
  const open = newest?.status === "open" ? newest : null;
  const shown = [open?.id, finished?.id].filter((id): id is bigint => id !== undefined);
  const positions =
    owner === undefined || shown.length === 0
      ? []
      : await db.position.findMany({
          where: { poolAddress, owner, roundId: { in: shown } },
          select: { roundId: true, tiles: true, stakePerTile: true },
        });
  return {
    nextRoundId: (newest?.id ?? 0n) + 1n,
    openRound:
      open === null
        ? null
        : {
            id: open.id,
            openAt: open.openAt,
            closeAt: open.closeAt,
            status: open.status,
            tileTotals: open.tileTotals as string[],
            seedCommitment: open.seedCommitment,
          },
    lastRound:
      finished === null
        ? null
        : { id: finished.id, status: finished.status, tile: finished.tile, seedCommitment: finished.seedCommitment },
    positions,
  };
}
