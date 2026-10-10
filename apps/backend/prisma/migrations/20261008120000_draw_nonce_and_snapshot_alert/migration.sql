-- off-chain-tickets 12: the request_draw nonce is 32 bytes, so it is hex text
-- (the BIGINT column from ticket 11 was never written), and the operator
-- records a refused winner proof for the SNAPSHOT_MISMATCH alert.
ALTER TABLE "Epoch" ALTER COLUMN "nonce" TYPE TEXT USING NULL;

ALTER TABLE "OperatorState" ADD COLUMN "snapshotMismatch" BOOLEAN;
