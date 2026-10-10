-- off-chain-tickets ticket 32: the tier a grant was paid at, stored with it so
-- GET /epochs/:id/referral-grants does not re-derive it from today's Game
-- config. Rows from before were all paid under the seed tiers (1-2, 3-5,
-- 6-10, 11+), so backfill from their qualified count.

-- AlterTable
ALTER TABLE "ReferralGrant" ADD COLUMN "tier" INTEGER NOT NULL DEFAULT 0;

UPDATE "ReferralGrant" SET "tier" = CASE
  WHEN "qualifiedCount" >= 11 THEN 4
  WHEN "qualifiedCount" >= 6 THEN 3
  WHEN "qualifiedCount" >= 3 THEN 2
  WHEN "qualifiedCount" >= 1 THEN 1
  ELSE 0
END;
