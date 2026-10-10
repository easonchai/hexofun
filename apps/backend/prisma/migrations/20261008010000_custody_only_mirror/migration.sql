-- off-chain-tickets 10: the program is custody only. Round, Position and the
-- Weight tree are gone from it, so their mirrors go too (nothing reads them;
-- ticket 16 creates the backend's own Round and Position tables under the same
-- names). The Player mirror's `entries` becomes `tickets`, and the Pool and
-- Player columns the program dropped go with them.
DROP TABLE "Position";
DROP TABLE "Round";
DROP TABLE "WeightTreeState";

ALTER TABLE "Player" RENAME COLUMN "entries" TO "tickets";
ALTER TABLE "Player" ALTER COLUMN "tickets" SET DEFAULT 0;
ALTER TABLE "Player" DROP COLUMN "leafIndex",
  DROP COLUMN "bonusEpoch",
  DROP COLUMN "bonusGranted";

ALTER TABLE "Pool" DROP COLUMN "roundSeconds",
  DROP COLUMN "closeBuffer",
  DROP COLUMN "houseCutBps",
  DROP COLUMN "ticketsPerUsdc",
  DROP COLUMN "bonusCapBps",
  DROP COLUMN "bonusEpoch",
  DROP COLUMN "bonusGranted",
  DROP COLUMN "weightTree";
