-- Adds GameConfig (off-chain-tickets ticket 14): the game's parameters as an
-- append-only, signed row per pool. A new table, so a plain CreateTable.

-- CreateTable
CREATE TABLE "GameConfig" (
    "id" SERIAL NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "roundSeconds" INTEGER NOT NULL,
    "houseCutBps" INTEGER NOT NULL,
    "ticketsPerUsdc" INTEGER NOT NULL,
    "bonusCapBps" INTEGER NOT NULL,
    "referralTiers" JSONB NOT NULL,
    "maxTilesPerBet" INTEGER NOT NULL,
    "signer" TEXT,
    "signature" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameConfig_signature_key" ON "GameConfig"("signature");

-- CreateIndex
CREATE INDEX "GameConfig_poolAddress_id_idx" ON "GameConfig"("poolAddress", "id");
