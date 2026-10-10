-- yield-claimer ticket 14: the read model follows the live yield program.
-- Registration and Base yield columns go; the Pool mirror gains the venue and
-- yield state; a history of the Yield index and the Weight tree's header and
-- root arrive. The new Pool and Player columns carry defaults for rows written
-- before this migration, and the next indexer sync upserts the real values.

-- AlterTable
ALTER TABLE "Pool" DROP COLUMN "carryPot",
DROP COLUMN "yieldBudget",
ADD COLUMN     "weightTree" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "klendProgram" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "klendMarket" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "klendReserve" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "klendCtoken" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "yieldIndex" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "venueValue" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lastSyncAt" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "yieldOwed" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "feeOwed" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "prizeOwed" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deficit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "yieldFeeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "idleFloorBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "idleTargetBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reserveShareCapBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reserveLiquidityFloorBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "minVenueMove" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lossToleranceBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deployPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "impaired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "buyTicketsPaused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Epoch" DROP COLUMN "registeredWeight",
DROP COLUMN "registeredCount";

-- AlterTable
ALTER TABLE "Player" DROP COLUMN "weightAcc",
DROP COLUMN "lastUpdate",
DROP COLUMN "frozenWeight",
DROP COLUMN "frozenEpoch",
DROP COLUMN "regEpoch",
DROP COLUMN "regStart",
DROP COLUMN "regEnd",
DROP COLUMN "principalAcc",
DROP COLUMN "frozenPrincipalAcc",
DROP COLUMN "yieldEpoch",
ADD COLUMN     "yieldIndex" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "leafIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OperatorState" DROP COLUMN "registeredCount",
DROP COLUMN "registeredTotal",
DROP COLUMN "registrationIndexerStale";

-- CreateTable
CREATE TABLE "YieldIndexPoint" (
    "poolAddress" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "yieldIndex" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "YieldIndexPoint_pkey" PRIMARY KEY ("poolAddress","at")
);

-- CreateTable
CREATE TABLE "WeightTreeState" (
    "poolAddress" TEXT NOT NULL,
    "nodeCount" BIGINT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "rootWeight" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "WeightTreeState_pkey" PRIMARY KEY ("poolAddress")
);

-- AddForeignKey
ALTER TABLE "YieldIndexPoint" ADD CONSTRAINT "YieldIndexPoint_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightTreeState" ADD CONSTRAINT "WeightTreeState_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
