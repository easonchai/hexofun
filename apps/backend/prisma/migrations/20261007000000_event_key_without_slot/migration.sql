-- An Event is one (signature, instruction index). The live log path stamped
-- the slot its notification arrived in, which Surfpool reports ~31 slots past
-- the transaction's own, so the old (slot, signature, index) key stored the
-- same event twice. Keep the earliest copy (the catch-up poll's, the
-- transaction's real slot) and drop the rest before re-keying.
DELETE FROM "Event" later
USING "Event" earlier
WHERE later."signature" = earlier."signature"
  AND later."index" = earlier."index"
  AND later."slot" > earlier."slot";

-- AlterTable
ALTER TABLE "Event" DROP CONSTRAINT "Event_pkey",
ADD CONSTRAINT "Event_pkey" PRIMARY KEY ("signature", "index");
