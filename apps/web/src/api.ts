/**
 * Indexer REST client (spec §3.5). Ticket 07: the Indexer is the browser's
 * read model, the only path by which it learns about the protocol — a read
 * model may not be bypassed, unlike a cache, and the chain stays
 * authoritative behind it. Nothing here throws: a failed call comes back as
 * `{ ok: false, reason }` so a screen can show a banner instead of crashing.
 *
 * Every u64/u128/timestamp arrives as a decimal string (spec §3.2), so these
 * types say `string` and the UI converts with BigInt where it needs to.
 *
 * These types were checked against the landed backend (ticket 08:
 * `apps/backend/src/api/`), not just the spec. Four shapes differ from a plain
 * reading of §3.5, and the backend is right in each case: `/pool` names its
 * fields `currentEpoch` and `openRound` and sends the round as a summary,
 * `/epochs/current` nests progress under `drawing`, `/leaderboard` sends a
 * subset of the Player row, and `odds` is a percentage string, not a fraction.
 */
import { API_URL } from "./chain.js";
import type { StatusValue } from "./lib/protocol.js";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** VITE_API_URL, or the local backend's default port. */
export const apiBaseUrl = (): string => API_URL;

/**
 * Ticket 16: every API fetch carries this timeout on top of whatever unmount
 * abort the caller already passes in — a hung backend must not freeze the
 * Vault on stale numbers forever. Plain copy, never the raw "Failed to
 * fetch" a bare `AbortError` would otherwise surface.
 */
export const FETCH_TIMEOUT_MS = 8_000;
export const TIMEOUT_MESSAGE = "Request timed out. Try again.";

/** Combines the caller's own abort (component unmount) with a fresh timeout,
 *  so either one aborts the fetch; `cancel()` releases the timer and the
 *  listener once the request settles either way. */
function withTimeout(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cancel: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function get<T>(
  baseUrl: string,
  path: string,
  signal?: AbortSignal | null,
): Promise<ApiResult<T>> {
  const timeout = withTimeout(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: timeout.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    if (timeout.timedOut()) return { ok: false, reason: TIMEOUT_MESSAGE };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  } finally {
    timeout.cancel();
  }
}

export interface PoolDto {
  address: string;
  poolId: string;
  admin: string;
  operator: string;
  pendingAdmin: string | null;
  mint: string;
  epochSeconds: string;
  epochAnchor: string;
  roundSeconds: string;
  /** Seconds before a Round's end that Positions close. */
  closeBuffer: string;
  minDeposit: string;
  /** Share of a settled round's pot credited to the House, in basis points. */
  houseCutBps: number;
  /** The ceiling on the depositor share of yield, in basis points. */
  baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. */
  ticketsPerUsdc: number;
  paused: boolean;
  /** Venue loss past the tolerance: the balance stops earning and exits take a haircut. */
  impaired: boolean;
  /** game-jackpot-pause: no new rounds or positions while true. A new pool
   *  starts with it on. */
  gamePaused: boolean;
  /** game-jackpot-pause: no new epoch, ticket purchase or draw close while
   *  true. A new pool starts with it on. */
  jackpotPaused: boolean;
  currentEpochId: string;
  currentEpochEndsAt: string;
  previousEpochEndsAt: string;
  totalPrincipal: string;
  updatedSlot: string;
  /** The Weight tree and the four pinned klend accounts every Player
   *  instruction that syncs names. Empty strings on a row not yet indexed. */
  weightTree: string;
  klendProgram: string;
  klendMarket: string;
  klendReserve: string;
  klendCtoken: string;
  /** Which backing the four pins point at: 0 klend, 1 the localnet stub. */
  venueKind: number;
}

export interface EpochDto {
  id: string;
  startsAt: string;
  endsAt: string;
  status: StatusValue;
  jackpotAmount: string;
  target: string;
  winner: string | null;
}

export interface RoundDto {
  id: string;
  epochId: string;
  startsAt: string;
  endsAt: string;
  status: StatusValue;
  pot: string;
  /** Entries the House took from the pot at settlement; "0" until then. */
  houseCut: string;
  /** Null until the round settles. */
  winningTile: number | null;
  tileTotals: string[];
}

/** What `GET /pool` carries for the open round: no tile totals, no winner. */
export type RoundSummaryDto = Pick<
  RoundDto,
  "id" | "epochId" | "startsAt" | "endsAt" | "status" | "pot"
>;

export interface PlayerDto {
  owner: string;
  principal: string;
  entries: string;
  epochId: string;
  isHouse: boolean;
  /** Requested but unpaid Principal, atomic units. "0" when nothing is pending. */
  pendingWithdraw: string;
  /** Epoch the pending amount was requested in; it pays out after that one ends. */
  pendingEpoch: string;
  /** The Principal deposited in `pendingDepositEpoch`, which earns no Ticket
   *  until the next epoch. Already inside `principal`. */
  pendingDeposit: string;
  pendingDepositEpoch: string;
  /** The Player's active Tickets in the current epoch: what the draw counts.
   *  Equal to `entries` unless a later epoch has begun since the Player last
   *  acted, when the Player holds their whole Principal. */
  weight: string;
  /** `pendingDeposit` while its epoch is current, "0" once it has folded. */
  pendingTickets: string;
  /** The epoch `pendingTickets` start counting in; null with nothing pending. */
  pendingActivatesEpoch: string | null;
  /** Share of the draw's Tickets as a percentage, two decimals: "12.34".
   *  Null while the backend cannot read the Weight tree's root. */
  odds: string | null;
}

/** `GET /leaderboard` sends a subset of the Player row, not the whole thing. */
export type LeaderboardRowDto = Pick<
  PlayerDto,
  "owner" | "principal" | "entries" | "isHouse" | "weight" | "odds"
>;

/**
 * `GET /players/:owner`: the Player row plus what `GET /state`'s embedded
 * `player` does not carry (ticket 10). The backend also sends `boughtToday`
 * and `grantedToday`; unmodeled here, since nothing in the web app reads them.
 */
export type PlayerExtrasDto = PlayerDto & {
  /** Yield earned since the last settle, as of the pool's last sync. */
  unsettledYield: string;
  /** Chain unix seconds of that sync. */
  syncedAt: string;
  /** USDC still spendable in `buy_tickets` today, capped at Principal. */
  buyAllowanceLeft: string;
  /** Chain unix seconds the queued withdrawal pays at: the earlier of the
   *  epoch's end and one epoch length after the request. Null with nothing queued. */
  pendingMaturesAt: string | null;
};

/** 404s with a human reason until the wallet has a Player (deposited once). */
export const fetchPlayer = (
  baseUrl: string,
  owner: string,
  signal?: AbortSignal,
): Promise<ApiResult<PlayerExtrasDto>> =>
  get<PlayerExtrasDto>(baseUrl, `/players/${owner}`, signal);

export interface EventDto {
  slot: string;
  signature: string;
  index: number;
  name: string;
  data: Record<string, unknown>;
  blockTime: string | null;
}

export interface OperatorStateDto {
  id: number;
  lastTickAt: string | null;
  /** When the crank plans to look again. It sleeps to a deadline, so a gap
   *  between ticks is only a stall once this has passed. */
  nextWakeAt: string | null;
  lastAction: string | null;
  /** Ticket 09: a stable error code (`operatorErrorCode` in the backend's
   *  api.service.ts), never the raw error text. `status.ts` maps it to
   *  generic copy for the pill. */
  lastError: string | null;
}

export interface StatusDto {
  /** Null until the operator has run one tick. */
  operator: OperatorStateDto | null;
  cursor: {
    lastSlot: string | null;
    lastSignature: string | null;
    /** Null means the indexer has never synced, which is not the same as 0. */
    ageSeconds: number | null;
  };
  rpcOk: boolean;
  slot: number | null;
  /** Irreversible once true (ops-and-envs ticket 08); false before the pool
   *  is indexed. See `shutdown.ts` for what the web does with this. */
  shutdown: boolean;
  /** Ticket 05: the deposit-only launch week's `LAUNCH_AT`, ISO, while the
   *  pool has no Epoch yet; null once an Epoch exists or none is configured. */
  launchAt: string | null;
}

/** A trailing paid rate; `aprBps` is null until two history points exist. */
export interface TrailingRateDto {
  aprBps: number | null;
  windowSeconds: number;
  shortHistory: boolean;
}

/** `GET /pool`'s `live` block (yield-claimer ticket 14). Rates are APR in bps. */
export interface LiveYieldDto {
  rates: {
    trailing24h: TrailingRateDto;
    trailing7d: TrailingRateDto;
    /** Null while the reserve or the vault is unreadable. */
    estimatedBps: number | null;
    /** The most depositors earn: `base_rate_bps`. */
    ceilingBps: number;
  };
  yieldFeeBps: number;
  /** The on-chain Bought Tickets pause. */
  buyTicketsPaused: boolean;
  /** Atomic USDC; null while the vault cannot be read. */
  freeIdle: string | null;
  /** While impaired, the share of a withdrawal the pool pays (0 to 1); else null. */
  haircutFactor: number | null;
}

export interface PoolSummaryDto {
  pool: PoolDto;
  currentEpoch: EpochDto | null;
  openRound: RoundSummaryDto | null;
  live: LiveYieldDto;
}

/** Draw progress for the epoch that just ended. */
export interface DrawingProgressDto {
  epochId: string;
  status: StatusValue;
}

export type CurrentEpochDto = EpochDto & {
  /** Null unless the previous epoch is Ended or Drawing. */
  drawing: DrawingProgressDto | null;
};

/** The caller's Position in `GET /state`'s tracked Round; see `StateDto.position`. */
export interface PositionDto {
  tiles: string;
  stakePerTile: string;
}

/**
 * Ticket 07: `GET /state`, the browser's one poll. `openRound` stays filtered
 * to Open/Requested; `round` is whichever Round the `round=` query asked
 * about, any status, so the browser can keep watching the same Round (and
 * `position` inside it) straight through settlement without a chain read of
 * its own.
 */
export interface StateDto {
  pool: PoolDto;
  /** Ticket 05: null before the Pool has ever had an Epoch (deposit-only
   *  launch week) — see `launchAt` for the countdown target that goes with it. */
  currentEpoch: CurrentEpochDto | null;
  openRound: RoundSummaryDto | null;
  round: RoundDto | null;
  player: PlayerDto | null;
  position: PositionDto | null;
  status: StatusDto;
  /** Chain time as the backend last observed it, extrapolated to now (decimal, unix seconds). */
  chainTime: string;
  /**
   * Ticket 08: the backend's cached priority-fee estimate (production-
   * hardening ticket 04) over the pool's hot writable accounts, in
   * micro-lamports per compute unit. Untrusted the moment it arrives here —
   * `/state` is unauthenticated input — so nothing signs with it directly;
   * `read.ts`'s `poolFromDto` validates and caps it before the send helper
   * ever sees it.
   */
  priorityFeeMicroLamports: number;
  /** Ticket 05: the deposit-only launch week's `LAUNCH_AT`, ISO, present
   *  only while `currentEpoch` is null; null once an Epoch exists or none is
   *  configured. */
  launchAt: string | null;
}

/** The Round or epoch a permissionless crank would accept right now. */
export interface StuckItemDto {
  id: string;
  status: number;
}

/** `GET /ops/summary`: the `/status` payload plus what the Ops console shows.
 *  Amounts are atomic USDC strings; nulls mean unknown or not indexed. */
export interface OpsSummaryDto extends StatusDto {
  pendingWithdrawals: string;
  /** The principal vault's balance; null when the read failed. */
  vaultLiquidity: string | null;
  solvencyMargin: string | null;
  freeIdle: string | null;
  freeIdleBps: number | null;
  freeIdleBelowFloor: boolean | null;
  reserveUtilizationBps: number | null;
  reserveFreeLiquidity: string | null;
  impaired: boolean;
  deployPaused: boolean;
  totalPrincipal: string;
  venueValue: string;
  feeOwed: string;
  prizeOwed: string;
  yieldOwed: string;
  deficit: string;
  /** Chain unix seconds of the last Sync; "0" before the pool is indexed. */
  lastSyncAt: string;
  admin: string | null;
  venueParams: {
    yieldFeeBps: number;
    idleFloorBps: number;
    idleTargetBps: number;
    reserveShareCapBps: number;
    reserveLiquidityFloorBps: number;
    minVenueMove: string;
    lossToleranceBps: number;
  } | null;
  /** klend's supply rate in bps; null when the reserve cannot be read. */
  supplyRateBps: number | null;
  harvestedToTreasury: string;
  harvestedToJackpot: string;
  /** Null when the backend's chain read failed: unknown, not clean. */
  stuck: { round: StuckItemDto | null; epoch: StuckItemDto | null } | null;
}

export const fetchOpsSummary = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<OpsSummaryDto>> => get<OpsSummaryDto>(baseUrl, "/ops/summary", signal);

export const fetchPoolSummary = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<PoolSummaryDto>> => get<PoolSummaryDto>(baseUrl, "/pool", signal);

/** One UTC day of `GET /rates/daily`: APR in bps, null for a day with no point. */
export interface DailyRateDto {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  aprBps: number | null;
}

export const fetchDailyRates = (
  baseUrl: string,
  days: number,
  signal?: AbortSignal,
): Promise<ApiResult<DailyRateDto[]>> =>
  get<DailyRateDto[]>(baseUrl, `/rates/daily?days=${days}`, signal);

/** One firing alert from `GET /alerts`. `code` is the backend's AlertCode. */
export interface AlertDto {
  code: string;
  message: string;
}

/**
 * `GET /alerts` answers 503 with `{ alerts }` while any alert fires and 200
 * with an empty list otherwise, so a 503 carrying that body is data, not a
 * failure. Any other non-200 is a failure.
 */
export async function fetchAlerts(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<AlertDto[]>> {
  const timeout = withTimeout(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/alerts`, {
      signal: timeout.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok && response.status !== 503) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { alerts?: AlertDto[] };
    if (!Array.isArray(body.alerts)) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: body.alerts };
  } catch (error) {
    if (timeout.timedOut()) return { ok: false, reason: TIMEOUT_MESSAGE };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  } finally {
    timeout.cancel();
  }
}

export const fetchEpochs = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<EpochDto[]>> =>
  get<EpochDto[]>(baseUrl, `/epochs?limit=${limit}`, signal);

export const fetchRounds = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<RoundDto[]>> =>
  get<RoundDto[]>(baseUrl, `/rounds?limit=${limit}`, signal);

export const fetchRound = (
  baseUrl: string,
  roundId: bigint | string,
  signal?: AbortSignal,
): Promise<ApiResult<RoundDto>> =>
  get<RoundDto>(baseUrl, `/rounds/${roundId}`, signal);

export const fetchLeaderboard = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<LeaderboardRowDto[]>> =>
  get<LeaderboardRowDto[]>(baseUrl, `/leaderboard?limit=${limit}`, signal);

/**
 * With `owner`, only that wallet's rows: the backend matches both `owner` and
 * `winner` inside the event payload, so a JackpotPaid (which has no `owner`
 * field) still reaches the winner's own history.
 */
export const fetchFeed = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
  owner?: string,
): Promise<ApiResult<EventDto[]>> =>
  get<EventDto[]>(
    baseUrl,
    `/feed?limit=${limit}${owner ? `&owner=${owner}` : ""}`,
    signal,
  );

/** One key per requested owner, 0 rather than a missing key when they played none. */
export interface PositionCountsDto {
  counts: Record<string, number>;
}

/**
 * How many rounds each of `owners` has played, batched: the dashboard asks for
 * a whole table of winners at once. The backend caps the list at 25.
 */
export const fetchPositionCounts = (
  baseUrl: string,
  owners: readonly string[],
  signal?: AbortSignal,
): Promise<ApiResult<PositionCountsDto>> =>
  get<PositionCountsDto>(
    baseUrl,
    `/positions/counts?owners=${owners.join(",")}`,
    signal,
  );

/**
 * Ticket 07: the one poll every screen reads from (see `useStatePoll.ts`).
 * `round`, when given, names whichever Round the caller wants the full state
 * of, whatever its status — pass the last Round seen open, so the browser
 * keeps watching it straight through settlement.
 */
export const fetchState = (
  baseUrl: string,
  owner: string | undefined,
  round: string | undefined,
  signal?: AbortSignal,
): Promise<ApiResult<StateDto>> => {
  const params = new URLSearchParams();
  if (owner) params.set("owner", owner);
  if (round) params.set("round", round);
  const query = params.toString();
  return get<StateDto>(baseUrl, `/state${query ? `?${query}` : ""}`, signal);
};

export const fetchHealth = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ ok: true }>> =>
  get<{ ok: true }>(baseUrl, "/healthz", signal);

/** Ticket 09: the private-beta gate. `reason` is a short human sentence, not a code. */
export interface AccessDto {
  allowed: boolean;
  reason: string;
}

export const fetchAccess = (
  baseUrl: string,
  wallet: string,
  signal?: AbortSignal,
): Promise<ApiResult<AccessDto>> =>
  get<AccessDto>(baseUrl, `/access/${wallet}`, signal);

/**
 * `POST /access/redeem`. "no uses left" and "wallet already redeemed" are
 * both a 409, so telling them apart needs the backend's message text, not
 * just the status: this returns its own result shape (carrying `status`)
 * instead of the shared `ApiResult`, same as `FaucetResult` below.
 */
export type RedeemAccessResult =
  | { ok: true; data: AccessDto }
  | { ok: false; status: number | null; reason: string };

export async function redeemAccess(
  baseUrl: string,
  wallet: string,
  code: string,
  signature: string,
  referralCode?: string,
  signal?: AbortSignal,
): Promise<RedeemAccessResult> {
  const timeout = withTimeout(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/access/redeem`, {
      method: "POST",
      signal: timeout.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ wallet, code, signature, ...(referralCode ? { referralCode } : {}) }),
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<AccessDto> & { message?: string })
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: body?.message ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, data: { allowed: body?.allowed ?? true, reason: body?.reason ?? "" } };
  } catch (error) {
    return {
      ok: false,
      status: null,
      reason: timeout.timedOut()
        ? TIMEOUT_MESSAGE
        : error instanceof Error
          ? error.message
          : "indexer offline",
    };
  } finally {
    timeout.cancel();
  }
}

/** `POST /referrals/apply` (ticket 02): applies a `?ref=CODE` for a wallet
 *  already past the beta gate. `applied: false` is never an error and never
 *  shown to the user (spec.md "?ref= capture"): `ok: false` here only means
 *  the request itself failed to reach the server. */
export async function applyReferral(
  baseUrl: string,
  wallet: string,
  code: string,
  signature: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ applied: boolean; reason: string }>> {
  try {
    const response = await fetch(`${baseUrl}/referrals/apply`, {
      method: "POST",
      signal: signal ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ wallet, code, signature }),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as { applied: boolean; reason: string } };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}

/** One of the wallet's own Invite codes (ticket 07); no web UI shows these
 *  yet. */
export interface InviteCodeDto {
  code: string;
  redeemed: boolean;
}

/** spec.md "Referrals API response": Active / N days left / Under $50. */
export type ReferralStatus = "qualified" | "holding" | "below";

/** One Your Team row (referral-page ticket 05, Figma 204:12548); wallet
 *  already masked server-side. */
export interface ReferralItemDto {
  wallet: string;
  status: ReferralStatus;
  /** Whole days left before qualifying; null except while `status` is
   *  "holding". */
  daysLeft: number | null;
  /** Atomic Ticket decimal string: this referral's own share of the
   *  Referrer's `bonusToday.amount` for today's draw. */
  bonusToday: string;
  /** Unix seconds (decimal string) the referral bound. */
  joinedAt: string;
}

/** `referrals` (referral-page ticket 05): the web reads only the first page
 *  (spec.md "no load-more control"), so nothing here paginates further. */
export interface ReferralsPageDto {
  items: ReferralItemDto[];
  nextCursor: string | null;
}

/** A referral rate tier (referral-page ticket 03): tier 0 means no rate yet;
 *  `maxCount` is null at the top tier (11+), which has no upper bound. */
export interface ReferralBandDto {
  tier: number;
  rateBps: number;
  minCount: number;
  maxCount: number | null;
}

/** `GET /referrals/:wallet` (ticket 11). */
export interface ReferralsDto {
  /** The wallet's own Referral code (referral-page ticket 01); null before
   *  its first deposit, since the indexer mints one on the first Deposited
   *  event. */
  referralCode: string | null;
  inviteCodes: InviteCodeDto[];
  referrals: ReferralsPageDto;
  qualifiedCount: number;
  /** Current band (referral-page ticket 03). */
  band: ReferralBandDto;
  /** The next, higher band; null at the top band (11+). */
  nextBand: ReferralBandDto | null;
  /** referral-page ticket 04: atomic Ticket decimal strings. `uncapped` is
   *  what the Referrer would get without their own Principal capping it;
   *  equal to `amount` when that cap doesn't bind. `bonusYesterday` is gone. */
  bonusToday: { amount: string; uncapped: string };
}

export const fetchReferrals = (
  baseUrl: string,
  wallet: string,
  signal?: AbortSignal,
): Promise<ApiResult<ReferralsDto>> => get<ReferralsDto>(baseUrl, `/referrals/${wallet}`, signal);

export interface FaucetGrant {
  owner: string;
  tokenAccount: string;
  /** USDC minted, atomic units, decimal string. */
  amount: string;
  signature: string;
  /** Unix seconds the same wallet may ask again. */
  nextRequestAt: string;
}

/**
 * The faucet is rate limited per owner. A 429 is not a failure to report as
 * "offline": it carries the wait, so the Vault can count down.
 */
export type FaucetResult =
  | { ok: true; data: FaucetGrant }
  | { ok: false; retryAfterSeconds: number }
  | { ok: false; reason: string };

export async function requestFaucet(
  baseUrl: string,
  owner: string,
  signal?: AbortSignal,
): Promise<FaucetResult> {
  try {
    const response = await fetch(`${baseUrl}/faucet`, {
      method: "POST",
      signal: signal ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ owner }),
    });
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        retryAfterSeconds?: number;
      };
      return { ok: false, retryAfterSeconds: body.retryAfterSeconds ?? 3600 };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as FaucetGrant };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}
