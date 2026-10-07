-- fork-run-fixes 06: the Pool mirror carries `jackpot_reserved`, the prize a
-- Drawing or Drawn epoch still owes. The API subtracts it from the jackpot
-- vault's balance so a drawn, unpaid prize does not read as the next epoch's
-- jackpot. Rows written before this migration read 0 until the next indexer
-- sync upserts the real value.
ALTER TABLE "Pool" ADD COLUMN "jackpotReserved" BIGINT NOT NULL DEFAULT 0;
