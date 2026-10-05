// Pure translation between the chain's shapes and Postgres rows: Anchor
// decoded accounts to Prisma inputs and `Program data:` log lines to event rows.
//
// Nothing here touches the network or Prisma, so every rule is unit-testable
// without a validator.
import { BN, EventParser } from "@anchor-lang/core";
import type { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";

/** `Epoch::status` and `Round::status`, mirroring constants.rs. */
export const EPOCH_STATUS = {
  OPEN: 0,
  ENDED: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
} as const;

export const ROUND_STATUS = {
  OPEN: 0,
  REQUESTED: 1,
  SETTLED: 2,
  FORFEITED: 3,
  VOIDED: 4,
} as const;

/** Round statuses in which `winning_tile` holds a drawn value. */
const TILE_DECIDED: number[] = [ROUND_STATUS.SETTLED, ROUND_STATUS.FORFEITED];

/** A round the operator may still act on: no other round can be created. */
export const LIVE_ROUND_STATUSES: number[] = [ROUND_STATUS.OPEN, ROUND_STATUS.REQUESTED];

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
 * coder calls the event `roundSettled`. Rows keep the name the program
 * declares and spec §2.6 lists, `RoundSettled`, because that is what the API
 * and the frontend feed filter on. `decode.test.ts` checks every event name
 * against the IDL, so a casing rule that stops round-tripping fails there.
 */
const declaredName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * `settle_position` closes the Position account and refunds its rent,
 * whether the Round it belongs to settled or was voided (`void_round` itself
 * closes nothing; it only ever unlocks the settle). The owner and round id
 * this event carries already identify the row Postgres keyed by address, so
 * the indexer deletes it here instead of waiting for a sweep to notice the
 * account is gone.
 */
export function settledPosition(event: DecodedEvent): { owner: string; roundId: bigint } | null {
  if (event.name !== "PositionSettled") return null;
  const { data } = event;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { owner, roundId } = data;
  if (typeof owner !== "string" || typeof roundId !== "string") return null;
  return { owner, roundId: BigInt(roundId) };
}

/**
 * `close_round` reclaimed this Round's rent and closed the account
 * (ops-and-envs ticket 08). The account read that follows this event in
 * `refreshFromLogs` comes back missing, and `applyAccount` already leaves a
 * missing Round row alone rather than deleting or blanking it, so this is
 * the only place the row learns it is gone: `persist()` flips `closed` on
 * the id this event names.
 */
export function closedRound(event: DecodedEvent): { id: bigint } | null {
  if (event.name !== "RoundClosed") return null;
  const { data } = event;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { roundId } = data;
  if (typeof roundId !== "string") return null;
  return { id: BigInt(roundId) };
}

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
  roundSeconds: BN;
  closeBuffer: BN;
  minDeposit: BN;
  houseCutBps: number;
  paused: boolean;
  currentEpochId: BN;
  currentEpochStart: BN;
  currentEpochEndsAt: BN;
  previousEpochEndsAt: BN;
  totalPrincipal: BN;
  /** The depositors' ceiling rate (APR, basis points). */
  baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. */
  ticketsPerUsdc: number;
  /** Share of `total_principal`, in basis points, an operator `grant_tickets`
   *  call may credit pool-wide per epoch. */
  bonusCapBps: number;
  /** The epoch `bonusGranted` is counted against. */
  bonusEpoch: BN;
  /** Tickets an operator `grant_tickets` call has credited pool-wide so far
   *  in `bonusEpoch`. */
  bonusGranted: BN;
  /** Lets a future upgrade migrate an old account lazily (ADR 0013). */
  version: number;
  /** Admin-only and irreversible: stops every inflow, the game and the
   *  draw, and lets withdrawals skip the epoch lock. */
  shutdown: boolean;
  /** Game pause (game-jackpot-pause ticket 02): no new Round or Position. */
  gamePaused: boolean;
  /** Jackpot pause (game-jackpot-pause ticket 02): no new epoch, ticket
   *  purchase or grant, and an ended epoch does not request its draw. */
  jackpotPaused: boolean;
  /** Live yield (yield-claimer): the Weight tree, the pinned klend accounts,
   *  the Yield index and its owed amounts, and the venue settings. */
  weightTree: PublicKey;
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
  yieldIndex: BN;
  venueValue: BN;
  lastSyncAt: BN;
  yieldOwed: BN;
  feeOwed: BN;
  prizeOwed: BN;
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

export interface DecodedRound {
  roundId: BN;
  epochId: BN;
  startsAt: BN;
  endsAt: BN;
  status: number;
  tileTotals: BN[];
  pot: BN;
  houseCut: BN;
  winningTile: number;
}

export interface DecodedPlayer {
  owner: PublicKey;
  principal: BN;
  entries: BN;
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
  /** The epoch `bonusGranted` is counted against. */
  bonusEpoch: BN;
  /** Tickets an operator `grant_tickets` call has credited this Player so
   *  far in `bonusEpoch`. */
  bonusGranted: BN;
  /** The pool's Yield index at this Player's last settle, scaled by 1e18. */
  yieldIndex: BN;
  /** This Player's leaf in the Weight tree, 1-based. */
  leafIndex: number;
  /** The part of `principal` deposited in `pendingDepositEpoch`. Its Tickets
   *  count from the next epoch. */
  pendingDeposit: BN;
  pendingDepositEpoch: BN;
}

export interface DecodedPosition {
  owner: PublicKey;
  round: PublicKey;
  tiles: BN;
  stakePerTile: BN;
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
    roundSeconds: big(pool.roundSeconds),
    closeBuffer: big(pool.closeBuffer),
    minDeposit: big(pool.minDeposit),
    houseCutBps: pool.houseCutBps,
    paused: pool.paused,
    currentEpochId: big(pool.currentEpochId),
    currentEpochEndsAt: big(pool.currentEpochEndsAt),
    previousEpochEndsAt: big(pool.previousEpochEndsAt),
    totalPrincipal: big(pool.totalPrincipal),
    baseRateBps: pool.baseRateBps,
    ticketsPerUsdc: pool.ticketsPerUsdc,
    bonusCapBps: pool.bonusCapBps,
    bonusEpoch: big(pool.bonusEpoch),
    bonusGranted: big(pool.bonusGranted),
    version: pool.version,
    shutdown: pool.shutdown,
    gamePaused: pool.gamePaused,
    jackpotPaused: pool.jackpotPaused,
    weightTree: pool.weightTree.toBase58(),
    klendProgram: pool.klendProgram.toBase58(),
    klendMarket: pool.klendMarket.toBase58(),
    klendReserve: pool.klendReserve.toBase58(),
    klendCtoken: pool.klendCtoken.toBase58(),
    yieldIndex: pool.yieldIndex.toString(),
    venueValue: big(pool.venueValue),
    lastSyncAt: big(pool.lastSyncAt),
    yieldOwed: big(pool.yieldOwed),
    feeOwed: big(pool.feeOwed),
    prizeOwed: big(pool.prizeOwed),
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

export function roundRow(round: DecodedRound, poolAddress: string): Prisma.RoundUncheckedCreateInput {
  return {
    poolAddress,
    id: big(round.roundId),
    epochId: big(round.epochId),
    startsAt: big(round.startsAt),
    endsAt: big(round.endsAt),
    status: round.status,
    pot: big(round.pot),
    houseCut: big(round.houseCut),
    // `winning_tile` is 0 on an unsettled round, which is also a real tile.
    winningTile: TILE_DECIDED.includes(round.status) ? round.winningTile : null,
    tileTotals: round.tileTotals.map((total) => total.toString()),
  };
}

export function playerRow(player: DecodedPlayer, poolAddress: string): Prisma.PlayerUncheckedCreateInput {
  return {
    poolAddress,
    owner: player.owner.toBase58(),
    principal: big(player.principal),
    entries: big(player.entries),
    epochId: big(player.epochId),
    isHouse: player.isHouse,
    pendingWithdraw: big(player.pendingWithdraw),
    pendingEpoch: big(player.pendingEpoch),
    requestedAt: big(player.requestedAt),
    boughtEpoch: big(player.boughtEpoch),
    boughtAmount: big(player.boughtAmount),
    bonusEpoch: big(player.bonusEpoch),
    bonusGranted: big(player.bonusGranted),
    yieldIndex: player.yieldIndex.toString(),
    leafIndex: player.leafIndex,
    pendingDeposit: big(player.pendingDeposit),
    pendingDepositEpoch: big(player.pendingDepositEpoch),
  };
}

export function positionRow(
  address: PublicKey,
  position: DecodedPosition,
  roundId: bigint,
  poolAddress: string,
): Prisma.PositionUncheckedCreateInput {
  return {
    address: address.toBase58(),
    poolAddress,
    owner: position.owner.toBase58(),
    roundId,
    tiles: big(position.tiles),
    stakePerTile: big(position.stakePerTile),
  };
}
