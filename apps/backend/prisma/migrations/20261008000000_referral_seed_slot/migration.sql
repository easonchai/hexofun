-- mainnet-readiness-fixes 11: the Player mirror records the slot it was read
-- at, and a Referral row records the slot its principal was seeded from, so
-- the indexer does not apply an event the seed already holds. Existing rows
-- read 0, which the indexer treats as "nothing to skip".
ALTER TABLE "Player" ADD COLUMN "slot" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Referral" ADD COLUMN "seedSlot" BIGINT NOT NULL DEFAULT 0;
