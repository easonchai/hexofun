-- One withdraw path (yield-claimer ticket 23): the Player row carries when the
-- queued withdrawal was requested, so the API can say when it pays.
-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "requestedAt" BIGINT NOT NULL DEFAULT 0;
