// The operator's once-per-epoch Referral bonus job (off-chain-tickets 22, ADR
// 0025). The math is referral-bonus.ts's, unchanged; this file reads its
// inputs, and writes the ReferralGrant rows, their per-referee shares and one
// `grant_referral` ledger row per Referrer in a single database transaction.
// `GET /epochs/:id/referral-grants` serves the same rows back, so a reader can
// recompute every amount from the inputs stored beside it.
import type { PrismaClient } from "@prisma/client";

import {
  bandForCount,
  computeBonuses,
  REFERRAL_BONUS_BASIS_CAP,
  splitShares,
  type ReferrerBonusInput,
  type ShareWeight,
} from "../api/referral-bonus";
import { referralTiersFromRow } from "../api/game-config";
import { isQualified } from "../api/referral";
import { lockLedger } from "../ledger/ledger-store";

/** A cutoff batch holds the lock for as long as the reset runs (120 s in ticket 11). */
const JOB_TRANSACTION_MS = 150_000;

/**
 * Grants the Referral bonus for the epoch the Ticket ledger has reached, to
 * every Referrer that has no grant row for it yet, and returns how many it
 * granted. Safe to call every tick: a Referrer already granted for the epoch
 * is skipped, so a retried tick grants nothing twice, and one that qualifies
 * later in the epoch is scaled against the pool-wide headroom the earlier
 * grants left. Nothing is written when nobody qualifies.
 *
 * It runs on the ledger's epoch, not the chain's, so a grant never lands before
 * the `EpochBegan` reset of its epoch (which would erase it), and it takes the
 * ledger's lock so it cannot interleave with a cutoff or a balance update.
 */
export async function grantReferralBonuses(
  prisma: PrismaClient,
  input: { poolAddress: string; operator: string; now: bigint; qualifySeconds: number },
): Promise<number> {
  const { poolAddress, operator, now, qualifySeconds } = input;
  return prisma.$transaction(
    async (tx) => {
      await lockLedger(tx, poolAddress);
      const cursor = await tx.cursor.findUnique({ where: { poolAddress }, select: { ledgerEpochId: true } });
      const epochId = cursor?.ledgerEpochId ?? 0n;
      if (epochId < 1n) return 0;

      const [pool, config, referrals, recorded] = await Promise.all([
        tx.pool.findUnique({ where: { address: poolAddress }, select: { totalPrincipal: true } }),
        // The row in force is the newest.
        tx.gameConfig.findFirst({
          where: { poolAddress },
          orderBy: { id: "desc" },
          select: { bonusCapBps: true, referralTiers: true },
        }),
        // Referral is wallet-level and outlives any one pool; Player is the Active pool's.
        tx.referral.findMany({ select: { referee: true, referrer: true, principal: true, aboveSince: true } }),
        tx.referralGrant.findMany({ where: { poolAddress, epochId }, select: { referrer: true, amount: true } }),
      ]);
      if (pool === null || referrals.length === 0) return 0;
      if (config === null) throw new Error(`pool ${poolAddress} has no Game config row, so the bonus cap is unknown`);

      const granted = new Set(recorded.map((row) => row.referrer));
      const byReferrer = new Map<string, { referee: string; principal: bigint }[]>();
      for (const row of referrals) {
        if (granted.has(row.referrer) || !isQualified(row.aboveSince, now, qualifySeconds)) continue;
        byReferrer.set(row.referrer, [...(byReferrer.get(row.referrer) ?? []), row]);
      }
      if (byReferrer.size === 0) return 0;

      const players = await tx.player.findMany({
        where: { poolAddress, owner: { in: [...byReferrer.keys()] } },
        select: { owner: true, principal: true },
      });
      const principalOf = new Map(players.map((player) => [player.owner, player.principal]));
      const inputs: ReferrerBonusInput[] = [...byReferrer].map(([referrer, qualified]) => ({
        referrer,
        principal: principalOf.get(referrer) ?? 0n,
        alreadyGrantedToday: 0n, // the on-chain per-day counter went with grant_tickets
        qualifiedReferralPrincipals: qualified.map((row) => row.principal),
      }));
      const spent = recorded.reduce((sum, row) => sum + row.amount, 0n);
      const tiers = referralTiersFromRow(config.referralTiers, `pool ${poolAddress}`);
      const bonuses = computeBonuses(tiers, inputs, pool.totalPrincipal, config.bonusCapBps, spent);
      if (bonuses.length === 0) return 0;

      const ref = `referral:${epochId}`;
      for (const bonus of bonuses) {
        const qualified = byReferrer.get(bonus.referrer) ?? [];
        const weights: ShareWeight[] = qualified.map((row) => ({
          referee: row.referee,
          weight: row.principal < REFERRAL_BONUS_BASIS_CAP ? row.principal : REFERRAL_BONUS_BASIS_CAP,
        }));
        const principals = new Map(qualified.map((row) => [row.referee, row.principal]));
        await tx.referralGrant.create({
          data: {
            poolAddress,
            epochId,
            referrer: bonus.referrer,
            amount: bonus.amount,
            uncapped: bonus.uncapped,
            qualifiedCount: bonus.qualifiedCount,
            rateBps: bonus.rateBps,
            tier: bandForCount(tiers, bonus.qualifiedCount).band.tier,
            referrerPrincipal: principalOf.get(bonus.referrer) ?? 0n,
            totalPrincipal: pool.totalPrincipal,
            bonusCapBps: config.bonusCapBps,
          },
        });
        await tx.referralGrantShare.createMany({
          data: splitShares(bonus.amount, weights).map((share) => ({
            poolAddress,
            epochId,
            referrer: bonus.referrer,
            referee: share.referee,
            amount: share.amount,
            principal: principals.get(share.referee) ?? 0n,
          })),
        });
        await tx.ticketLedger.create({
          data: { poolAddress, owner: bonus.referrer, epochId, delta: bonus.amount, reason: "grant_referral", ref, signer: operator },
        });
        await tx.ticketBalance.upsert({
          where: { poolAddress_owner: { poolAddress, owner: bonus.referrer } },
          create: { poolAddress, owner: bonus.referrer, tickets: bonus.amount, epochId },
          update: { tickets: { increment: bonus.amount } },
        });
      }
      return bonuses.length;
    },
    { timeout: JOB_TRANSACTION_MS },
  );
}

/**
 * The epoch's grants with the inputs behind each: the Referrer's locked
 * Principal, the pool figures and cap in force, and every referral's locked
 * Principal with its share. Empty when the epoch granted nothing.
 */
export async function referralGrantsForEpoch(prisma: PrismaClient, poolAddress: string, epochId: bigint) {
  const [grants, shares] = await Promise.all([
    prisma.referralGrant.findMany({ where: { poolAddress, epochId }, orderBy: { referrer: "asc" } }),
    prisma.referralGrantShare.findMany({ where: { poolAddress, epochId }, orderBy: [{ referrer: "asc" }, { referee: "asc" }] }),
  ]);
  return {
    epochId,
    grants: grants.map((grant) => ({
      referrer: grant.referrer,
      amount: grant.amount,
      uncapped: grant.uncapped,
      tier: grant.tier,
      rateBps: grant.rateBps,
      qualifiedCount: grant.qualifiedCount,
      referrerPrincipal: grant.referrerPrincipal,
      totalPrincipal: grant.totalPrincipal,
      bonusCapBps: grant.bonusCapBps,
      referrals: shares
        .filter((share) => share.referrer === grant.referrer)
        .map(({ referee, principal, amount }) => ({ referee, principal, share: amount })),
    })),
  };
}
