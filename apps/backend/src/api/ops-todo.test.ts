import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { VENUE_KIND, VENUE_LOCK_SECONDS } from "../chain/venue-kind";
import { EPOCH_STATUS, ROUND_STATUS, type EpochState, type PoolState } from "../operator/chain-state";
import { OPERATOR_FAILING_SECONDS, isOperatorFailing, isOperatorStale, operatorAges } from "./alerts.controller";
import { TodoClock, todoDrafts, type TodoCode, type TodoInput } from "./ops-todo";

const NOW = 1_800_000_000n;
const USDC = 1_000_000n;
const key = () => Keypair.generate().publicKey;

/** A pool pinned to a venue (so the cranks can fire) with a 5% floor and a 10% target. */
const pool = (over: Partial<PoolState> = {}): PoolState => ({
  address: key(),
  admin: key(),
  operator: key(),
  acceptedMint: key(),
  treasury: key(),
  buybackReserve: key(),
  house: key(),
  vrfNetworkState: key(),
  epochSeconds: 86_400n,
  roundSeconds: 60n,
  closeBuffer: 0n,
  vrfTimeout: 120n,
  payoutTimeout: 86_400n,
  paused: false,
  currentEpochId: 2n,
  nextRoundId: 1n,
  openRoundId: 0n,
  totalPrincipal: 1_000n * USDC,
  shutdown: false,
  gamePaused: false,
  jackpotPaused: false,
  weightTree: key(),
  klendProgram: key(),
  klendMarket: key(),
  klendReserve: key(),
  klendCtoken: key(),
  venueKind: VENUE_KIND.klend,
  pendingWithdrawals: 0n,
  venueValue: 0n,
  feeOwed: 0n,
  prizeOwed: 0n,
  idleFloorBps: 500,
  idleTargetBps: 1_000,
  minVenueMove: USDC,
  deployPaused: false,
  impaired: false,
  ...over,
});

const epoch = (over: Partial<EpochState> = {}): EpochState => ({
  epochId: 2n,
  startsAt: NOW - 100n,
  endsAt: NOW + 86_300n,
  status: EPOCH_STATUS.OPEN,
  jackpotAmount: 0n,
  vrfSeed: new Uint8Array(32),
  requestedAt: 0n,
  target: 0n,
  drawnAt: 0n,
  endedAt: 0n,
  ...over,
});

/** Nothing due: the vault sits on the 10% target, the epoch has a day left. */
const quiet: TodoInput = {
  chain: { pool: pool({ venueValue: 900n * USDC }), currentEpoch: epoch(), now: NOW },
  vaultBalance: 100n * USDC,
  proposal: null,
  harvestedThisWindow: false,
  stuck: { round: null, epoch: null },
  deficit: 0n,
  dueWithdrawals: [],
};
const codes = (input: TodoInput): TodoCode[] => todoDrafts(input).map((item) => item.code);
const withChain = (poolOver: Partial<PoolState>, epochOver: Partial<EpochState> = {}) => ({
  pool: pool(poolOver),
  currentEpoch: epoch(epochOver),
  now: NOW,
});

describe("todoDrafts", () => {
  it("is empty when nothing is due, and for a pool that is not indexed", () => {
    expect(todoDrafts(quiet)).toEqual([]);
    expect(
      todoDrafts({
        chain: null,
        vaultBalance: null,
        proposal: null,
        harvestedThisWindow: false,
        stuck: { round: null, epoch: null },
        deficit: 0n,
        dueWithdrawals: [],
      }),
    ).toEqual([]);
  });

  it("DEPLOY_DUE fires on idle above the band and clears once it is deployed", () => {
    const over = { ...quiet, vaultBalance: 500n * USDC };
    expect(todoDrafts(over)).toEqual([
      expect.objectContaining({ code: "DEPLOY_DUE", amount: 360n * USDC - 90_000n }),
    ]);
    expect(codes({ ...over, vaultBalance: 100n * USDC })).toEqual([]);
  });

  it("DEPLOY_DUE waits for a proposal to close and for a deploy pause", () => {
    const over = { ...quiet, vaultBalance: 500n * USDC };
    expect(codes({ ...over, chain: withChain({ venueValue: 900n * USDC, deployPaused: true }) })).toEqual([]);
    expect(codes({ ...over, proposal: { proposedAt: NOW } })).toEqual([]);
  });

  it("RECALL_DUE fires under the floor and clears once free idle is back", () => {
    const low = { ...quiet, vaultBalance: 10n * USDC };
    expect(todoDrafts(low)).toEqual([expect.objectContaining({ code: "RECALL_DUE", amount: 81n * USDC })]);
    expect(codes({ ...low, vaultBalance: 100n * USDC })).toEqual([]);
  });

  it("HARVEST_DUE fires in the last window of the epoch and clears once harvested", () => {
    const closing = { ...quiet, chain: withChain({ venueValue: 900n * USDC }, { endsAt: NOW + 300n }) };
    expect(todoDrafts(closing)).toEqual([expect.objectContaining({ code: "HARVEST_DUE", id: 2n })]);
    expect(codes({ ...closing, harvestedThisWindow: true })).toEqual([]);
    expect(codes({ ...closing, chain: withChain({ venueValue: 900n * USDC }, { endsAt: NOW + 3_000n }) })).toEqual([]);
  });

  it("lists harvest, recall and deploy together when more than one is due", () => {
    const closing = withChain({ venueValue: 900n * USDC }, { endsAt: NOW + 300n });
    expect(codes({ ...quiet, chain: closing, vaultBalance: 10n * USDC })).toEqual(["HARVEST_DUE", "RECALL_DUE"]);
    const idle = withChain({ venueValue: 100n * USDC }, { endsAt: NOW + 300n });
    expect(codes({ ...quiet, chain: idle, vaultBalance: 900n * USDC })).toEqual(["HARVEST_DUE", "DEPLOY_DUE"]);
  });

  it("WITHDRAWS_DUE carries the count, the total and the first owner, and clears when none are due", () => {
    const due = [
      { owner: "alice", amount: 3n },
      { owner: "bob", amount: 4n },
    ];
    expect(todoDrafts({ ...quiet, dueWithdrawals: due })).toEqual([
      expect.objectContaining({ code: "WITHDRAWS_DUE", amount: 7n, owner: "alice", message: expect.stringContaining("2 withdrawal") }),
    ]);
    expect(codes({ ...quiet, dueWithdrawals: [] })).toEqual([]);
  });

  it("STUCK_ROUND and STUCK_EPOCH follow findStuck's answer", () => {
    const stuck = {
      round: { id: 5n, status: ROUND_STATUS.OPEN },
      epoch: { id: 6n, status: EPOCH_STATUS.DRAWN },
    };
    expect(todoDrafts({ ...quiet, stuck })).toEqual([
      expect.objectContaining({ code: "STUCK_ROUND", id: 5n }),
      expect.objectContaining({ code: "STUCK_EPOCH", id: 6n }),
    ]);
    expect(codes({ ...quiet, stuck: { round: null, epoch: null } })).toEqual([]);
    // An unknown stuck check (the chain read failed) lists nothing it cannot name.
    expect(codes({ ...quiet, stuck: null })).toEqual([]);
  });

  it("DEFICIT_OPEN fires above zero and clears at zero", () => {
    expect(todoDrafts({ ...quiet, deficit: 8n })).toEqual([expect.objectContaining({ code: "DEFICIT_OPEN", amount: 8n })]);
    expect(codes({ ...quiet, deficit: 0n })).toEqual([]);
  });

  it("VENUE_LOCK_ELAPSED fires once the lock has passed and names Drain, then Migrate", () => {
    const proposal = { proposedAt: NOW - VENUE_LOCK_SECONDS - 1n };
    const draining = { ...quiet, proposal, chain: withChain({ venueValue: 500n * USDC }) };
    expect(todoDrafts(draining)).toEqual([
      expect.objectContaining({ code: "VENUE_LOCK_ELAPSED", amount: 500n * USDC, message: expect.stringContaining("Drain") }),
    ]);
    const dust = { ...draining, chain: withChain({ venueValue: USDC }) };
    expect(todoDrafts(dust)).toEqual([
      expect.objectContaining({ code: "VENUE_LOCK_ELAPSED", message: expect.stringContaining("Migrate") }),
    ]);
    expect(codes({ ...draining, proposal: { proposedAt: NOW } })).toEqual([]);
    expect(codes({ ...draining, proposal: null, vaultBalance: 56n * USDC })).toEqual([]);
  });

  it("lists no venue crank when the vault balance is unknown", () => {
    expect(codes({ ...quiet, vaultBalance: null, chain: withChain({ venueValue: 100n * USDC }, { endsAt: NOW + 300n }) })).toEqual([]);
  });
});

describe("TodoClock", () => {
  const drafts = todoDrafts({ ...quiet, vaultBalance: 500n * USDC, deficit: 8n });
  const opts = { operatorDown: false, nowSeconds: 1_000, tickStaleSeconds: 300 };

  it("marks a routine item bot and a recovery item now", () => {
    expect(new TodoClock().mark(drafts, opts).map((item) => [item.code, item.due])).toEqual([
      ["DEFICIT_OPEN", "now"],
      ["DEPLOY_DUE", "bot"],
    ]);
  });

  it("flips a routine item to now when the Operator is down", () => {
    const due = new TodoClock().mark(drafts, { ...opts, operatorDown: true }).map((item) => item.due);
    expect(due).toEqual(["now", "now"]);
  });

  it("flips a routine item to now once the condition has held past ALERT_TICK_STALE_S, and resets when it clears", () => {
    const clock = new TodoClock();
    clock.mark(drafts, opts);
    const dueAt = (nowSeconds: number) => clock.mark(drafts, { ...opts, nowSeconds }).map((item) => item.due);
    expect(dueAt(1_300)).toEqual(["now", "bot"]);
    expect(dueAt(1_301)).toEqual(["now", "now"]);
    clock.mark([], { ...opts, nowSeconds: 1_400 });
    expect(dueAt(1_500)).toEqual(["now", "bot"]);
  });

  it("holds each code on its own clock", () => {
    const clock = new TodoClock();
    clock.mark(todoDrafts({ ...quiet, vaultBalance: 500n * USDC }), opts);
    const both = todoDrafts({ ...quiet, vaultBalance: 500n * USDC, dueWithdrawals: [{ owner: "a", amount: 1n }] });
    const items = clock.mark(both, { ...opts, nowSeconds: 1_400 });
    expect(items.map((item) => [item.code, item.due])).toEqual([
      ["DEPLOY_DUE", "now"],
      ["WITHDRAWS_DUE", "bot"],
    ]);
  });
});

describe("the Operator-down rules shared with /alerts", () => {
  const operator = (over: { lastTickAt?: Date | null; lastError?: string | null; lastSuccessAt?: Date | null }) =>
    ({ lastTickAt: null, lastError: null, lastSuccessAt: null, ...over }) as Parameters<typeof operatorAges>[0];
  const at = (seconds: number) => new Date(seconds * 1000);

  it("is stale past the threshold, never when shut down or never ticked", () => {
    const ages = operatorAges(operator({ lastTickAt: at(1_000) }), 1_301);
    expect(ages.tickAgeSeconds).toBe(301);
    expect(isOperatorStale({ ...ages, shutdown: false }, 300)).toBe(true);
    expect(isOperatorStale({ ...ages, shutdown: true }, 300)).toBe(false);
    expect(isOperatorStale({ ...ages, shutdown: false }, 301)).toBe(false);
    expect(isOperatorStale({ ...operatorAges(null, 1_301), shutdown: false }, 300)).toBe(false);
  });

  it("is failing once the last error has outlasted the last success, or no success exists", () => {
    const failing = (lastSuccessAt: Date | null, now: number) =>
      isOperatorFailing(operatorAges(operator({ lastError: "boom", lastSuccessAt }), now));
    expect(failing(at(1_000), 1_000 + OPERATOR_FAILING_SECONDS + 1)).toBe(true);
    expect(failing(at(1_000), 1_000 + OPERATOR_FAILING_SECONDS)).toBe(false);
    expect(failing(null, 1_000)).toBe(true);
    expect(isOperatorFailing(operatorAges(operator({ lastError: null }), 9_999))).toBe(false);
  });
});
