-- Referral bonus grants move onto the Ticket ledger (off-chain-tickets ticket
-- 22). The grant rows now carry the inputs behind each amount, so
-- GET /epochs/:id/referral-grants is a proof. Rows from before default to 0.

-- AlterTable
ALTER TABLE "ReferralGrant" ADD COLUMN "referrerPrincipal" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "totalPrincipal" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "bonusCapBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReferralGrantShare" ADD COLUMN "principal" BIGINT NOT NULL DEFAULT 0;
