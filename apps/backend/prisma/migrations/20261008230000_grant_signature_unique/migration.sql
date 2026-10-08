-- off-chain-tickets 23: a signed manual grant resent inside its window must not
-- book twice. Chain-driven and operator rows have a null signature, which a
-- unique index lets repeat.
CREATE UNIQUE INDEX "TicketLedger_signature_key" ON "TicketLedger"("signature");
