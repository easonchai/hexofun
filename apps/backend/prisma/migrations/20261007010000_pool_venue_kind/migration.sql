-- venue-switch ticket 02: the Pool mirror carries the venue kind byte. Zero is
-- klend, so rows written before this migration read as klend until the next
-- indexer sync upserts the real value.
ALTER TABLE "Pool" ADD COLUMN "venueKind" INTEGER NOT NULL DEFAULT 0;
