-- audit-2026-10-09 09: GET /feed?owner=, GET /players/:owner and the position
-- yield read filter the event table on data->>'owner' and data->>'winner'
-- (JackpotPaid carries the winner), which seq-scanned it. Expression indexes
-- on exactly those two expressions; the planner ORs them with a bitmap scan.
-- Prisma's schema cannot express these, so they live only in this file.

-- CreateIndex
CREATE INDEX "Event_data_owner_idx" ON "Event" ((data->>'owner'));

-- CreateIndex
CREATE INDEX "Event_data_winner_idx" ON "Event" ((data->>'winner'));
