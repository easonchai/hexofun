// The Rounds half of `GET /state` (off-chain-tickets ticket 16): the open
// Round, the newest finished one, and the id the next Round will take. Takes a
// Prisma client so `getState` can read it inside its own snapshot transaction.
import type { Prisma, RoundStatus } from "@prisma/client";

/** A Round finished (closed, revealed, settled or voided) this recently still shows as the result. */
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
  /** The newest Round that is not open, if it closed within the last two minutes. */
  lastRound: { id: bigint; status: RoundStatus; tile: number | null } | null;
}

export async function readRoundState(
  db: Prisma.TransactionClient,
  poolAddress: string,
  now: Date,
): Promise<RoundStateView> {
  const [newest, finished] = await Promise.all([
    db.round.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } }),
    db.round.findFirst({
      where: {
        poolAddress,
        status: { not: "open" },
        closeAt: { gte: new Date(now.getTime() - LAST_ROUND_WINDOW_S * 1000) },
      },
      orderBy: { id: "desc" },
    }),
  ]);
  return {
    nextRoundId: (newest?.id ?? 0n) + 1n,
    openRound:
      newest?.status === "open"
        ? {
            id: newest.id,
            openAt: newest.openAt,
            closeAt: newest.closeAt,
            status: newest.status,
            tileTotals: newest.tileTotals as string[],
            seedCommitment: newest.seedCommitment,
          }
        : null,
    lastRound: finished === null ? null : { id: finished.id, status: finished.status, tile: finished.tile },
  };
}
