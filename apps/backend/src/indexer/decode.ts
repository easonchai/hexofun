// Pure translation between the chain's shapes and Postgres rows: Anchor
// decoded accounts to Prisma inputs and `Program data:` log lines to event rows.
//
// Nothing here touches the network or Prisma, so every rule is unit-testable
// without a validator.
import { BN, EventParser } from "@anchor-lang/core";
import type { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";

/** `Epoch::status`, mirroring constants.rs. */
export const EPOCH_STATUS = {
  OPEN: 0,
  ENDED: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
} as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// The Anchor coder hands back BN, PublicKey and plain arrays. Postgres jsonb
// takes none of them, and a u64 does not survive a JSON number, so every
// integer becomes a decimal string and every key its base58.
export function jsonify(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonify);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonify(item)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

export interface DecodedEvent {
  name: string;
  data: JsonValue;
}

/**
 * Every event this program emitted in one transaction, in emission order.
 *
 * `EventParser` tracks the CPI stack, so an event a called program emitted
 * with a colliding discriminator is not mistaken for one of ours.
 */
export function decodeEventLogs(parser: EventParser, logs: string[]): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  try {
    for (const event of parser.parseLogs(logs)) {
      events.push({ name: declaredName(event.name), data: jsonify(event.data) });
    }
  } catch (cause) {
    throw new Error(`cannot parse program logs: ${logs[0] ?? "<empty>"}`, { cause });
  }
  return events;
}

/**
 * Anchor's `Program` camelCases the IDL before building its coder, so the
 * coder calls the event `epochDrawn`. Rows keep the name the program
 * declares and spec §2.6 lists, `EpochDrawn`, because that is what the API
 * and the frontend feed filter on. `decode.test.ts` checks every event name
 * against the IDL, so a casing rule that stops round-tripping fails there.
 */
const declaredName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

const big = (value: BN): bigint => BigInt(value.toString());
const isUnset = (key: PublicKey): boolean => key.equals(PublicKey.default);

// The coder throws on a wrong discriminator or a layout that does not fit the
// bytes, so these interfaces describe an already-validated account rather than
// asserting a shape onto unchecked input. Only the fields Postgres stores are
// listed; the rest of each account is decoded and dropped.
export interface DecodedPool {
  poolId: BN;
  admin: PublicKey;
  operator: PublicKey;
  pendingAdmin: PublicKey;
  acceptedMint: PublicKey;
  pendingWithdrawals: BN;
  minJackpot: BN;
  epochSeconds: BN;
  epochAnchor: BN;
  minDeposit: BN;
  paused: boolean;
  currentEpochId: BN;
  currentEpochStart: BN;
  currentEpochEndsAt: BN;
  previousEpochEndsAt: BN;
  totalPrincipal: BN;
  /** The depositors' ceiling rate (APR, basis points). */
  baseRateBps: number;
  /** Lets a future upgrade migrate an old account lazily (ADR 0013). */
  version: number;
  /** Admin-only and irreversible: stops every inflow, the game and the
   *  draw, and lets withdrawals skip the epoch lock. */
  shutdown: boolean;
  /** Game pause (game-jackpot-pause ticket 02): the backend game opens no Round. */
  gamePaused: boolean;
  /** Jackpot pause (game-jackpot-pause ticket 02): no new epoch, ticket
   *  purchase, and an ended epoch does not request its draw. */
  jackpotPaused: boolean;
  /** Live yield (yield-claimer): the pinned klend accounts,
   *  the Yield index and its owed amounts, and the venue settings. */
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
  venueKind: number;
  yieldIndex: BN;
  venueValue: BN;
  lastSyncAt: BN;
  yieldOwed: BN;
  feeOwed: BN;
  prizeOwed: BN;
  /** Jackpot promised to a Drawing or Drawn epoch that has not paid yet. */
  jackpotReserved: BN;
  deficit: BN;
  yieldFeeBps: number;
  idleFloorBps: number;
  idleTargetBps: number;
  reserveShareCapBps: number;
  reserveLiquidityFloorBps: number;
  minVenueMove: BN;
  lossToleranceBps: number;
  deployPaused: boolean;
  impaired: boolean;
  buyTicketsPaused: boolean;
}

export interface DecodedEpoch {
  epochId: BN;
  startsAt: BN;
  endsAt: BN;
  status: number;
  jackpotAmount: BN;
  target: BN;
  winner: PublicKey;
}

export interface DecodedPlayer {
  owner: PublicKey;
  principal: BN;
  epochId: BN;
  isHouse: boolean;
  pendingWithdraw: BN;
  pendingEpoch: BN;
  /** Chain unix seconds the pending withdrawal was last requested at. */
  requestedAt: BN;
  /** The epoch `boughtAmount` is counted against. */
  boughtEpoch: BN;
  /** USDC spent in `buy_tickets` so far in `boughtEpoch`, capped at `principal`. */
  boughtAmount: BN;
  /** The pool's Yield index at this Player's last settle, scaled by 1e18. */
  yieldIndex: BN;
  /** The part of `principal` deposited in `pendingDepositEpoch`. Its Tickets
   *  count from the next epoch. */
  pendingDeposit: BN;
  pendingDepositEpoch: BN;
}

/** The `VenueProposal` account (venue-switch ticket 03). */
export interface DecodedVenueProposal {
  venueKind: number;
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
  proposedAt: BN;
}

export function venueProposalRow(
  proposal: DecodedVenueProposal,
  poolAddress: string,
  slot: bigint,
): Prisma.VenueProposalUncheckedCreateInput {
  return {
    poolAddress,
    venueKind: proposal.venueKind,
    klendProgram: proposal.klendProgram.toBase58(),
    klendMarket: proposal.klendMarket.toBase58(),
    klendReserve: proposal.klendReserve.toBase58(),
    klendCtoken: proposal.klendCtoken.toBase58(),
    proposedAt: big(proposal.proposedAt),
    updatedSlot: slot,
  };
}

export function poolRow(
  address: PublicKey,
  pool: DecodedPool,
  slot: bigint,
): Prisma.PoolCreateInput {
  return {
    address: address.toBase58(),
    poolId: big(pool.poolId),
    admin: pool.admin.toBase58(),
    operator: pool.operator.toBase58(),
    // The default key means no handover is open.
    pendingAdmin: isUnset(pool.pendingAdmin) ? null : pool.pendingAdmin.toBase58(),
    mint: pool.acceptedMint.toBase58(),
    pendingWithdrawals: big(pool.pendingWithdrawals),
    minJackpot: big(pool.minJackpot),
    epochSeconds: big(pool.epochSeconds),
    epochAnchor: big(pool.epochAnchor),
    minDeposit: big(pool.minDeposit),
    paused: pool.paused,
    currentEpochId: big(pool.currentEpochId),
    currentEpochEndsAt: big(pool.currentEpochEndsAt),
    previousEpochEndsAt: big(pool.previousEpochEndsAt),
    totalPrincipal: big(pool.totalPrincipal),
    baseRateBps: pool.baseRateBps,
    version: pool.version,
    shutdown: pool.shutdown,
    gamePaused: pool.gamePaused,
    jackpotPaused: pool.jackpotPaused,
    klendProgram: pool.klendProgram.toBase58(),
    klendMarket: pool.klendMarket.toBase58(),
    klendReserve: pool.klendReserve.toBase58(),
    klendCtoken: pool.klendCtoken.toBase58(),
    venueKind: pool.venueKind,
    yieldIndex: pool.yieldIndex.toString(),
    venueValue: big(pool.venueValue),
    lastSyncAt: big(pool.lastSyncAt),
    yieldOwed: big(pool.yieldOwed),
    feeOwed: big(pool.feeOwed),
    prizeOwed: big(pool.prizeOwed),
    jackpotReserved: big(pool.jackpotReserved),
    deficit: big(pool.deficit),
    yieldFeeBps: pool.yieldFeeBps,
    idleFloorBps: pool.idleFloorBps,
    idleTargetBps: pool.idleTargetBps,
    reserveShareCapBps: pool.reserveShareCapBps,
    reserveLiquidityFloorBps: pool.reserveLiquidityFloorBps,
    minVenueMove: big(pool.minVenueMove),
    lossToleranceBps: pool.lossToleranceBps,
    deployPaused: pool.deployPaused,
    impaired: pool.impaired,
    buyTicketsPaused: pool.buyTicketsPaused,
    updatedSlot: slot,
  };
}

// The account bytes carry no pool, so the caller passes the Active pool's
// address for the row's key (ADR 0016).
export function epochRow(epoch: DecodedEpoch, poolAddress: string): Prisma.EpochUncheckedCreateInput {
  return {
    poolAddress,
    id: big(epoch.epochId),
    startsAt: big(epoch.startsAt),
    endsAt: big(epoch.endsAt),
    status: epoch.status,
    jackpotAmount: big(epoch.jackpotAmount),
    target: epoch.target.toString(),
    // Written only by `payout`; the default key means "no winner yet".
    winner: isUnset(epoch.winner) ? null : epoch.winner.toBase58(),
  };
}

export function playerRow(
  player: DecodedPlayer,
  poolAddress: string,
  slot: bigint,
): Prisma.PlayerUncheckedCreateInput {
  return {
    poolAddress,
    owner: player.owner.toBase58(),
    principal: big(player.principal),
    epochId: big(player.epochId),
    isHouse: player.isHouse,
    pendingWithdraw: big(player.pendingWithdraw),
    pendingEpoch: big(player.pendingEpoch),
    requestedAt: big(player.requestedAt),
    boughtEpoch: big(player.boughtEpoch),
    boughtAmount: big(player.boughtAmount),
    yieldIndex: player.yieldIndex.toString(),
    pendingDeposit: big(player.pendingDeposit),
    pendingDepositEpoch: big(player.pendingDepositEpoch),
    slot,
  };
}
