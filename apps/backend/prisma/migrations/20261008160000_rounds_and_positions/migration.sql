-- off-chain-tickets 16: the off-chain game's Round and Position rows. New
-- tables, so plain CreateTable.

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('open', 'closed', 'revealed', 'settled', 'voided');

-- CreateTable
CREATE TABLE "Round" (
    "poolAddress" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "openAt" TIMESTAMP(3) NOT NULL,
    "closeAt" TIMESTAMP(3) NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'open',
    "seedCommitment" TEXT NOT NULL,
    "seedSecret" TEXT NOT NULL,
    "seed" TEXT,
    "drandRound" BIGINT,
    "drandSignature" TEXT,
    "ctr" INTEGER,
    "tile" INTEGER,
    "pot" BIGINT NOT NULL DEFAULT 0,
    "houseCut" BIGINT,
    "tileTotals" JSONB NOT NULL,
    "betListHash" TEXT,
    "configId" INTEGER NOT NULL,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("poolAddress","id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" BIGSERIAL NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "roundId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tiles" BIGINT NOT NULL,
    "stakePerTile" BIGINT NOT NULL,
    "message" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Round_poolAddress_status_idx" ON "Round"("poolAddress", "status");

-- CreateIndex
CREATE INDEX "Position_poolAddress_roundId_id_idx" ON "Position"("poolAddress", "roundId", "id");

-- CreateIndex
CREATE INDEX "Position_poolAddress_roundId_owner_idx" ON "Position"("poolAddress", "roundId", "owner");
