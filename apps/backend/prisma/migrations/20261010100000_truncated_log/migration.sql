-- audit-2026-10-09 06: pool transactions whose log Solana truncated.
CREATE TABLE "TruncatedLog" (
    "poolAddress" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TruncatedLog_pkey" PRIMARY KEY ("poolAddress","signature")
);
