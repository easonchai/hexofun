import type { PrismaClient } from "@prisma/client";

/** The sums a snapshot leaf shows. `game` is stake plus reward plus refund (and the House's credit). */
export type ReasonKey = "reset" | "game" | "buy" | "grant_referral" | "grant_admin" | "prize" | "withdraw";

export interface AdminGrant {
  amount: bigint;
  /** The free-text reason the team gave. */
  ref: string;
  signer: string | null;
  signature: string | null;
}

export interface LeafReasons {
  /** Only the non-zero sums, so a page stays small. They add up to the leaf's `tickets`. */
  reasons: Partial<Record<ReasonKey, bigint>>;
  /** The epoch's `grant_admin` rows with who signed them; omitted when there are none. */
  grants?: AdminGrant[];
}

const BUCKET: Record<string, ReasonKey> = {
  stake: "game",
  reward: "game",
  refund: "game",
  house_credit: "game",
};

/**
 * Why each wallet holds the Tickets its leaf shows. The snapshot is the balance
 * at the end of `epochId`, so it is every ledger row up to that epoch. The
 * balance an epoch starts with is the one its cutoff reset set, so earlier
 * epochs' rows and the reset's own row both count as `reset`; the epoch's other
 * rows keep their reason.
 */
export async function snapshotReasons(
  prisma: PrismaClient,
  poolAddress: string,
  epochId: bigint,
  owners: string[],
): Promise<Map<string, LeafReasons>> {
  const out = new Map<string, LeafReasons>(owners.map((owner) => [owner, { reasons: {} }]));
  if (owners.length === 0) return out;
  // One array bind each, however many owners the page holds.
  const sums = await prisma.$queryRaw<{ owner: string; reason: string; sum: bigint }[]>`
    SELECT "owner",
      CASE WHEN "epochId" < ${epochId} THEN 'reset' ELSE "reason"::text END AS "reason",
      SUM("delta")::bigint AS "sum"
    FROM "TicketLedger"
    WHERE "poolAddress" = ${poolAddress} AND "owner" = ANY(${owners}) AND "epochId" <= ${epochId}
    GROUP BY 1, 2`;
  for (const { owner, reason, sum } of sums) {
    const key = BUCKET[reason] ?? (reason as ReasonKey);
    const reasons = out.get(owner)?.reasons;
    if (reasons === undefined || sum === 0n) continue;
    reasons[key] = (reasons[key] ?? 0n) + sum;
  }
  const grants = await prisma.$queryRaw<{ owner: string; amount: bigint; ref: string; signer: string | null; signature: string | null }[]>`
    SELECT "owner", "delta" AS "amount", "ref", "signer", "signature"
    FROM "TicketLedger"
    WHERE "poolAddress" = ${poolAddress} AND "owner" = ANY(${owners}) AND "epochId" = ${epochId} AND "reason" = 'grant_admin'
    ORDER BY "id"`;
  for (const { owner, ...grant } of grants) {
    const leaf = out.get(owner);
    if (leaf !== undefined) (leaf.grants ??= []).push(grant);
  }
  return out;
}
