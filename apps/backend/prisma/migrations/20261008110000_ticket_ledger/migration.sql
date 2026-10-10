-- off-chain-tickets 11: the Ticket ledger, the Epoch snapshot and the columns
-- the indexer needs to apply events in chain order. The Player mirror's
-- `tickets` column goes: TicketBalance holds the number now.
ALTER TABLE "Player" DROP COLUMN "tickets";

ALTER TABLE "Epoch"
  ADD COLUMN "snapshotRoot" TEXT,
  ADD COLUMN "snapshotDepth" INTEGER,
  ADD COLUMN "leafCount" INTEGER,
  ADD COLUMN "totalTickets" BIGINT,
  ADD COLUMN "nonce" BIGINT;

ALTER TABLE "Event" ADD COLUMN "ledgered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Cursor" ADD COLUMN "ledgerEpochId" BIGINT NOT NULL DEFAULT 0;

CREATE TYPE "TicketReason" AS ENUM ('reset', 'stake', 'reward', 'refund', 'house_credit', 'prize', 'withdraw', 'buy', 'grant_referral', 'grant_admin');

CREATE TABLE "TicketLedger" (
    "id" BIGSERIAL NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" "TicketReason" NOT NULL,
    "ref" TEXT NOT NULL,
    "signer" TEXT,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketLedger_poolAddress_owner_idx" ON "TicketLedger"("poolAddress", "owner");

CREATE TABLE "TicketBalance" (
    "poolAddress" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "tickets" BIGINT NOT NULL DEFAULT 0,
    "principal" BIGINT NOT NULL DEFAULT 0,
    "yieldIndex" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "epochId" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketBalance_pkey" PRIMARY KEY ("poolAddress","owner")
);

CREATE TABLE "EpochSnapshot" (
    "poolAddress" TEXT NOT NULL,
    "epochId" BIGINT NOT NULL,
    "index" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "tickets" BIGINT NOT NULL,

    CONSTRAINT "EpochSnapshot_pkey" PRIMARY KEY ("poolAddress","epochId","index")
);

CREATE TABLE "LedgerCheck" (
    "poolAddress" TEXT NOT NULL,
    "checkedAt" BIGINT NOT NULL,
    "mismatches" INTEGER NOT NULL,

    CONSTRAINT "LedgerCheck_pkey" PRIMARY KEY ("poolAddress")
);
