// The live-yield columns a Pool and a Player row carry (yield-claimer ticket
// 14), at the values a fresh pool reads. Test fixtures that build a whole row
// spread these in, so the next column does not mean editing every fixture.
import { Prisma } from "@prisma/client";

export const LIVE_POOL_DEFAULTS = {
  weightTree: "",
  klendProgram: "",
  klendMarket: "",
  klendReserve: "",
  klendCtoken: "",
  venueKind: 0,
  yieldIndex: new Prisma.Decimal(0),
  venueValue: 0n,
  lastSyncAt: 0n,
  yieldOwed: 0n,
  feeOwed: 0n,
  prizeOwed: 0n,
  jackpotReserved: 0n,
  deficit: 0n,
  yieldFeeBps: 0,
  idleFloorBps: 0,
  idleTargetBps: 0,
  reserveShareCapBps: 0,
  reserveLiquidityFloorBps: 0,
  minVenueMove: 0n,
  lossToleranceBps: 0,
  deployPaused: false,
  impaired: false,
  buyTicketsPaused: false,
};

export const LIVE_PLAYER_DEFAULTS = {
  yieldIndex: new Prisma.Decimal(0),
  leafIndex: 0,
  requestedAt: 0n,
  pendingDeposit: 0n,
  pendingDepositEpoch: 0n,
};
