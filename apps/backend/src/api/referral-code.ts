// A wallet's own ReferralCode (ADR 0014): minted by the indexer on a first
// deposit, or by GET /referrals/:wallet for a wallet past the beta gate that
// has not deposited yet, so it can start referring first.
import type { Prisma } from "@prisma/client";

import { generateInviteCode } from "./invite-code";
import { applyReferralEvent } from "./referral";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/**
 * A fresh code, reusing InviteCode's own alphabet and length. Unlike
 * InviteCode's insert, which lets its own primary key catch a collision,
 * ReferralCode and InviteCode are separate tables: a generated code landing
 * in the other one would not fail an insert, so this checks both by hand
 * before returning one.
 */
async function generateReferralCode(tx: Prisma.TransactionClient): Promise<string> {
  for (;;) {
    const code = generateInviteCode();
    const [invite, referral] = await Promise.all([
      tx.inviteCode.findUnique({ where: { code } }),
      tx.referralCode.findUnique({ where: { code } }),
    ]);
    if (invite === null && referral === null) return code;
  }
}

/**
 * `owner`'s ReferralCode, creating it if it has none. `skipDuplicates`
 * (ON CONFLICT DO NOTHING) lets the indexer and the API race to mint the
 * same wallet's code without either one throwing: the loser re-reads the
 * winner's row.
 */
export async function ensureReferralCode(tx: Prisma.TransactionClient, owner: string): Promise<string> {
  const owned = await tx.referralCode.findUnique({ where: { owner } });
  if (owned !== null) return owned.code;
  await tx.referralCode.createMany({
    data: [{ code: await generateReferralCode(tx), owner, createdAt: nowSeconds() }],
    skipDuplicates: true,
  });
  return (await tx.referralCode.findUniqueOrThrow({ where: { owner } })).code;
}

/**
 * Writes `referee`'s Referral row (ADR 0014). Binding is allowed at any time,
 * before or after a first deposit, so the row's qualification state is seeded
 * from the Active pool's Player right away: a referee already holding 50 USDC
 * starts its 7-day clock now instead of on its next chain event, and a later
 * WithdrawRequested delta applies against the real Principal. No Player, or a
 * Player only in a retired pool (ADR 0016), seeds as 0. The row keeps the
 * mirror's slot as `seedSlot`: the indexer skips the referee's events at or
 * before it, because the seed already holds them. Throws Prisma's
 * P2002 when a Referral already exists; callers turn that into a refusal.
 */
export async function bindReferral(
  tx: Prisma.TransactionClient,
  poolAddress: string,
  referee: string,
  referrer: string,
  code: string,
): Promise<void> {
  const player = await tx.player.findUnique({
    where: { poolAddress_owner: { poolAddress, owner: referee } },
    select: { principal: true, slot: true },
  });
  const now = nowSeconds();
  const seeded = applyReferralEvent(
    { principal: 0n, aboveSince: null },
    { kind: "Deposited", principal: player?.principal ?? 0n },
    now,
  );
  await tx.referral.create({
    data: { referee, referrer, code, boundAt: now, ...seeded, seedSlot: player?.slot ?? 0n },
  });
}
