// The read model's live-yield arithmetic (yield-claimer ticket 14): what a
// Player has earned but not settled, the pool's trailing paid rate, the
// estimated current rate off klend's reserve, instant-withdraw cover, the
// haircut and the solvency margin. Pure, so each rule is a plain unit test;
// `api.service.ts` feeds it rows and balances.
//
// Rates are APR in basis points as plain numbers. `null` means unknown, never
// zero.

/** The Yield index is per unit of Principal, scaled by this (1e18). */
export const INDEX_SCALE = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;
const BPS = 10_000n;

/** Yield earned since the Player's last settle, as of the pool's last sync.
 *  Same rule as the program's `settle`: floor(principal x index rise / 1e18). */
export function unsettledYield(principal: bigint, poolIndex: bigint, playerIndex: bigint): bigint {
  if (poolIndex <= playerIndex) return 0n;
  return (principal * (poolIndex - playerIndex)) / INDEX_SCALE;
}

/**
 * The Tickets the draw counts for a Player in the current epoch. Same rule as
 * the program's `touch`: a Player last touched in an earlier epoch holds their
 * whole Principal, pending deposit included, so the pending fold is the same
 * branch as the reset.
 */
export function effectiveTickets(
  player: { principal: bigint; entries: bigint; epochId: bigint },
  currentEpochId: bigint,
): bigint {
  return player.epochId < currentEpochId ? player.principal : player.entries;
}

/** The part of Principal that earns no Ticket in the current epoch: the
 *  pending deposit while its epoch is current, 0 once it has folded. */
export function pendingTickets(
  player: { pendingDeposit: bigint; pendingDepositEpoch: bigint },
  currentEpochId: bigint,
): bigint {
  return player.pendingDepositEpoch < currentEpochId ? 0n : player.pendingDeposit;
}

export interface IndexPoint {
  /** Chain unix seconds of the sync the index was stamped at. */
  at: bigint;
  yieldIndex: bigint;
}

export interface TrailingRate {
  /** Annualised, in basis points. Null with no two points to compare. */
  aprBps: number | null;
  /** Seconds the figure actually spans. */
  windowSeconds: number;
  /** True when history was shorter than the window and what exists was used. */
  shortHistory: boolean;
}

/**
 * The index rise from `start` to `latest`, over the seconds between them,
 * times one year. `start` is the newest point at least `window` seconds before
 * `latest`; with none that old the caller passes the oldest point and this
 * says so in `shortHistory`.
 */
export function trailingRate(
  latest: IndexPoint,
  start: IndexPoint | null,
  window: number,
): TrailingRate {
  const elapsed = start === null ? 0n : latest.at - start.at;
  if (start === null || elapsed <= 0n) {
    return { aprBps: null, windowSeconds: 0, shortHistory: true };
  }
  const rise = latest.yieldIndex > start.yieldIndex ? latest.yieldIndex - start.yieldIndex : 0n;
  // Hundredths of a basis point, so a small rate keeps its decimals.
  const hundredths = (rise * SECONDS_PER_YEAR * BPS * 100n) / (INDEX_SCALE * elapsed);
  return {
    aprBps: Number(hundredths) / 100,
    windowSeconds: Number(elapsed),
    shortHistory: elapsed < BigInt(window),
  };
}

/** The fields of klend's `Reserve` the rate and liquidity figures need. */
export interface ReserveStats {
  /** Free liquidity: what a redeem can pay out now. */
  available: bigint;
  borrowed: bigint;
  /** Share of interest klend keeps, percent. */
  protocolTakeRatePct: number;
  /** `borrow_rate_curve`: (utilisation bps, borrow rate bps), ascending. */
  curve: readonly { utilBps: number; rateBps: number }[];
}

// Byte offsets into klend's `Reserve` (8-byte discriminator included). The
// first three are the same ones `tests/fork/klend.fork.ts` reads, checked
// against mainnet's USDC reserve; the take rate and the curve sit in
// `ReserveConfig`, which starts at 4856.
const AVAILABLE_AT = 224;
const BORROWED_SF_AT = 232;
const CONFIG_AT = 4856;
const TAKE_RATE_AT = CONFIG_AT + 14;
const CURVE_AT = CONFIG_AT + 64;
const CURVE_POINTS = 11;
/** klend's `Fraction` has 60 fractional bits. */
const FRACTION_BITS = 60n;
export const RESERVE_MIN_LEN = CURVE_AT + CURVE_POINTS * 8;

/** Reads the reserve out of raw account data. Throws on anything too short,
 *  so a stub reserve (a test-venue pool) fails loudly instead of decoding noise. */
export function decodeReserve(data: Buffer): ReserveStats {
  if (data.length < RESERVE_MIN_LEN) throw new Error("account is too short to be a klend reserve");
  const u128 = (at: number): bigint =>
    data.readBigUInt64LE(at) | (data.readBigUInt64LE(at + 8) << 64n);
  return {
    available: data.readBigUInt64LE(AVAILABLE_AT),
    borrowed: u128(BORROWED_SF_AT) >> FRACTION_BITS,
    protocolTakeRatePct: data.readUInt8(TAKE_RATE_AT),
    curve: Array.from({ length: CURVE_POINTS }, (_, i) => ({
      utilBps: data.readUInt32LE(CURVE_AT + i * 8),
      rateBps: data.readUInt32LE(CURVE_AT + i * 8 + 4),
    })),
  };
}

/**
 * What klend pays a supplier right now: the borrow rate at the current
 * utilisation, times utilisation, less klend's cut. An estimate, as klend's own
 * "Supply APY = Borrow rate x Utilization" is. Null for an empty reserve.
 */
export function supplyRateBps(reserve: ReserveStats): number | null {
  const supply = reserve.available + reserve.borrowed;
  if (supply === 0n) return null;
  const util = Number((reserve.borrowed * BPS) / supply);
  const { curve } = reserve;
  let borrowRate = curve[curve.length - 1]?.rateBps ?? 0;
  for (let i = 1; i < curve.length; i += 1) {
    const lo = curve[i - 1];
    const hi = curve[i];
    if (lo === undefined || hi === undefined || util > hi.utilBps) continue;
    const span = hi.utilBps - lo.utilBps;
    borrowRate =
      span <= 0 ? hi.rateBps : lo.rateBps + ((hi.rateBps - lo.rateBps) * (util - lo.utilBps)) / span;
    break;
  }
  return (borrowRate * (util / 10_000) * (100 - reserve.protocolTakeRatePct)) / 100;
}

/** Free idle: the principal vault less what is promised to queued withdrawals. */
export const freeIdle = (vault: bigint, pending: bigint): bigint =>
  vault > pending ? vault - pending : 0n;

/**
 * klend's supply rate times the deployed share of the pool, less the Yield
 * fee, capped at the ceiling. Null while either input is unknown.
 */
export function estimatedRateBps(inputs: {
  supplyRateBps: number | null;
  venueValue: bigint;
  freeIdle: bigint | null;
  yieldFeeBps: number;
  ceilingBps: number;
}): number | null {
  if (inputs.supplyRateBps === null || inputs.freeIdle === null) return null;
  const pool = inputs.venueValue + inputs.freeIdle;
  const deployed = pool === 0n ? 0 : Number((inputs.venueValue * BPS) / pool) / 10_000;
  const net = inputs.supplyRateBps * deployed * (1 - inputs.yieldFeeBps / 10_000);
  return Math.min(net, inputs.ceilingBps);
}

/** Whether an instant withdrawal of `amount` can be paid: free idle first,
 *  then a redeem of what the reserve has free and the pool holds there. */
export function instantWithdrawCoverable(
  amount: bigint,
  freeIdleAmount: bigint,
  venueValue: bigint,
  reserveAvailable: bigint,
): boolean {
  const redeemable = venueValue < reserveAvailable ? venueValue : reserveAvailable;
  return amount <= freeIdleAmount + redeemable;
}

export interface PoolAssets {
  totalPrincipal: bigint;
  pendingWithdrawals: bigint;
  venueValue: bigint;
  yieldOwed: bigint;
  feeOwed: bigint;
  prizeOwed: bigint;
  deficit: bigint;
}

/**
 * While impaired, the share of a withdrawal the pool pays: net assets over
 * claims, the same ratio as the program's `haircut`. 1 when not impaired.
 */
export function haircutFactor(pool: PoolAssets, vault: bigint): number {
  const owed = pool.yieldOwed + pool.feeOwed + pool.prizeOwed;
  const assets = vault + pool.venueValue;
  const net = assets > owed ? assets - owed : 0n;
  const claims = pool.totalPrincipal + pool.pendingWithdrawals;
  if (claims === 0n) return 0;
  const factor = Number((net * 1_000_000n) / claims) / 1_000_000;
  return Math.min(factor, 1);
}

/**
 * The program's solvency invariant as a signed margin: vault plus venue value,
 * less every liability, plus the recorded deficit. Zero or more is solvent.
 * Venue value is as of the last sync, so interest earned since is not in it.
 */
export function solvencyMargin(pool: PoolAssets, vault: bigint): bigint {
  const liabilities =
    pool.totalPrincipal +
    pool.pendingWithdrawals +
    pool.yieldOwed +
    pool.feeOwed +
    pool.prizeOwed -
    pool.deficit;
  return vault + pool.venueValue - liabilities;
}
