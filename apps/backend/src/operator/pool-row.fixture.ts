// The operator's tests stand in for the indexer, which is what writes Pool
// rows in production. Every pool-scoped row the operator reads or writes
// references one (ADR 0016), so a test needs the row to exist first. The
// operator never reads the Pool row's own fields, hence the placeholders.
import type { PrismaService } from "../prisma/prisma.service";

/** Inserts if missing, never deletes: a Pool row is never deleted (onDelete
 *  Restrict from every child table), and a leftover row is harmless to other
 *  runs. `skipDuplicates` is ON CONFLICT DO NOTHING, so test files that run
 *  in parallel against the same database cannot race on the insert the way
 *  `upsert`'s read-then-create can. */
export async function ensurePoolRow(
  prisma: PrismaService,
  address: string,
  poolId: bigint,
): Promise<void> {
  const row = {
    address,
    poolId,
    admin: address,
    operator: address,
    mint: address,
    epochSeconds: 86_400n,
    epochAnchor: 0n,
    minDeposit: 0n,
    paused: false,
    currentEpochId: 0n,
    currentEpochEndsAt: 0n,
    previousEpochEndsAt: 0n,
    totalPrincipal: 0n,
    pendingWithdrawals: 0n,
    minJackpot: 0n,
    baseRateBps: 0,
    version: 1,
    shutdown: false,
    updatedSlot: 0n,
  };
  await prisma.pool.createMany({ data: [row], skipDuplicates: true });
}
