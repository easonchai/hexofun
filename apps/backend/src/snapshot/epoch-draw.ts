// What the epoch draw reads out of the Epoch snapshot rows (off-chain-tickets
// 12): the commitment `request_draw` sends, and the winner's proof `payout`
// sends. The Operator and `GET /epochs/:id/draw` share it, so the API serves
// exactly what the Operator submits.
import type { PrismaClient } from "@prisma/client";
import bs58 from "bs58";

import { randomNonce } from "../operator/vrf";
import { at, buildSumTree, type SnapshotCommitment, type SumNode } from "./sum-tree";

type Db = Pick<PrismaClient, "epoch" | "epochSnapshot">;

export interface WinnerProof {
  readonly commitment: SnapshotCommitment;
  readonly index: number;
  readonly owner: string;
  readonly tickets: bigint;
  /** Siblings from the leaf up, `commitment.depth` long. */
  readonly siblings: SumNode[];
}

/**
 * The four values `request_draw` commits, or null until the ledger has taken
 * the ended epoch's snapshot (it does so when it books `EpochBegan`). An empty
 * snapshot commits zeros, which the program rolls over.
 */
export async function readCommitment(
  db: Db,
  poolAddress: string,
  epochId: bigint,
): Promise<SnapshotCommitment | null> {
  const epoch = await db.epoch.findUnique({ where: { poolAddress_id: { poolAddress, id: epochId } } });
  if (epoch === null || epoch.leafCount === null) return null;
  return {
    root: epoch.snapshotRoot === null ? Buffer.alloc(32) : Buffer.from(epoch.snapshotRoot, "hex"),
    depth: epoch.snapshotDepth ?? 0,
    leafCount: epoch.leafCount,
    total: epoch.totalTickets ?? 0n,
  };
}

/**
 * The epoch's `request_draw` nonce. The first call picks and stores it, later
 * calls (a retried tick) read it back, so a request whose confirmation was lost
 * and a retry of it name the same randomness account and only one can land.
 * Nobody sees the stored value before the request lands: the API withholds it.
 */
export async function claimNonce(db: Db, poolAddress: string, epochId: bigint): Promise<Buffer> {
  const where = { poolAddress_id: { poolAddress, id: epochId } };
  await db.epoch.updateMany({
    where: { poolAddress, id: epochId, nonce: null },
    data: { nonce: Buffer.from(randomNonce()).toString("hex") },
  });
  const epoch = await db.epoch.findUniqueOrThrow({ where, select: { nonce: true } });
  if (epoch.nonce === null) throw new Error(`epoch ${epochId} has no nonce after claiming one`);
  return Buffer.from(epoch.nonce, "hex");
}

/**
 * The leaf whose range holds `target`, and its proof, built from the stored
 * rows. Null when the rows cannot back the committed root (missing, edited or
 * a different count), so the caller never sends a proof the chain will refuse.
 */
export async function winnerProof(
  db: Db,
  poolAddress: string,
  epochId: bigint,
  target: bigint,
): Promise<WinnerProof | null> {
  const epoch = await db.epoch.findUnique({ where: { poolAddress_id: { poolAddress, id: epochId } } });
  if (epoch === null || epoch.snapshotRoot === null) return null;
  const rows = await db.epochSnapshot.findMany({
    where: { poolAddress, epochId },
    orderBy: { index: "asc" },
    select: { owner: true, tickets: true },
  });
  if (rows.length !== epoch.leafCount || rows.length === 0) return null;
  const tree = buildSumTree(rows.map(({ owner, tickets }) => ({ wallet: bs58.decode(owner), tickets })));
  if (tree.root.toString("hex") !== epoch.snapshotRoot || target >= tree.total) return null;
  const { index, tickets } = tree.findWinner(target);
  return { commitment: tree, index, owner: at(rows, index).owner, tickets, siblings: tree.proof(index) };
}
