import { describe, expect, it } from "vitest";

import {
  evaluateAlerts,
  NEAR_CLOSE_SECONDS,
  OPERATOR_FAILING_SECONDS,
  SOLVENCY_DUST,
  TREE_NEARLY_FULL_BPS,
  type AlertInputs,
  type AlertThresholds,
} from "./alerts.controller";

const THRESHOLDS: AlertThresholds = {
  tickStaleSeconds: 300,
  indexerStaleSeconds: 600,
  idleLowSeconds: 3600,
  reserveFreeMin: 1_000_000n,
};

/** Every condition off: what a healthy pool reports. */
const HEALTHY: AlertInputs = {
  operatorSolLow: false,
  tickAgeSeconds: 10,
  shutdown: false,
  rpcOk: true,
  rpcFallbackAgeMs: null,
  indexerAgeSeconds: 5,
  withdrawShortfall: 0n,
  roundVoidedRecently: false,
  epochRolledOverRecently: false,
  withdrawSkippedCount: 0,
  operatorFailingSeconds: null,
  epochNoProgress: false,
  drawnUnpaid: false,
  sparringSolLow: false,
  secondsToEpochClose: 7 * 24 * 60 * 60,
  jackpotAmount: 5_000_000n,
  minJackpot: 1_000_000n,
  pendingWithdrawals: 0n,
  vaultLiquidity: 10_000_000n,
  solvencyMargin: 0n,
  freeIdleLowSeconds: null,
  reserveFreeLiquidity: 5_000_000n,
  impaired: false,
  deployPaused: false,
  treeUsedBps: 100,
  venueProposal: null,
  paramsChanged: null,
};

const PROPOSAL = {
  venueKind: 0,
  klendProgram: "KLendProgram111",
  klendMarket: "Market111",
  klendReserve: "Reserve111",
  klendCtoken: "Ctoken111",
  unlocksAt: 1_800_172_800n,
};

describe("evaluateAlerts", () => {
  it("is empty when every condition reads healthy", () => {
    expect(evaluateAlerts(HEALTHY, THRESHOLDS)).toEqual([]);
  });

  it("OPERATOR_SOL_LOW fires only on a true reading, not an unknown one", () => {
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: true }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_LOW", message: expect.any(String) },
    ]);
    // A failed chain read (null) is not evidence the operator is dry, matching
    // operatorHealthStatus in health.controller.ts, but it is its own
    // OPERATOR_SOL_READ_FAILED condition rather than reading as healthy
    // (ticket 09; see the dedicated test below).
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: null }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_READ_FAILED", message: expect.any(String) },
    ]);
  });

  it("OPERATOR_STALE fires once the last tick is older than the threshold", () => {
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 301 }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_STALE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 300 }, THRESHOLDS)).toEqual([]);
    // Never ticked yet reads as unknown, not stale.
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("a shutdown pool suppresses OPERATOR_STALE, because it stopped ticking on purpose", () => {
    expect(
      evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 10_000, shutdown: true }, THRESHOLDS),
    ).toEqual([]);
  });

  it("RPC_DOWN fires when the primary probe fails", () => {
    expect(evaluateAlerts({ ...HEALTHY, rpcOk: false }, THRESHOLDS)).toEqual([
      { code: "RPC_DOWN", message: expect.any(String) },
    ]);
  });

  it("RPC_FALLBACK_ACTIVE fires only within the 10-minute window", () => {
    expect(evaluateAlerts({ ...HEALTHY, rpcFallbackAgeMs: 5 * 60 * 1000 }, THRESHOLDS)).toEqual([
      { code: "RPC_FALLBACK_ACTIVE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, rpcFallbackAgeMs: 11 * 60 * 1000 }, THRESHOLDS)).toEqual(
      [],
    );
  });

  it("INDEXER_STALE fires once the cursor is older than the threshold", () => {
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: 601 }, THRESHOLDS)).toEqual([
      { code: "INDEXER_STALE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: 600 }, THRESHOLDS)).toEqual([]);
    // Never synced yet reads as unknown, not stale.
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("WITHDRAW_SHORTFALL fires once the last tick found the vault short", () => {
    expect(evaluateAlerts({ ...HEALTHY, withdrawShortfall: 1n }, THRESHOLDS)).toEqual([
      { code: "WITHDRAW_SHORTFALL", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, withdrawShortfall: 0n }, THRESHOLDS)).toEqual([]);
  });

  it("ROUND_VOIDED_RECENTLY and EPOCH_ROLLED_OVER_RECENTLY fire independently", () => {
    expect(evaluateAlerts({ ...HEALTHY, roundVoidedRecently: true }, THRESHOLDS)).toEqual([
      { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, epochRolledOverRecently: true }, THRESHOLDS)).toEqual([
      { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
    ]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, roundVoidedRecently: true, epochRolledOverRecently: true },
        THRESHOLDS,
      ),
    ).toEqual([
      { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
      { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
    ]);
  });

  it("WITHDRAW_OWNERS_SKIPPED fires once at least one owner has been skipped", () => {
    expect(evaluateAlerts({ ...HEALTHY, withdrawSkippedCount: 2 }, THRESHOLDS)).toEqual([
      { code: "WITHDRAW_OWNERS_SKIPPED", message: expect.stringContaining("2") },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, withdrawSkippedCount: 0 }, THRESHOLDS)).toEqual([]);
  });

  it("OPERATOR_SOL_READ_FAILED fires on a failed read rather than reading as healthy", () => {
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: null }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_READ_FAILED", message: expect.any(String) },
    ]);
  });

  it("OPERATOR_FAILING fires once the last success is older than the threshold, while ticks run", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: OPERATOR_FAILING_SECONDS + 1 },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "OPERATOR_FAILING", message: expect.any(String) }]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: OPERATOR_FAILING_SECONDS },
        THRESHOLDS,
      ),
    ).toEqual([]);
    // Never succeeded: always trips the threshold.
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: Number.POSITIVE_INFINITY },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "OPERATOR_FAILING", message: expect.any(String) }]);
    // A tick that is not currently failing reads null, not zero.
    expect(evaluateAlerts({ ...HEALTHY, operatorFailingSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("EPOCH_NO_PROGRESS and DRAWN_UNPAID fire independently off the operator's own read", () => {
    expect(evaluateAlerts({ ...HEALTHY, epochNoProgress: true }, THRESHOLDS)).toEqual([
      { code: "EPOCH_NO_PROGRESS", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, drawnUnpaid: true }, THRESHOLDS)).toEqual([
      { code: "DRAWN_UNPAID", message: expect.any(String) },
    ]);
  });

  it("SPARRING_SOL_LOW fires only on a true reading, not an unknown or disabled one", () => {
    expect(evaluateAlerts({ ...HEALTHY, sparringSolLow: true }, THRESHOLDS)).toEqual([
      { code: "SPARRING_SOL_LOW", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, sparringSolLow: null }, THRESHOLDS)).toEqual([]);
  });

  it("JACKPOT_LOW_NEAR_CLOSE fires only inside the last hour before close", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, jackpotAmount: 0n },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "JACKPOT_LOW_NEAR_CLOSE", message: expect.any(String) }]);
    // Same shortfall, well outside the window: no page yet.
    expect(evaluateAlerts({ ...HEALTHY, jackpotAmount: 0n }, THRESHOLDS)).toEqual([]);
    // Inside the window but funded: no page.
    expect(
      evaluateAlerts({ ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS }, THRESHOLDS),
    ).toEqual([]);
    // A failed jackpot read is not evidence it is low.
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, jackpotAmount: null },
        THRESHOLDS,
      ),
    ).toEqual([]);
  });

  // Yield-claimer ticket 14: the live-yield conditions.
  it("SOLVENCY_NEGATIVE fires on a negative margin past rounding dust, not on an unknown one", () => {
    expect(evaluateAlerts({ ...HEALTHY, solvencyMargin: -SOLVENCY_DUST - 1n }, THRESHOLDS)).toEqual([
      { code: "SOLVENCY_NEGATIVE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, solvencyMargin: -SOLVENCY_DUST }, THRESHOLDS)).toEqual([]);
    expect(evaluateAlerts({ ...HEALTHY, solvencyMargin: 5n }, THRESHOLDS)).toEqual([]);
    // A failed vault read is not evidence of insolvency.
    expect(evaluateAlerts({ ...HEALTHY, solvencyMargin: null }, THRESHOLDS)).toEqual([]);
  });

  it("FREE_IDLE_LOW fires only once free idle has been under the floor longer than the window", () => {
    expect(evaluateAlerts({ ...HEALTHY, freeIdleLowSeconds: 3601 }, THRESHOLDS)).toEqual([
      { code: "FREE_IDLE_LOW", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, freeIdleLowSeconds: 3600 }, THRESHOLDS)).toEqual([]);
    expect(evaluateAlerts({ ...HEALTHY, freeIdleLowSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("RESERVE_LIQUIDITY_LOW fires under the set amount, not on an unreadable reserve", () => {
    expect(evaluateAlerts({ ...HEALTHY, reserveFreeLiquidity: 999_999n }, THRESHOLDS)).toEqual([
      { code: "RESERVE_LIQUIDITY_LOW", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, reserveFreeLiquidity: 1_000_000n }, THRESHOLDS)).toEqual([]);
    expect(evaluateAlerts({ ...HEALTHY, reserveFreeLiquidity: null }, THRESHOLDS)).toEqual([]);
  });

  it("POOL_IMPAIRED and DEPLOY_PAUSED fire while their switch is set", () => {
    expect(evaluateAlerts({ ...HEALTHY, impaired: true }, THRESHOLDS)).toEqual([
      { code: "POOL_IMPAIRED", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, deployPaused: true }, THRESHOLDS)).toEqual([
      { code: "DEPLOY_PAUSED", message: expect.any(String) },
    ]);
  });

  it("WEIGHT_TREE_NEARLY_FULL fires over 80% of capacity", () => {
    expect(evaluateAlerts({ ...HEALTHY, treeUsedBps: TREE_NEARLY_FULL_BPS + 1 }, THRESHOLDS)).toEqual([
      { code: "WEIGHT_TREE_NEARLY_FULL", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, treeUsedBps: TREE_NEARLY_FULL_BPS }, THRESHOLDS)).toEqual([]);
  });

  it("WITHDRAW_FORECAST_SHORT fires when the total owed outruns vault liquidity", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 2n, vaultLiquidity: 1n },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "WITHDRAW_FORECAST_SHORT", message: expect.any(String) }]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 1n, vaultLiquidity: 1n },
        THRESHOLDS,
      ),
    ).toEqual([]);
    // A failed vault read is not evidence of a shortfall.
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 2n, vaultLiquidity: null },
        THRESHOLDS,
      ),
    ).toEqual([]);
  });

  it("VENUE_PROPOSED names the proposed accounts and the unlock time", () => {
    const [alert] = evaluateAlerts({ ...HEALTHY, venueProposal: PROPOSAL }, THRESHOLDS);
    expect(alert?.code).toBe("VENUE_PROPOSED");
    expect(alert?.message).toContain("KLendProgram111");
    expect(alert?.message).toContain("Reserve111");
    expect(alert?.message).toContain("1800172800");
  });

  it("PARAMS_CHANGED carries the new values and leaves the pool address out", () => {
    const [alert] = evaluateAlerts(
      { ...HEALTHY, paramsChanged: { pool: "PoolAddr", epochSeconds: "604800", houseCutBps: 600 } },
      THRESHOLDS,
    );
    expect(alert?.code).toBe("PARAMS_CHANGED");
    expect(alert?.message).toContain("epochSeconds=604800");
    expect(alert?.message).toContain("houseCutBps=600");
    expect(alert?.message).not.toContain("PoolAddr");
  });

  it("stacks every active condition at once", () => {
    const codes = evaluateAlerts(
      {
        operatorSolLow: true,
        tickAgeSeconds: 301,
        shutdown: false,
        rpcOk: false,
        rpcFallbackAgeMs: 0,
        indexerAgeSeconds: 601,
        withdrawShortfall: 1n,
        roundVoidedRecently: true,
        epochRolledOverRecently: true,
        withdrawSkippedCount: 1,
        operatorFailingSeconds: null,
        epochNoProgress: true,
        drawnUnpaid: true,
        sparringSolLow: true,
        secondsToEpochClose: NEAR_CLOSE_SECONDS,
        jackpotAmount: 0n,
        minJackpot: 1_000_000n,
        pendingWithdrawals: 2n,
        vaultLiquidity: 1n,
        solvencyMargin: -100n,
        freeIdleLowSeconds: 7_200,
        reserveFreeLiquidity: 0n,
        impaired: true,
        deployPaused: true,
        treeUsedBps: 9_500,
        venueProposal: PROPOSAL,
        paramsChanged: { pool: "P", epochSeconds: "86400" },
      },
      THRESHOLDS,
    ).map((alert) => alert.code);
    expect(codes).toEqual([
      "OPERATOR_SOL_LOW",
      "OPERATOR_STALE",
      "RPC_DOWN",
      "RPC_FALLBACK_ACTIVE",
      "INDEXER_STALE",
      "WITHDRAW_SHORTFALL",
      "ROUND_VOIDED_RECENTLY",
      "EPOCH_ROLLED_OVER_RECENTLY",
      "WITHDRAW_OWNERS_SKIPPED",
      "EPOCH_NO_PROGRESS",
      "DRAWN_UNPAID",
      "SPARRING_SOL_LOW",
      "JACKPOT_LOW_NEAR_CLOSE",
      "WITHDRAW_FORECAST_SHORT",
      "SOLVENCY_NEGATIVE",
      "FREE_IDLE_LOW",
      "RESERVE_LIQUIDITY_LOW",
      "POOL_IMPAIRED",
      "DEPLOY_PAUSED",
      "WEIGHT_TREE_NEARLY_FULL",
      "VENUE_PROPOSED",
      "PARAMS_CHANGED",
    ]);
  });
});
