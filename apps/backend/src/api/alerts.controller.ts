import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { HexVaultEnv } from "../config/env";
import { VENUE_LOCK_SECONDS } from "../chain/venue-kind";
import { PrismaService } from "../prisma/prisma.service";
import { MAX_SNAPSHOT_DEPTH } from "../snapshot/sum-tree";
import { ApiService, EPOCH_OPEN } from "./api.service";
import { RoundsService } from "./rounds.service";

/** production-hardening ticket 05's codes, kept identical to
 *  docs/ops/incidents.md's playbook headers. */
export type AlertCode =
  | "OPERATOR_SOL_LOW"
  | "OPERATOR_STALE"
  | "RPC_DOWN"
  | "RPC_FALLBACK_ACTIVE"
  | "INDEXER_STALE"
  | "WITHDRAW_SHORTFALL"
  | "EPOCH_ROLLED_OVER_RECENTLY"
  | "WITHDRAW_OWNERS_SKIPPED"
  | "OPERATOR_SOL_READ_FAILED"
  | "OPERATOR_FAILING"
  | "EPOCH_NO_PROGRESS"
  | "DRAWN_UNPAID"
  | "SPARRING_SOL_LOW"
  | "JACKPOT_LOW_NEAR_CLOSE"
  | "WITHDRAW_FORECAST_SHORT"
  | "SOLVENCY_NEGATIVE"
  | "FREE_IDLE_LOW"
  | "RESERVE_LIQUIDITY_LOW"
  | "POOL_IMPAIRED"
  | "DEPLOY_PAUSED"
  | "VENUE_PROPOSED"
  | "PARAMS_CHANGED"
  | "TICKET_LEDGER_MISMATCH"
  | "SNAPSHOT_MISMATCH"
  | "SNAPSHOT_NEAR_CAP"
  | "EVENT_LOG_TRUNCATED"
  | "ROUND_SETTLE_FAILED";

export interface Alert {
  code: AlertCode;
  message: string;
}

/** Not env-tunable: spec.md's alerts decision only names `OPERATOR_SOL_WARN`,
 *  `ALERT_TICK_STALE_S` and `ALERT_INDEXER_STALE_S` as thresholds. */
export const RPC_FALLBACK_RECENT_MS = 10 * 60 * 1000;
export const ROLLOVER_RECENT_S = 60 * 60;
/** mainnet-readiness-fixes 04: how long `PARAMS_CHANGED` stays up after a
 *  `ParamsSet` event, long enough for a once-a-minute monitor to page. */
export const PARAMS_CHANGED_RECENT_S = 60 * 60;
/** Ticket holders the snapshot can fit, `2^MAX_SNAPSHOT_DEPTH`. Past it the
 *  cutoff's `buildSumTree` throws and the indexer stops at that `EpochBegan`,
 *  so `SNAPSHOT_NEAR_CAP` pages at this share of it. */
export const SNAPSHOT_LEAF_CAP = 2 ** MAX_SNAPSHOT_DEPTH;
export const SNAPSHOT_NEAR_CAP_SHARE = 0.9;
/** audit-2026-10-09 06: how long `EVENT_LOG_TRUNCATED` stays up after the
 *  indexer records a cut-off log. There is no acknowledge path for alerts, so
 *  the window is the clear; three days outlasts a weekend. */
export const TRUNCATED_LOG_RECENT_S = 3 * 24 * 60 * 60;
/** Ticket 09: how long the operator's last error may persist, while ticks
 *  keep running, before OPERATOR_FAILING pages someone. Not env-tunable, for
 *  the same reason as the two constants above. */
export const OPERATOR_FAILING_SECONDS = 5 * 60;
/** Ticket 09: "inside the last hour before close" for the jackpot and
 *  principal-out conditions, straight from spec.md's own wording. */
export const NEAR_CLOSE_SECONDS = 60 * 60;
/** A negative solvency margin smaller than this is rounding dust from a
 *  redeem, which the program charges to the fee owed (spec "Sync"). */
export const SOLVENCY_DUST = 10n;

/** The pool's open venue proposal: the pins it would move the pool to. */
export interface VenueProposalAlert {
  venueKind: number;
  klendProgram: string;
  klendMarket: string;
  klendReserve: string;
  klendCtoken: string;
  /** Chain unix seconds when the migration may run. */
  unlocksAt: bigint;
}

/** Everything `evaluateAlerts` needs, already resolved to plain values so it
 *  stays DB- and chain-free and is cheap to seed from a test. */
export interface AlertInputs {
  /** `/status`'s `operatorSolLow`; null (a failed chain read) never alerts,
   *  matching `operatorHealthStatus` in health.controller.ts. */
  operatorSolLow: boolean | null;
  /** Seconds since the operator's last tick, or null before its first one. */
  tickAgeSeconds: number | null;
  /** Admin-only and irreversible (ops-and-envs ticket 08): a shut-down pool
   *  stops ticking on purpose, so it never counts as stalled. */
  shutdown: boolean;
  rpcOk: boolean;
  /** Milliseconds since the last RPC failover, or null if there has never
   *  been one. */
  rpcFallbackAgeMs: number | null;
  /** Seconds since the indexer cursor last advanced, or null if it has
   *  never synced. */
  indexerAgeSeconds: number | null;
  /** OperatorState.withdrawShortfall, already 0n for "never checked" and
   *  "covered" alike (ApiService.getStatus already collapses the two). */
  withdrawShortfall: bigint;
  epochRolledOverRecently: boolean;
  /** Ticket 06: OperatorState.withdrawSkippedCount, 0 for "never checked"
   *  and "none skipped" alike. */
  withdrawSkippedCount: number;
  /** Ticket 09: seconds since the operator's last successful tick, while the
   *  current one is still failing; null when the last tick did not fail
   *  (OperatorState.lastError is null). `Infinity` stands for "never
   *  succeeded", which always trips the threshold. */
  operatorFailingSeconds: number | null;
  /** Ticket 09: OperatorState.epochNoProgress. */
  epochNoProgress: boolean;
  /** Ticket 09: OperatorState.drawnUnpaid. */
  drawnUnpaid: boolean;
  /** Off-chain-tickets 12: OperatorState.snapshotMismatch. */
  snapshotMismatch: boolean;
  /** Ticket 09: null when the sparring player is not configured, or its
   *  balance read failed; both read as "nothing to warn about" the same way
   *  a failed operator SOL read does not itself mean the operator is low. */
  sparringSolLow: boolean | null;
  /** Ticket 09: seconds until the current epoch's `endsAt`, only while it is
   *  still Open; null once it has closed or none is indexed yet. */
  secondsToEpochClose: number | null;
  /** Ticket 09: the live jackpot vault balance for the current Open epoch;
   *  null when the read failed. */
  jackpotAmount: bigint | null;
  /** Ticket 09: `Pool.minJackpot`; 0 before a pool is indexed. */
  minJackpot: bigint;
  /** Ticket 09: `Pool.pendingWithdrawals`, the total still owed. */
  pendingWithdrawals: bigint;
  /** Ticket 09: `/status`'s `vaultLiquidity`; null when the read failed. */
  vaultLiquidity: bigint | null;
  /** Ticket 14: `/status`'s `solvencyMargin`; null when the vault read failed. */
  solvencyMargin: bigint | null;
  /** Seconds free idle has been under the idle floor; null while it is not. */
  freeIdleLowSeconds: number | null;
  /** `/status`'s `reserveFreeLiquidity`; null when the reserve is unreadable. */
  reserveFreeLiquidity: bigint | null;
  impaired: boolean;
  deployPaused: boolean;
  /** The open venue proposal, null when there is none. */
  venueProposal: VenueProposalAlert | null;
  /** The newest `ParamsSet` event's values inside the last hour, null when
   *  there is none. Pool and nothing else is left out, so a new field on the
   *  event shows up here without a code change. */
  paramsChanged: Record<string, unknown> | null;
  /** Wallets whose `TicketBalance` differs from their ledger sum, or whose ledger
   *  Principal differs from their Player's, at the last nightly check; 0 before
   *  the first check. */
  ticketLedgerMismatches: number;
  /** Wallets holding Tickets now, the next snapshot's leaf count. */
  ticketHolders: number;
  /** Signatures of transactions whose log Solana cut off, recorded inside the
   *  last `TRUNCATED_LOG_RECENT_S`; newest first. */
  truncatedLogSignatures: string[];
  /** Closed Rounds the reveal sweep could not settle (audit-2026-10-09 08). */
  roundSettleFailed: readonly bigint[];
}

/** `/status`'s operator block, which both the alerts and the ops todo list read. */
type OperatorStatus = Awaited<ReturnType<ApiService["getStatus"]>>["operator"];

/** The two operator ages `AlertInputs` carries, from `/status`'s operator block. */
export function operatorAges(
  operator: OperatorStatus,
  nowSeconds: number,
): Pick<AlertInputs, "tickAgeSeconds" | "operatorFailingSeconds"> {
  const lastTickAt = operator?.lastTickAt;
  const lastError = operator?.lastError ?? null;
  const lastSuccessAt = operator?.lastSuccessAt ?? null;
  return {
    tickAgeSeconds: lastTickAt == null ? null : nowSeconds - Math.floor(lastTickAt.getTime() / 1000),
    // Ticket 09: null when the last tick did not fail; Infinity when it
    // failed but the operator has never once succeeded, which always trips
    // the threshold rather than reading as "just started failing".
    operatorFailingSeconds:
      lastError === null
        ? null
        : lastSuccessAt === null
          ? Number.POSITIVE_INFINITY
          : nowSeconds - Math.floor(lastSuccessAt.getTime() / 1000),
  };
}

export const isOperatorStale = (
  inputs: Pick<AlertInputs, "shutdown" | "tickAgeSeconds">,
  tickStaleSeconds: number,
): boolean =>
  !inputs.shutdown && inputs.tickAgeSeconds !== null && inputs.tickAgeSeconds > tickStaleSeconds;

export const isOperatorFailing = (inputs: Pick<AlertInputs, "operatorFailingSeconds">): boolean =>
  inputs.operatorFailingSeconds !== null && inputs.operatorFailingSeconds > OPERATOR_FAILING_SECONDS;

export interface AlertThresholds {
  tickStaleSeconds: number;
  indexerStaleSeconds: number;
  /** Seconds free idle may stay under the floor. */
  idleLowSeconds: number;
  /** Atomic USDC of reserve free liquidity below which `RESERVE_LIQUIDITY_LOW` fires. */
  reserveFreeMin: bigint;
}

/**
 * The active conditions for `inputs`, in the fixed order spec.md §5 lists
 * them. Pure and DB-free, like `operatorHealthStatus`, so every condition is
 * a direct unit test instead of a seeded round trip through Postgres.
 */
export function evaluateAlerts(inputs: AlertInputs, thresholds: AlertThresholds): Alert[] {
  const alerts: Alert[] = [];
  if (inputs.operatorSolLow === true) {
    alerts.push({
      code: "OPERATOR_SOL_LOW",
      message: "The operator's SOL balance is below OPERATOR_SOL_WARN.",
    });
  }
  if (inputs.operatorSolLow === null) {
    // Ticket 09: a failed read is not evidence the operator still has fees,
    // and it must not silently read as healthy either.
    alerts.push({
      code: "OPERATOR_SOL_READ_FAILED",
      message: "The operator's SOL balance could not be read.",
    });
  }
  if (isOperatorStale(inputs, thresholds.tickStaleSeconds)) {
    alerts.push({
      code: "OPERATOR_STALE",
      message: `The operator has not ticked in over ${thresholds.tickStaleSeconds}s.`,
    });
  }
  if (isOperatorFailing(inputs)) {
    // Distinct from OPERATOR_STALE: ticks are running (a fresh lastTickAt),
    // but every one of them has been failing for a while.
    alerts.push({
      code: "OPERATOR_FAILING",
      message: `The operator has not completed a tick without error in over ${OPERATOR_FAILING_SECONDS}s.`,
    });
  }
  if (!inputs.rpcOk) {
    alerts.push({ code: "RPC_DOWN", message: "The primary RPC is not responding." });
  }
  if (inputs.rpcFallbackAgeMs !== null && inputs.rpcFallbackAgeMs < RPC_FALLBACK_RECENT_MS) {
    alerts.push({
      code: "RPC_FALLBACK_ACTIVE",
      message: "The backend failed over to the fallback RPC in the last 10 minutes.",
    });
  }
  if (
    inputs.indexerAgeSeconds !== null &&
    inputs.indexerAgeSeconds > thresholds.indexerStaleSeconds
  ) {
    alerts.push({
      code: "INDEXER_STALE",
      message: `The indexer cursor has not advanced in over ${thresholds.indexerStaleSeconds}s.`,
    });
  }
  if (inputs.withdrawShortfall > 0n) {
    alerts.push({
      code: "WITHDRAW_SHORTFALL",
      message: "The principal vault fell short of a pending withdrawal on the last tick.",
    });
  }
  if (inputs.epochRolledOverRecently) {
    alerts.push({
      code: "EPOCH_ROLLED_OVER_RECENTLY",
      message: "An epoch rolled over without paying out in the last hour.",
    });
  }
  if (inputs.withdrawSkippedCount > 0) {
    alerts.push({
      code: "WITHDRAW_OWNERS_SKIPPED",
      message: `${inputs.withdrawSkippedCount} owner(s) skipped after repeated withdrawal failures this epoch.`,
    });
  }
  if (inputs.epochNoProgress) {
    alerts.push({
      code: "EPOCH_NO_PROGRESS",
      message: "The epoch has not reached a terminal status within its expected deadline.",
    });
  }
  if (inputs.drawnUnpaid) {
    alerts.push({
      code: "DRAWN_UNPAID",
      message: "The epoch drew a winner more than a few minutes ago and it is still unpaid.",
    });
  }
  if (inputs.snapshotMismatch) {
    alerts.push({
      code: "SNAPSHOT_MISMATCH",
      message: "The drawn epoch's winner proof does not match the committed snapshot root, and the operator has stopped retrying it.",
    });
  }
  if (inputs.sparringSolLow === true) {
    alerts.push({
      code: "SPARRING_SOL_LOW",
      message: "The sparring player's SOL balance is below OPERATOR_SOL_WARN.",
    });
  }
  const nearClose =
    inputs.secondsToEpochClose !== null &&
    inputs.secondsToEpochClose >= 0 &&
    inputs.secondsToEpochClose <= NEAR_CLOSE_SECONDS;
  if (nearClose && inputs.jackpotAmount !== null && inputs.jackpotAmount < inputs.minJackpot) {
    alerts.push({
      code: "JACKPOT_LOW_NEAR_CLOSE",
      message: "The jackpot vault is below min_jackpot inside the last hour before close.",
    });
  }
  if (inputs.vaultLiquidity !== null && inputs.pendingWithdrawals > inputs.vaultLiquidity) {
    alerts.push({
      code: "WITHDRAW_FORECAST_SHORT",
      message: "Due pending withdrawals are forecast to exceed vault liquidity.",
    });
  }
  if (inputs.solvencyMargin !== null && inputs.solvencyMargin < -SOLVENCY_DUST) {
    alerts.push({
      code: "SOLVENCY_NEGATIVE",
      message: "The vault plus the venue position no longer covers every balance.",
    });
  }
  if (inputs.freeIdleLowSeconds !== null && inputs.freeIdleLowSeconds > thresholds.idleLowSeconds) {
    alerts.push({
      code: "FREE_IDLE_LOW",
      message: `Free idle has been under the idle floor for over ${thresholds.idleLowSeconds}s.`,
    });
  }
  if (inputs.reserveFreeLiquidity !== null && inputs.reserveFreeLiquidity < thresholds.reserveFreeMin) {
    alerts.push({
      code: "RESERVE_LIQUIDITY_LOW",
      message: "The klend reserve's free liquidity is under ALERT_RESERVE_FREE_MIN.",
    });
  }
  if (inputs.impaired) {
    alerts.push({
      code: "POOL_IMPAIRED",
      message: "The venue reported a loss: exits pay a haircut and deploy and harvest are refused.",
    });
  }
  if (inputs.deployPaused) {
    alerts.push({ code: "DEPLOY_PAUSED", message: "Deployment to the venue is paused." });
  }
  if (inputs.venueProposal !== null) {
    const p = inputs.venueProposal;
    // The 48 hour lock is the window to cancel a proposal nobody expected.
    alerts.push({
      code: "VENUE_PROPOSED",
      message: `A venue proposal is open: kind ${p.venueKind}, klend program ${p.klendProgram}, market ${p.klendMarket}, reserve ${p.klendReserve}, cToken ${p.klendCtoken}; the migration unlocks at unix ${p.unlocksAt}.`,
    });
  }
  if (inputs.paramsChanged !== null) {
    const values = Object.entries(inputs.paramsChanged)
      .filter(([key]) => key !== "pool")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    alerts.push({
      code: "PARAMS_CHANGED",
      message: `set_params ran in the last hour with: ${values}.`,
    });
  }
  if (inputs.ticketLedgerMismatches > 0) {
    alerts.push({
      code: "TICKET_LEDGER_MISMATCH",
      message: `${inputs.ticketLedgerMismatches} wallets differ from their ledger rows or from their Player's Principal.`,
    });
  }
  if (inputs.roundSettleFailed.length > 0) {
    alerts.push({
      code: "ROUND_SETTLE_FAILED",
      message: `Round ${inputs.roundSettleFailed.join(", ")} could not settle and its stakes stay locked; the sweep retries every second.`,
    });
  }
  if (inputs.ticketHolders >= SNAPSHOT_LEAF_CAP * SNAPSHOT_NEAR_CAP_SHARE) {
    alerts.push({
      code: "SNAPSHOT_NEAR_CAP",
      message: `${inputs.ticketHolders} wallets hold Tickets; the snapshot fits ${SNAPSHOT_LEAF_CAP}, and past that the indexer stops at the next EpochBegan.`,
    });
  }
  if (inputs.truncatedLogSignatures.length > 0) {
    alerts.push({
      code: "EVENT_LOG_TRUNCATED",
      message: `Solana cut off the log of ${inputs.truncatedLogSignatures.join(", ")}, so its events were not read. Reconcile the wallets it touched.`,
    });
  }
  return alerts;
}

/**
 * One URL an external uptime monitor polls (spec.md item 5, ticket 05): 200
 * with an empty list when nothing needs a human, 503 with the active codes
 * otherwise. Separate from `/healthz`, which stays a pure liveness probe.
 *
 * Reads only `ApiService.getStatus()` (itself cached or DB-backed already,
 * same as `/status`) plus one extra Event query for the void/rollover
 * conditions, so a poll never costs a fresh RPC call. Not explicitly
 * throttled: api.module.ts's guard already skips every ApiController-style
 * read route, and this joins them.
 */
@Controller()
export class AlertsController {
  private readonly tickStaleSeconds: number;
  private readonly indexerStaleSeconds: number;
  private readonly idleLowSeconds: number;
  private readonly reserveFreeMin: bigint;
  /**
   * Wall-clock seconds `/status` first reported free idle under the floor, or
   * null while it is not. Kept in memory: a restart restarts the clock, which
   * only delays the alert by one window. ponytail: persist it in
   * OperatorState if restarts during a real shortfall turn out to matter.
   */
  private idleLowSince: number | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly prisma: PrismaService,
    config: ConfigService<HexVaultEnv, true>,
    private readonly rounds: RoundsService,
  ) {
    this.tickStaleSeconds = config.get("ALERT_TICK_STALE_S", { infer: true });
    this.indexerStaleSeconds = config.get("ALERT_INDEXER_STALE_S", { infer: true });
    this.idleLowSeconds = config.get("ALERT_IDLE_LOW_S", { infer: true });
    this.reserveFreeMin = BigInt(config.get("ALERT_RESERVE_FREE_MIN", { infer: true }));
  }

  @Get("alerts")
  async getAlerts(): Promise<{ alerts: Alert[] }> {
    const [status, recent, venueProposal, paramsChanged, ledgerCheck, ticketHolders, truncatedLogs] = await Promise.all([
      this.api.getStatus(),
      this.recentRollover(),
      this.openVenueProposal(),
      this.recentParamsSet(),
      this.prisma.ledgerCheck.findUnique({ where: { poolAddress: this.api.poolAddress } }),
      this.prisma.ticketBalance.count({ where: { poolAddress: this.api.poolAddress, tickets: { gt: 0n } } }),
      this.prisma.truncatedLog.findMany({
        where: { poolAddress: this.api.poolAddress, createdAt: { gte: new Date(Date.now() - TRUNCATED_LOG_RECENT_S * 1000) } },
        orderBy: { createdAt: "desc" },
        select: { signature: true },
      }),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsToEpochClose =
      status.epochStatus === EPOCH_OPEN && status.epochEndsAt !== null
        ? Number(status.epochEndsAt - BigInt(nowSeconds))
        : null;
    // A null reading (vault unknown) leaves the clock as it was: a failed read
    // is not evidence that idle recovered.
    if (status.freeIdleBelowFloor === false) this.idleLowSince = null;
    else if (status.freeIdleBelowFloor === true) this.idleLowSince ??= nowSeconds;
    const freeIdleLowSeconds = this.idleLowSince === null ? null : nowSeconds - this.idleLowSince;
    const alerts = evaluateAlerts(
      {
        operatorSolLow: status.operatorSolLow,
        ...operatorAges(status.operator, nowSeconds),
        shutdown: status.shutdown,
        rpcOk: status.rpcOk,
        rpcFallbackAgeMs:
          status.rpcFallbackAt === null ? null : Date.now() - status.rpcFallbackAt.getTime(),
        indexerAgeSeconds: status.cursor.ageSeconds,
        withdrawShortfall: status.withdrawShortfall,
        epochRolledOverRecently: recent.epochRolledOverRecently,
        withdrawSkippedCount: status.withdrawSkippedCount,
        epochNoProgress: status.operator?.epochNoProgress ?? false,
        drawnUnpaid: status.operator?.drawnUnpaid ?? false,
        snapshotMismatch: status.operator?.snapshotMismatch ?? false,
        sparringSolLow: status.sparringSolLow,
        secondsToEpochClose,
        jackpotAmount: status.jackpotAmount,
        minJackpot: status.minJackpot,
        pendingWithdrawals: status.pendingWithdrawals,
        vaultLiquidity: status.vaultLiquidity,
        solvencyMargin: status.solvencyMargin,
        freeIdleLowSeconds,
        reserveFreeLiquidity: status.reserveFreeLiquidity,
        impaired: status.impaired,
        deployPaused: status.deployPaused,
        venueProposal,
        paramsChanged,
        ticketLedgerMismatches: ledgerCheck?.mismatches ?? 0,
        ticketHolders,
        truncatedLogSignatures: truncatedLogs.map((row) => row.signature),
        roundSettleFailed: this.rounds.settleFailed(),
      },
      {
        tickStaleSeconds: this.tickStaleSeconds,
        indexerStaleSeconds: this.indexerStaleSeconds,
        idleLowSeconds: this.idleLowSeconds,
        reserveFreeMin: this.reserveFreeMin,
      },
    );
    if (alerts.length > 0) {
      // Nest serializes an HttpException's first argument as the body
      // as-is (faucet.controller.ts's 429 does the same), so this is the
      // exact { alerts } shape the 200 branch below returns.
      throw new HttpException({ alerts }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { alerts };
  }

  /** The `VenueProposal` row the indexer keeps while the account exists:
   *  `cancel_venue` and the migration delete it, so the alert ends with them. */
  private async openVenueProposal(): Promise<VenueProposalAlert | null> {
    const row = await this.prisma.venueProposal.findUnique({
      where: { poolAddress: this.api.poolAddress },
    });
    if (row === null) return null;
    return {
      venueKind: row.venueKind,
      klendProgram: row.klendProgram,
      klendMarket: row.klendMarket,
      klendReserve: row.klendReserve,
      klendCtoken: row.klendCtoken,
      unlocksAt: row.proposedAt + VENUE_LOCK_SECONDS,
    };
  }

  /** The newest `ParamsSet` event inside `PARAMS_CHANGED_RECENT_S`, as the
   *  decoder stored it (`decode.ts`'s camelCased field names). */
  private async recentParamsSet(): Promise<Record<string, unknown> | null> {
    const cutoff = BigInt(Math.floor(Date.now() / 1000) - PARAMS_CHANGED_RECENT_S);
    const row = await this.prisma.event.findFirst({
      where: { poolAddress: this.api.poolAddress, name: "ParamsSet", blockTime: { gte: cutoff } },
      orderBy: { slot: "desc" },
      select: { data: true },
    });
    const data = row?.data;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  }

  /** `EpochRolledOver` is one of `FEED_NAMES` in api.service.ts; `decode.ts`'s
   *  `declaredName` is what puts it in the Event table under that exact name. */
  private async recentRollover(): Promise<{ epochRolledOverRecently: boolean }> {
    const cutoff = BigInt(Math.floor(Date.now() / 1000) - ROLLOVER_RECENT_S);
    const row = await this.prisma.event.findFirst({
      where: { poolAddress: this.api.poolAddress, name: "EpochRolledOver", blockTime: { gte: cutoff } },
      select: { name: true },
    });
    return { epochRolledOverRecently: row !== null };
  }
}
