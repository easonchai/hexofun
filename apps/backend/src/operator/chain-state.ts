// The slice of on-chain state one tick needs, decoded out of Anchor's BN/
// PublicKey soup into plain bigints so the step logic (and its tests) never
// touch a coder. Mirrors programs/hex_vault/src/state.rs and constants.rs.
import type { Idl, Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

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

export interface PoolState {
  readonly address: PublicKey;
  readonly admin: PublicKey;
  readonly operator: PublicKey;
  readonly acceptedMint: PublicKey;
  readonly treasury: PublicKey;
  readonly buybackReserve: PublicKey;
  readonly house: PublicKey;
  readonly vrfNetworkState: PublicKey;
  readonly epochSeconds: bigint;
  readonly roundSeconds: bigint;
  readonly closeBuffer: bigint;
  readonly vrfTimeout: bigint;
  /** Seconds past an epoch's `drawnAt` before an unpaid Drawn epoch may roll over. */
  readonly payoutTimeout: bigint;
  readonly paused: boolean;
  readonly currentEpochId: bigint;
  readonly nextRoundId: bigint;
  readonly openRoundId: bigint;
  readonly totalPrincipal: bigint;
  /** Admin-only and irreversible: stops every inflow, the game and the
   *  draw, and lets withdrawals skip the epoch lock (ops-and-envs ticket
   *  02). The operator reads this to stop the epoch and round loops. */
  readonly shutdown: boolean;
  /** Game pause (game-jackpot-pause ticket 02): the tick opens no Round
   *  while this is set. A new pool starts with it on. */
  readonly gamePaused: boolean;
  /** Jackpot pause (game-jackpot-pause ticket 02): the tick skips
   *  begin_epoch, grant_tickets and request_draw while this is set.
   *  A new pool starts with it on. */
  readonly jackpotPaused: boolean;
  /** The pool's Weight tree account (`has_one` on every instruction that
   *  changes Tickets), and the four klend addresses pinned at `create_pool`.
   *  Under a `test-venue` build `klendProgram` is the hex_vault program. */
  readonly weightTree: PublicKey;
  readonly klendProgram: PublicKey;
  readonly klendMarket: PublicKey;
  readonly klendReserve: PublicKey;
  readonly klendCtoken: PublicKey;
  /** Withdrawals requested and not yet paid; not free idle. */
  readonly pendingWithdrawals: bigint;
  /** The pool's position at the venue as of the last sync. */
  readonly venueValue: bigint;
  /** Owed to the Treasury and the jackpot vault, paid out by `harvest`. */
  readonly feeOwed: bigint;
  readonly prizeOwed: bigint;
  /** Idle band, in basis points of free idle plus venue value. */
  readonly idleFloorBps: number;
  readonly idleTargetBps: number;
  /** Smallest deploy or recall the program accepts. */
  readonly minVenueMove: bigint;
  /** Admin or Operator set; the program refuses `deploy_to_venue` while on. */
  readonly deployPaused: boolean;
  /** A venue loss beyond tolerance; deploy and harvest are refused. */
  readonly impaired: boolean;
}

export interface EpochState {
  readonly epochId: bigint;
  readonly startsAt: bigint;
  readonly endsAt: bigint;
  readonly status: number;
  readonly jackpotAmount: bigint;
  readonly vrfSeed: Uint8Array;
  readonly requestedAt: bigint;
  readonly target: bigint;
  /** When `draw` landed, 0 until then. */
  readonly drawnAt: bigint;
  /** When `begin_epoch` moved this epoch to Ended, 0 until then. The program
   *  measures the `rollover_epoch` deadline of an epoch nobody sent to
   *  `request_draw` from the later of this and `endsAt`. The field is still
   *  called `registration_opened_at` on chain. */
  readonly endedAt: bigint;
}

export interface RoundState {
  readonly roundId: bigint;
  readonly endsAt: bigint;
  readonly status: number;
  readonly vrfSeed: Uint8Array;
  readonly requestedAt: bigint;
}

/** Only the field the Sparring player spends; add more when something needs them. */
export interface PlayerState {
  readonly entries: bigint;
}

/** Anchor hands back BN for u64/u128 and number[] for byte arrays. */
type Decoded = Record<
  string,
  { toString(): string } | number | boolean | PublicKey | number[]
>;

const big = (value: unknown): bigint => BigInt(String(value));

export function decodePool(
  program: Program<Idl>,
  address: PublicKey,
  data: Buffer,
): PoolState {
  const raw = program.coder.accounts.decode<Decoded>("pool", data);
  return {
    address,
    admin: raw.admin as PublicKey,
    operator: raw.operator as PublicKey,
    acceptedMint: raw.acceptedMint as PublicKey,
    treasury: raw.treasury as PublicKey,
    buybackReserve: raw.buybackReserve as PublicKey,
    house: raw.house as PublicKey,
    vrfNetworkState: raw.vrfNetworkState as PublicKey,
    epochSeconds: big(raw.epochSeconds),
    roundSeconds: big(raw.roundSeconds),
    closeBuffer: big(raw.closeBuffer),
    vrfTimeout: big(raw.vrfTimeout),
    payoutTimeout: big(raw.payoutTimeout),
    paused: raw.paused === true,
    currentEpochId: big(raw.currentEpochId),
    nextRoundId: big(raw.nextRoundId),
    openRoundId: big(raw.openRoundId),
    totalPrincipal: big(raw.totalPrincipal),
    shutdown: raw.shutdown === true,
    gamePaused: raw.gamePaused === true,
    jackpotPaused: raw.jackpotPaused === true,
    weightTree: raw.weightTree as PublicKey,
    klendProgram: raw.klendProgram as PublicKey,
    klendMarket: raw.klendMarket as PublicKey,
    klendReserve: raw.klendReserve as PublicKey,
    klendCtoken: raw.klendCtoken as PublicKey,
    pendingWithdrawals: big(raw.pendingWithdrawals),
    venueValue: big(raw.venueValue),
    feeOwed: big(raw.feeOwed),
    prizeOwed: big(raw.prizeOwed),
    idleFloorBps: Number(raw.idleFloorBps),
    idleTargetBps: Number(raw.idleTargetBps),
    minVenueMove: big(raw.minVenueMove),
    deployPaused: raw.deployPaused === true,
    impaired: raw.impaired === true,
  };
}

export function decodeEpoch(program: Program<Idl>, data: Buffer): EpochState {
  const raw = program.coder.accounts.decode<Decoded>("epoch", data);
  return {
    epochId: big(raw.epochId),
    startsAt: big(raw.startsAt),
    endsAt: big(raw.endsAt),
    status: Number(raw.status),
    jackpotAmount: big(raw.jackpotAmount),
    vrfSeed: Uint8Array.from(raw.vrfSeed as number[]),
    requestedAt: big(raw.requestedAt),
    target: big(raw.target),
    drawnAt: big(raw.drawnAt),
    endedAt: big(raw.registrationOpenedAt),
  };
}

export function decodeRound(program: Program<Idl>, data: Buffer): RoundState {
  const raw = program.coder.accounts.decode<Decoded>("round", data);
  return {
    roundId: big(raw.roundId),
    endsAt: big(raw.endsAt),
    status: Number(raw.status),
    vrfSeed: Uint8Array.from(raw.vrfSeed as number[]),
    requestedAt: big(raw.requestedAt),
  };
}

export function decodePlayer(program: Program<Idl>, data: Buffer): PlayerState {
  const raw = program.coder.accounts.decode<Decoded>("player", data);
  return { entries: big(raw.entries) };
}

/**
 * `unix_timestamp` out of the Clock sysvar: slot, epoch_start_timestamp,
 * epoch, leader_schedule_epoch, then the i64 we want at offset 32. The tick
 * compares against on-chain deadlines, and a test validator's slot-derived
 * clock drifts from wall time under load, so `Date.now()` is not usable here.
 */
export function clockUnixTimestamp(data: Buffer | undefined): bigint {
  if (!data || data.length < 40) {
    throw new Error("clock sysvar account is missing or truncated");
  }
  return data.readBigInt64LE(32);
}
