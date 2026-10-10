-- venue-switch ticket 03: the pool's open venue proposal, one row per pool while
-- the on-chain account exists.
CREATE TABLE "VenueProposal" (
    "poolAddress" TEXT NOT NULL,
    "venueKind" INTEGER NOT NULL,
    "klendProgram" TEXT NOT NULL,
    "klendMarket" TEXT NOT NULL,
    "klendReserve" TEXT NOT NULL,
    "klendCtoken" TEXT NOT NULL,
    "proposedAt" BIGINT NOT NULL,
    "updatedSlot" BIGINT NOT NULL,

    CONSTRAINT "VenueProposal_pkey" PRIMARY KEY ("poolAddress")
);

-- AddForeignKey
ALTER TABLE "VenueProposal" ADD CONSTRAINT "VenueProposal_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
