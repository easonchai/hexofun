-- Deposits earn Tickets from the next epoch (yield-claimer ticket 20): the
-- Player carries the pending amount and the epoch it was deposited in.
-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "pendingDeposit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "pendingDepositEpoch" BIGINT NOT NULL DEFAULT 0;
