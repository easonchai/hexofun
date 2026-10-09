-- audit-2026-10-09 08: a per-grant cap on manual Ticket grants, kept on the
-- Game config row in force. Existing rows take the 10,000 Ticket default.

-- AlterTable
ALTER TABLE "GameConfig" ADD COLUMN "maxAdminGrant" INTEGER NOT NULL DEFAULT 10000;
