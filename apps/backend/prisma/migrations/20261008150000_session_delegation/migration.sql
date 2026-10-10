-- Adds Session and SessionNonce (off-chain-tickets ticket 15): a wallet's signed
-- delegation of a browser-held session key, and the single-use nonces that
-- delegation message carries. New tables, so plain CreateTable.

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "sessionPubkey" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "nextSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionNonce" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionPubkey_key" ON "Session"("sessionPubkey");

-- CreateIndex
CREATE INDEX "Session_wallet_idx" ON "Session"("wallet");
