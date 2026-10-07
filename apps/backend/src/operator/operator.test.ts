// Step selection is the whole operator: given a state, exactly one thing
// should happen. The instructions built here are the real ones, decoded back
// out of the recorded transaction, so a wrong account list still shows up.
import { VENUE_KIND } from "../chain/venue-kind";
import {
  AnchorProvider,
  BorshInstructionCoder,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import { poolAddress, venueProposalAddress } from "../chain/pda";
import {
  EPOCH_STATUS,
  ROUND_STATUS,
  clockUnixTimestamp,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";
import {
  DRAWN_UNPAID_ALERT_SECONDS,
  EXPECTED_ERROR_REPEAT_LIMIT,
  EXPECTED_ERRORS,
  msUntilWake,
  runTick,
  SAFETY_INTERVAL_SECONDS,
  WITHDRAW_BATCH_SIZE,
  WITHDRAW_FAILURE_LIMIT,
  type TickContext,
  type WithdrawState,
} from "./tick";
import { HARVEST_LEAD_SECONDS, VENUE_RETRY_SECONDS } from "./venue";
import { isFulfilled, keccak256, randomnessAddress, vrfSeed } from "./vrf";

const AUTHORITY = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const WEIGHT_TREE = Keypair.generate().publicKey;

// No RPC is reached: every account is passed explicitly, so Anchor never has
// to resolve one.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);
const coder = new BorshInstructionCoder(idl);
const instructions = new OperatorInstructions(
  program,
  PROGRAM_ID,
  AUTHORITY,
  true,
);

/** Readable name for one recorded instruction, whoever owns it. */
function label(ix: TransactionInstruction): string {
  if (ix.programId.equals(PROGRAM_ID)) {
    return coder.decode(ix.data)?.name ?? "unknown";
  }
  if (ix.programId.equals(TOKEN_PROGRAM_ID)) return `token:${ix.data[0]}`;
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    return `ata:${ix.data[0]}`;
  return ix.programId.toBase58();
}

const CREATE_ATA_IDEMPOTENT = "ata:1";

const NOW = 1_800_000_000n;

const pool = (over: Partial<PoolState> = {}): PoolState => ({
  address: POOL,
  admin: AUTHORITY,
  operator: AUTHORITY,
  acceptedMint: MINT,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: 86_400n,
  roundSeconds: 60n,
  closeBuffer: 0n,
  vrfTimeout: 120n,
  payoutTimeout: 86_400n,
  paused: false,
  currentEpochId: 2n,
  nextRoundId: 4n,
  openRoundId: 3n,
  totalPrincipal: 1_000_000_000n,
  shutdown: false,
  gamePaused: false,
  jackpotPaused: false,
  weightTree: WEIGHT_TREE,
  // Unpinned by default (`Pubkey::default()`), so the venue cranks stay quiet
  // in every test that is not about them; `venuePool` below pins klend.
  klendProgram: PublicKey.default,
  klendMarket: PublicKey.default,
  klendReserve: PublicKey.default,
  klendCtoken: PublicKey.default,
  venueKind: VENUE_KIND.klend,
  pendingWithdrawals: 0n,
  venueValue: 0n,
  feeOwed: 0n,
  prizeOwed: 0n,
  idleFloorBps: 500,
  idleTargetBps: 1_000,
  minVenueMove: 100_000_000n,
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
  vrfSeed: new Uint8Array(32).fill(3),
  requestedAt: 0n,
  target: 0n,
  drawnAt: 0n,
  endedAt: 0n,
  ...over,
});

/** The epoch that has ended and waits for `request_draw`, which is what
 *  `previousEpoch` holds for step 4. Its `endsAt` is behind `now`:
 *  `begin_epoch` is what moves an epoch into this status, and it will not
 *  run before the epoch has ended. */
const ended = (over: Partial<EpochState> = {}): EpochState =>
  epoch({
    epochId: 1n,
    status: EPOCH_STATUS.ENDED,
    endsAt: NOW - 100n,
    ...over,
  });

const round = (over: Partial<RoundState> = {}): RoundState => ({
  roundId: 3n,
  endsAt: NOW + 30n,
  status: ROUND_STATUS.OPEN,
  vrfSeed: new Uint8Array(32).fill(5),
  requestedAt: 0n,
  ...over,
});

interface Recorder {
  ctx: TickContext;
  sent: TransactionInstruction[][];
  warned: string[];
  markedSent: { epochId: bigint; referrers: string[]; txSig: string }[];
}

function context(over: Partial<TickContext> = {}): Recorder {
  const sent: TransactionInstruction[][] = [];
  const warned: string[] = [];
  const markedSent: { epochId: bigint; referrers: string[]; txSig: string }[] = [];
  const ctx: TickContext = {
    now: NOW,
    pool: pool(),
    // A healthy mid-round state: epoch running, previous one already paid,
    // round open and not yet over.
    currentEpoch: epoch(),
    previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
    openRound: round(),
    // Null by default: only the step 7 tests below care, and null means "no
    // previous round", which never delays opening the next one.
    lastRound: null,
    ix: instructions,
    lastWithdrawState: null,
    lastVenueState: null,
    // No venue change open by default (venue-switch ticket 04).
    venueProposal: null,
    venueAvailable: async () => null,
    lastExpectedErrors: new Map(),
    lastRoundSkipEpochId: null,
    // Unconfigured by default (ticket 05): begin_epoch is never withheld in
    // any test that is not about the launch window.
    launchAt: null,
    fulfilled: async () => false,
    principalVaultBalance: async () => 0n,
    // Empty by default so step 6b stays quiet in every test that is not about it.
    duePendingWithdrawals: async () => [],
    unsettledPositions: async () => [],
    forgetPositions: async () => {},
    // Empty by default so step 2c stays quiet in every test that is not about it.
    roundsToClose: async () => [],
    forgetRound: () => {},
    winner: async () => null,
    // Empty by default so step 3b stays quiet in every test that is not about it.
    referralGrantsDue: async () => [],
    markReferralGrantsSent: async (epochId, referrers, txSig) => {
      markedSent.push({ epochId, referrers: [...referrers], txSig });
    },
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    warn: (message) => warned.push(message),
    ...over,
  };
  return { ctx, sent, warned, markedSent };
}

const keysOfIx = (ixs: readonly TransactionInstruction[]): string[] =>
  (ixs[0]?.keys ?? []).map((key) => key.pubkey.toBase58());

/** Runs one tick and returns the labels of the single transaction it sent. */
async function tickLabels(over: Partial<TickContext> = {}): Promise<{
  action: string | null;
  labels: string[];
  transactions: number;
  nextWakeAt: bigint;
  withdrawShortfall: bigint | undefined;
}> {
  const { ctx, sent } = context(over);
  const outcome = await runTick(ctx);
  return {
    action: outcome.action,
    labels: (sent[0] ?? []).map(label),
    transactions: sent.length,
    nextWakeAt: outcome.nextWakeAt,
    withdrawShortfall: outcome.withdrawShortfall,
  };
}

describe("runTick", () => {
  it("sends nothing on a healthy mid-round state", async () => {
    const result = await tickLabels();
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
    // Round end minus the close buffer is the closest of the round end,
    // epoch end and safety-interval candidates.
    expect(result.nextWakeAt).toBe(NOW + 30n);
  });

  // --- 1. Round: open-and-ended, requested, or voided. Runs before any Epoch
  // step, so a Round can never straddle the boundary step 3 might open.

  it("1. requests randomness for a round that has ended", async () => {
    const result = await tickLabels({ openRound: round({ endsAt: NOW }) });
    expect(result.labels).toEqual(["request_round_randomness"]);
    // Acted this tick: look again immediately rather than waiting on a
    // boundary that already fired.
    expect(result.nextWakeAt).toBe(NOW);
  });

  it("1. does not request randomness one second before the close", async () => {
    const result = await tickLabels({
      pool: pool({ closeBuffer: 5n }),
      openRound: round({ endsAt: NOW + 6n }),
    });
    expect(result.transactions).toBe(0);
    // The close buffer is part of the deadline: endsAt minus closeBuffer.
    expect(result.nextWakeAt).toBe(NOW + 1n);
  });

  it("1. requests randomness at the close, `closeBuffer` seconds before `endsAt`", async () => {
    const result = await tickLabels({
      pool: pool({ closeBuffer: 5n }),
      openRound: round({ endsAt: NOW + 5n }),
    });
    expect(result.labels).toEqual(["request_round_randomness"]);
  });

  it("1. settles a requested round once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 5n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["settle_round"]);
  });

  it("1. voids a requested round after the timeout", async () => {
    const result = await tickLabels({
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["void_round"]);
  });

  it("1. voids an Open round still unrequested `vrfTimeout` past its end, instead of requesting again", async () => {
    const result = await tickLabels({
      openRound: round({ status: ROUND_STATUS.OPEN, endsAt: NOW - 121n }),
    });
    expect(result.labels).toEqual(["void_round"]);
    // One second earlier the request path still wins; the program would
    // refuse the void anyway.
    const early = await tickLabels({
      openRound: round({ status: ROUND_STATUS.OPEN, endsAt: NOW - 120n }),
    });
    expect(early.labels).toEqual(["request_round_randomness"]);
  });

  it("1. requests round randomness before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: round({ endsAt: NOW }),
    });
    expect(result.labels).toEqual(["request_round_randomness"]);
    expect(result.action).toBe("request_round_randomness");
  });

  it("1. settles a requested round before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 5n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["settle_round"]);
  });

  // --- 2. Sweep: unsettled Positions on any terminal Round, not just the
  // newest.

  it("2. settles up to eight leftover positions per transaction", async () => {
    const positions = Array.from({ length: 9 }, () => ({
      address: Keypair.generate().publicKey.toBase58(),
      owner: Keypair.generate().publicKey.toBase58(),
      roundId: 3n,
    }));
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => positions,
    });
    expect(result.labels).toEqual(Array(8).fill("settle_position"));
    expect(result.action).toBe("settle_position");
  });

  it("2. forgets the positions it settled, and only those, once the send confirms", async () => {
    const positions = Array.from({ length: 9 }, () => ({
      address: Keypair.generate().publicKey.toBase58(),
      owner: Keypair.generate().publicKey.toBase58(),
      roundId: 3n,
    }));
    const forgotten: string[][] = [];
    await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => positions,
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
    });
    expect(forgotten).toEqual([positions.slice(0, 8).map((position) => position.address)]);
  });

  it("2. (ticket 06) keeps the rows when the send fails, records the error, and lets the tick continue", async () => {
    const forgotten: string[][] = [];
    const { ctx } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "settle_position")) {
          throw new Error("blockhash expired");
        }
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(forgotten).toEqual([]);
    expect(outcome.stepError).toMatch(/blockhash expired/);
    // Falls through to open the next round instead of aborting the tick.
    expect(outcome.action).toBe("create_round");
  });

  it("2. (ticket 12) an AccountNotInitialized race is treated as already settled", async () => {
    const address = Keypair.generate().publicKey.toBase58();
    const forgotten: string[][] = [];
    const { ctx } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        { address, owner: Keypair.generate().publicKey.toBase58(), roundId: 3n },
      ],
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
      send: async () => {
        throw new Error("AccountNotInitialized");
      },
    });
    const outcome = await runTick(ctx);
    expect(forgotten).toEqual([[address]]);
    expect(outcome.stepError).toBeUndefined();
  });

  it("2. (ticket 12) an expected race is swallowed twice, then escalates to a recorded error", async () => {
    const positions = () => [
      {
        address: Keypair.generate().publicKey.toBase58(),
        owner: Keypair.generate().publicKey.toBase58(),
        roundId: 3n,
      },
    ];
    let expectedErrors: ReadonlyMap<string, number> = new Map();
    let outcome;
    for (let i = 0; i < EXPECTED_ERROR_REPEAT_LIMIT; i += 1) {
      const { ctx } = context({
        pool: pool({ openRoundId: 0n }),
        openRound: null,
        lastExpectedErrors: expectedErrors,
        unsettledPositions: async () => positions(),
        send: async (ixs) => {
          if (ixs.some((ix) => label(ix) === "settle_position")) {
            throw new Error("RoundNotSettled");
          }
          return "signature";
        },
      });
      outcome = await runTick(ctx);
      expectedErrors = outcome.expectedErrors ?? expectedErrors;
    }
    expect(outcome?.stepError).toMatch(/RoundNotSettled/);
  });

  it("2. sweeps a leftover position before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
    });
    expect(result.labels).toEqual(["settle_position"]);
    expect(result.action).toBe("settle_position");
  });

  it("2. sweeps an older round's position while a newer round is open", async () => {
    // Default openRound is round 3, open; the leftover position sits on
    // round 1, two ids behind, and gets swept anyway.
    const result = await tickLabels({
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 1n,
        },
      ],
    });
    expect(result.labels).toEqual(["settle_position"]);
  });

  // --- 2c. Close a terminal Round once nothing settled on it is still owed
  // (ops-and-envs ticket 08): reclaims its rent for the operator.

  it("2c. closes a round once roundsToClose names one", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      roundsToClose: async () => [7n],
    });
    expect(result.labels).toEqual(["close_round"]);
    expect(result.action).toBe("close_round");
  });

  it("2c. forgets the round it closed once the send confirms", async () => {
    const forgotten: bigint[] = [];
    await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      roundsToClose: async () => [7n],
      forgetRound: (id) => forgotten.push(id),
    });
    expect(forgotten).toEqual([7n]);
  });

  it("2c. sweeps leftover positions before closing any round", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
      roundsToClose: async () => [7n],
    });
    expect(result.action).toBe("settle_position");
  });

  it("2c. closes a round even while the pool is shut down: close_round is permissionless throughout", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, shutdown: true }),
      openRound: null,
      currentEpoch: null,
      previousEpoch: null,
      roundsToClose: async () => [7n],
    });
    expect(result.action).toBe("close_round");
  });

  // --- 3. Begin Epoch: only once the Round and sweep above are clear, and
  // the previous Epoch (if any) is Paid or Rolled over.

  it("3. begins the first epoch when the pool has none", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  it("3. begins the next epoch once it has ended, the round is clear, and the previous epoch is paid", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("3. does not begin the epoch while the previous epoch has not been sent to the draw", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      previousEpoch: ended(),
    });
    expect(result.action).not.toBe("begin_epoch");
    expect(result.labels).toEqual(["request_draw"]);
  });

  // --- 3 (ticket 05): LAUNCH_AT holds back only the Pool's very first
  // begin_epoch (no Epoch yet), so deposits can open before the launch time
  // with nothing else in the tick changing.

  it("3. a future launch time withholds the first begin_epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW + 3_600n,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
    // Further off than the safety interval, so the safety tick is still the
    // soonest thing that could re-check, same as any other far-off deadline.
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  it("3. sleeps straight to the launch time once it is closer than the safety interval", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW + 10n,
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 10n);
  });

  it("3. a past launch time begins the first epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW - 1n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  // game-jackpot-pause ticket 02: begin_epoch is refused under jackpot
  // pause, and a new pool starts that way.
  it("3. does not begin the first epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n, jackpotPaused: true }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. does not begin the next epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, jackpotPaused: true }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. LAUNCH_AT does not hold back a later epoch once one already exists", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      launchAt: NOW + 3_600n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  // --- 3b. Referral bonuses (docs/plan/hexo-referrals ticket 08): grants
  // due for the epoch that just began, batched like withdrawals.

  it("3b. grants up to eight referral bonuses per transaction and records the signature", async () => {
    const referrers = Array.from({ length: 10 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    const { ctx, sent, markedSent } = context({
      referralGrantsDue: async (epochId) => {
        expect(epochId).toBe(2n); // currentEpoch's id, not previousEpoch's
        return referrers.map((referrer) => ({ referrer, amount: 1_000_000n }));
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("grant_tickets");
    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(Array(8).fill("grant_tickets"));
    expect(markedSent).toEqual([
      { epochId: 2n, referrers: referrers.slice(0, 8), txSig: "signature" },
    ]);
  });

  it("3b. does nothing once every referral bonus for the epoch is granted", async () => {
    const result = await tickLabels({ referralGrantsDue: async () => [] });
    expect(result.action).toBeNull();
  });

  it("3b. does nothing before the first epoch has begun", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      referralGrantsDue: () => {
        throw new Error("must not be asked before an epoch exists");
      },
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("3b. logs a warning and falls through instead of throwing when the on-chain cap is exceeded", async () => {
    const referrer = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      referralGrantsDue: async () => [{ referrer, amount: 1_000_000n }],
      send: async () => {
        throw new Error("custom program error: DailyPoolGrantCapExceeded");
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/DailyPoolGrantCapExceeded/);
    // The error itself does not say which referrer in the batch tripped it,
    // so every one of them (and the amount tried) is named in the log.
    expect(warned[0]).toContain(`${referrer}:1000000`);
  });

  it("3b. does not grant tickets once the pool is shut down: grant_tickets is refused", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      referralGrantsDue: () => {
        throw new Error("must not be asked while shut down");
      },
    });
    expect(result.action).toBeNull();
  });

  // game-jackpot-pause ticket 02: grant_tickets is refused under jackpot pause.
  it("3b. does not grant tickets while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ jackpotPaused: true }),
      referralGrantsDue: () => {
        throw new Error("must not be asked while the jackpot is paused");
      },
    });
    expect(result.action).toBeNull();
  });

  // --- 4. request_draw: the ended epoch goes to the draw straight away. There
  // is no registration, no indexer wait and no window (ticket 13).

  it("4. sends an ended epoch to the draw, with the Weight tree", async () => {
    const { ctx, sent } = context({ previousEpoch: ended() });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(["request_draw"]);
    expect(outcome.action).toBe("request_draw");
    expect(keysOfIx(sent[0] ?? [])).toContain(WEIGHT_TREE.toBase58());
    // Acted this tick, so look again straight away.
    expect(outcome.nextWakeAt).toBe(NOW);
  });

  it("4. waits while the pool is shut down: request_draw is refused", async () => {
    const result = await tickLabels({ pool: pool({ shutdown: true }), previousEpoch: ended() });
    expect(result.action).toBeNull();
  });

  it("4. waits while the jackpot is paused", async () => {
    const result = await tickLabels({ pool: pool({ jackpotPaused: true }), previousEpoch: ended() });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("4. a request_draw that lost a race is an expected error, not a failure", () => {
    expect(EXPECTED_ERRORS.has("EpochNotAwaitingDraw")).toBe(true);
  });

  // --- 5. Draw or rollover.

  it("5. draws once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["draw"]);
  });

  it("5. rolls the epoch over when the randomness never arrives", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
    expect(result.action).toBe("rollover_epoch");
  });

  it("5. waits while the request is still inside the timeout", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
  });

  it("5. does not draw once the pool is shut down: draw is refused, even fulfilled", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
      fulfilled: async () => true,
    });
    expect(result.transactions).toBe(0);
  });

  it("5. still rolls a shut-down pool's stuck draw over once the timeout elapses", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
  });

  // --- 6. Payout.

  it("6. pays the winner, compounding the prize into their principal", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      winner: async (drawn) => (drawn.epochId === 1n && drawn.target === 42n ? winner : null),
    });
    // No winner token account any more (ticket 02): the prize goes into
    // principal_vault instead, so payout is the whole transaction.
    expect(result.labels).toEqual(["payout"]);
  });

  it("6. still pays an already-drawn epoch once the pool is shut down: payout is allowed throughout", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      winner: async () => winner,
    });
    expect(result.labels).toEqual(["payout"]);
  });

  it("6. logs the winner and retries when the payout will not land", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 60n,
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) {
          throw new Error("AccountFrozen");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
    expect(warned).toEqual([
      `payout of epoch 1 to ${winner} failed: AccountFrozen`,
    ]);
  });

  it("6. lets any other send failure fail the tick", async () => {
    // An RPC blip is not an unpayable winner: swallowing it would retry
    // quietly until `payout_timeout` rolled a payable epoch over, with
    // /status showing no error the whole time.
    const { ctx, warned } = context({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 60n,
      }),
      winner: async () => Keypair.generate().publicKey.toBase58(),
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    await expect(runTick(ctx)).rejects.toThrow("blockhash expired");
    expect(warned).toEqual([]);
  });

  it("6. wakes at the payout timeout of a drawn epoch", async () => {
    // Paused with no Round, so nothing else contributes a nearer deadline.
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true, payoutTimeout: 30n }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 20n);
  });

  it("6. rolls the drawn epoch over once payout_timeout and the drawn-unpaid alert window have both passed", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n),
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) {
          throw new Error("AccountFrozen");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("rollover_epoch");
    expect((sent[0] ?? []).map(label)).toEqual(["rollover_epoch"]);
    expect(warned).toHaveLength(1);
  });

  it("6. (ticket 12) withholds rolling a human winner over until the drawn-unpaid alert window has passed, even past payout_timeout", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, warned } = context({
      pool: pool({ payoutTimeout: 30n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        // Past payoutTimeout, but well inside DRAWN_UNPAID_ALERT_SECONDS.
        drawnAt: NOW - 31n,
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) throw new Error("AccountFrozen");
        throw new Error("must not roll over yet");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(warned).toHaveLength(1);
  });

  it("6. (ticket 12) still rolls a House win over immediately past payout_timeout: nobody is owed a Prize", async () => {
    const housePool = pool({ payoutTimeout: 30n });
    const { ctx, sent } = context({
      pool: housePool,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 31n,
      }),
      winner: async () => housePool.house.toBase58(),
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) throw new Error("AccountFrozen");
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("rollover_epoch");
  });

  it("6. waits when no leaf holds the target yet", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      openRound: round({ endsAt: NOW + 1n }),
    });
    expect(result.transactions).toBe(0);
  });

  // --- 6b. Pending withdrawals whose epoch has ended.

  const pending = (count: number, amount = 1_000_000n) =>
    Array.from({ length: count }, () => ({
      owner: Keypair.generate().publicKey.toBase58(),
      amount,
    }));

  it("6b. pays a due withdrawal, creating the owner's token account first", async () => {
    const due = pending(1);
    const { ctx, sent } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async (epochId) => (epochId === 2n ? due : []),
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("process_withdraw");
    expect((sent[0] ?? []).map(label)).toEqual([
      CREATE_ATA_IDEMPOTENT,
      "process_withdraw",
    ]);
    expect(outcome.withdrawShortfall).toBe(0n);
  });

  it("6b. pays at most WITHDRAW_BATCH_SIZE of them, in a transaction that fits", async () => {
    const { ctx, sent } = context({
      duePendingWithdrawals: async () => pending(WITHDRAW_BATCH_SIZE + 3),
    });
    await runTick(ctx);

    expect((sent[0] ?? []).map(label)).toEqual(
      Array.from({ length: WITHDRAW_BATCH_SIZE }, () => [
        CREATE_ATA_IDEMPOTENT,
        "process_withdraw",
      ]).flat(),
    );
    // Three accounts per payout plus an ATA creation is what caps the batch
    // below BATCH_SIZE, so the ceiling is asserted rather than trusted.
    const tx = new Transaction({
      feePayer: AUTHORITY,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }).add(...(sent[0] ?? []));
    const size = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
    expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it("6b. reports the gap and opens the round anyway when the vault is short", async () => {
    const { ctx, sent, warned } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      duePendingWithdrawals: async () => pending(3, 4_000_000n),
      principalVaultBalance: async () => 5_000_000n,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "process_withdraw")) {
          throw new Error("InsufficientVaultLiquidity");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    // 12 USDC due against 5 in the vault.
    expect(outcome.withdrawShortfall).toBe(7_000_000n);
    expect(warned).toHaveLength(1);
    // A short vault delays cash, never the game: the round still opens.
    expect(outcome.action).toBe("create_round");
    expect((sent[0] ?? []).map(label)).toEqual(["create_round"]);
  });

  it("6b. sizes the shortfall against the batch it tried, not the whole queue", async () => {
    const { ctx } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () =>
        pending(WITHDRAW_BATCH_SIZE + 3, 4_000_000n),
      principalVaultBalance: async () => 5_000_000n,
      send: async () => {
        throw new Error("InsufficientVaultLiquidity");
      },
    });
    const outcome = await runTick(ctx);

    // Four of the seven were sent: 16 USDC against 5 in the vault. Summing
    // the whole queue would ask the admin for 23 instead of the 11 the next
    // transaction actually needs.
    expect(outcome.withdrawShortfall).toBe(
      BigInt(WITHDRAW_BATCH_SIZE) * 4_000_000n - 5_000_000n,
    );
  });

  it("6b. (ticket 06) any other failure switches to single-send mode and records the error instead of throwing", async () => {
    const { ctx } = context({
      duePendingWithdrawals: async () => pending(1),
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(outcome.stepError).toMatch(/blockhash expired/);
    expect(outcome.withdrawState?.singleMode).toBe(true);
  });

  it("6b. sends no withdrawal while the pool is impaired, and resumes when it clears", async () => {
    const due = pending(2);
    let asked = 0;
    const withdrawals = async () => {
      asked += 1;
      return due;
    };
    const impaired = context({
      pool: pool({ openRoundId: 0n, paused: true, impaired: true }),
      openRound: null,
      duePendingWithdrawals: withdrawals,
    });
    const held = await runTick(impaired.ctx);
    expect(held.action).toBeNull();
    expect(held.stepError).toBeUndefined();
    expect(impaired.sent).toHaveLength(0);
    expect(asked).toBe(0);

    const cleared = context({
      pool: pool({ openRoundId: 0n, paused: true, impaired: false }),
      openRound: null,
      duePendingWithdrawals: withdrawals,
    });
    const resumed = await runTick(cleared.ctx);
    expect(resumed.action).toBe("process_withdraw");
    expect((cleared.sent[0] ?? []).filter((ix) => label(ix) === "process_withdraw")).toHaveLength(2);
  });

  it("6b. retries an owner whose Position is still open on a later tick, with no alert", async () => {
    const owners = pending(3);
    let refuse = true;
    const send = async (ixs: TransactionInstruction[]) => {
      if (refuse && ixs.some((ix) => label(ix) === "process_withdraw")) {
        throw new Error("OpenPositions");
      }
      return "signature";
    };
    const first = await runTick(
      context({
        pool: pool({ openRoundId: 0n, paused: true }),
        openRound: null,
        duePendingWithdrawals: async () => owners,
        send,
      }).ctx,
    );
    expect(first.action).toBeNull();
    expect(first.stepError).toBeUndefined();
    // Single sends from here, and nobody is skipped or counted as failing.
    expect(first.withdrawState?.singleMode).toBe(true);
    expect(first.withdrawState?.skipped.size).toBe(0);

    // Still open on the next tick: the same quiet answer.
    const second = await runTick(
      context({
        pool: pool({ openRoundId: 0n, paused: true }),
        openRound: null,
        duePendingWithdrawals: async () => owners,
        lastWithdrawState: first.withdrawState ?? null,
        send,
      }).ctx,
    );
    expect(second.stepError).toBeUndefined();
    expect(second.withdrawState?.failures.size).toBe(0);
    expect(second.withdrawState?.skipped.size).toBe(0);

    // Settled: the same owner is paid.
    refuse = false;
    const third = await runTick(
      context({
        pool: pool({ openRoundId: 0n, paused: true }),
        openRound: null,
        duePendingWithdrawals: async () => owners,
        lastWithdrawState: second.withdrawState ?? null,
        send,
      }).ctx,
    );
    expect(third.action).toBe("process_withdraw");
  });

  it("6b. (ticket 06) falls back to single sends after a batch failure", async () => {
    const owners = pending(3);
    let attempt = 0;
    const { ctx, sent } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () => owners,
      send: async (ixs) => {
        attempt += 1;
        if (attempt === 1) throw new Error("some transient failure");
        sent.push(ixs);
        return "signature";
      },
    });
    // First tick: the 3-owner batch fails, switches to single-send mode.
    const first = await runTick(ctx);
    expect(first.action).toBeNull();
    expect(first.withdrawState?.singleMode).toBe(true);

    // Second tick: pays exactly one, still in single-send mode (two remain).
    const { ctx: ctx2 } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () => owners,
      lastWithdrawState: first.withdrawState ?? null,
      send: async (ixs) => {
        sent.push(ixs);
        return "signature";
      },
    });
    const second = await runTick(ctx2);
    expect(second.action).toBe("process_withdraw");
    expect((sent.at(-1) ?? []).filter((ix) => label(ix) === "process_withdraw")).toHaveLength(1);
    expect(second.withdrawState?.singleMode).toBe(true);
  });

  it("6b. (ticket 06) skips an owner for the rest of the epoch after WITHDRAW_FAILURE_LIMIT consecutive failures", async () => {
    const [entry] = pending(1);
    if (entry === undefined) throw new Error("test setup");
    let state: WithdrawState | null = null;
    let outcome;
    for (let i = 0; i < WITHDRAW_FAILURE_LIMIT; i += 1) {
      const { ctx, warned: w } = context({
        pool: pool({ openRoundId: 0n, paused: true }),
        openRound: null,
        lastWithdrawState: i === 0 ? { epochId: 2n, singleMode: true, failures: new Map(), skipped: new Set() } : state,
        duePendingWithdrawals: async () => [entry],
        send: async () => {
          throw new Error("frozen destination");
        },
      });
      outcome = await runTick(ctx);
      state = outcome.withdrawState ?? state;
      if (i === WITHDRAW_FAILURE_LIMIT - 1) {
        expect(w).toEqual(
          expect.arrayContaining([expect.stringContaining("skipping for the rest of epoch")]),
        );
      }
    }
    expect(state?.skipped.has(entry.owner)).toBe(true);

    // Once skipped, the owner is filtered out of the queue entirely.
    const { ctx: finalCtx } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      lastWithdrawState: state,
      duePendingWithdrawals: async () => [entry],
      send: () => {
        throw new Error("must not be sent: owner is skipped");
      },
    });
    const finalOutcome = await runTick(finalCtx);
    expect(finalOutcome.action).toBeNull();
  });

  it("6b. reports no shortfall and reads no balance when nothing is due", async () => {
    let reads = 0;
    const result = await tickLabels({
      principalVaultBalance: async () => {
        reads += 1;
        return 0n;
      },
    });
    expect(result.transactions).toBe(0);
    expect(result.withdrawShortfall).toBe(0n);
    expect(reads).toBe(0);
  });

  it("6b. leaves the last reported shortfall alone on a tick that acted earlier", async () => {
    const { ctx } = context({
      openRound: round({ endsAt: NOW }),
      duePendingWithdrawals: async () => pending(1),
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("request_round_randomness");
    expect(outcome.withdrawShortfall).toBeUndefined();
  });

  // --- 7. Create Round.

  it("7. opens the next round when the last one is fully settled", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  it("7. does not open a round that would outlast the epoch", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW + 59n }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    // The epoch end is the closest candidate: sooner than the 60 s safety
    // interval, and there is no open round to bound it further.
    expect(result.nextWakeAt).toBe(NOW + 59n);
  });

  it("7. reports a skipped round once per epoch, not once per tick", async () => {
    const straddling = {
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW + 59n }),
      openRound: null,
    };
    const first = await runTick(context(straddling).ctx);
    expect(first.action).toBeNull();
    expect(first.roundSkip).toEqual({ epochId: 2n, endsAt: NOW + 59n });

    // The service remembers the epoch it logged, so the next tick stays quiet.
    const later = await runTick(
      context({ ...straddling, lastRoundSkipEpochId: 2n }).ctx,
    );
    expect(later.roundSkip).toBeUndefined();

    // A round that fits is no skip at all.
    const fits = await runTick(
      context({ pool: pool({ openRoundId: 0n }), openRound: null }).ctx,
    );
    expect(fits.roundSkip).toBeUndefined();
  });

  it("7. does not open a round while the pool is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    // Nothing closer than the running epoch's own (far-off) end: falls back
    // to the safety interval.
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  // game-jackpot-pause ticket 02: create_round is refused under game pause.
  it("7. does not open a round while the game is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, gamePaused: true }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  // --- 7. The previous Round gets REVEAL_SECONDS (1 s) past its `endsAt`
  // before the next one opens; the reveal itself fires when the draw lands,
  // usually before `endsAt`.

  it("7. holds the next round at a settled lastRound's endsAt", async () => {
    const settledLastRound = round({
      status: ROUND_STATUS.SETTLED,
      endsAt: NOW,
    });
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: settledLastRound,
    });
    expect(result.transactions).toBe(0);
    // The reveal wait (lastRound.endsAt + REVEAL_SECONDS) is the closest
    // candidate.
    expect(result.nextWakeAt).toBe(NOW + 1n);
  });

  it("computes the VRF timeout as the deadline when it is the closest one", async () => {
    // Paused, so no Round opens: acting would make the deadline "now" and
    // hide the candidate this test is about.
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 70n,
      }),
    });
    expect(result.transactions).toBe(0);
    // vrfTimeout (120n) minus the 70 elapsed seconds beats both the epoch
    // end and the 60 s safety interval.
    expect(result.nextWakeAt).toBe(NOW + 50n);
  });

  it("7. opens the next round one second past a settled lastRound's endsAt", async () => {
    const settledLastRound = round({
      status: ROUND_STATUS.SETTLED,
      endsAt: NOW,
    });
    const result = await tickLabels({
      now: NOW + 1n,
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: settledLastRound,
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  it("7. a voided lastRound opens the next round immediately", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: round({ status: ROUND_STATUS.VOIDED, endsAt: NOW }),
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  // --- Ticket 09: epochNoProgress and drawnUnpaid are computed off the
  // previous epoch every tick, regardless of which step (if any) acts.

  it("epochNoProgress and drawnUnpaid read false on a healthy mid-round state", async () => {
    const { ctx } = context();
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
    expect(outcome.drawnUnpaid).toBe(false);
  });

  it("epochNoProgress fires once an ended epoch outlives the VRF timeout plus the slack", async () => {
    const { ctx } = context({
      pool: pool({ vrfTimeout: 120n }),
      previousEpoch: ended({ endsAt: NOW - (120n + 300n + 1n) }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(true);
  });

  it("epochNoProgress stays false for an ended epoch still inside that deadline", async () => {
    const { ctx } = context({
      pool: pool({ vrfTimeout: 120n }),
      previousEpoch: ended({ endsAt: NOW - (120n + 300n - 1n) }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
  });

  it("epochNoProgress clears once the epoch reaches Paid or RolledOver, no matter its age", async () => {
    const { ctx } = context({
      previousEpoch: epoch({ status: EPOCH_STATUS.PAID, endsAt: NOW - 1_000_000n }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
  });

  it("drawnUnpaid fires once a drawn epoch outlives DRAWN_UNPAID_ALERT_SECONDS, before payout_timeout does", async () => {
    const { ctx } = context({
      pool: pool({ payoutTimeout: 86_400n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n),
      }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.drawnUnpaid).toBe(true);
  });

  it("drawnUnpaid stays false for a drawn epoch still inside the alert window", async () => {
    const { ctx } = context({
      pool: pool({ payoutTimeout: 86_400n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS - 1n),
      }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.drawnUnpaid).toBe(false);
  });
});

describe("venue cranks (ticket 13)", () => {
  const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
  const RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  // The three accounts klend.rs wants after the pinned four, as the mainnet
  // USDC reserve has them (tests/fork/klend.fork.ts).
  const LMA = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND)[0];
  const LIQ_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6");
  const CMINT = new PublicKey("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");
  const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111";
  const CTOKEN = Keypair.generate().publicKey;
  const U = 1_000_000n;

  // No round and no epoch end in sight, so the venue step is the only thing
  // the tick has to do.
  const venuePool = (over: Partial<PoolState> = {}): PoolState =>
    pool({
      acceptedMint: USDC,
      klendProgram: KLEND,
      klendMarket: MARKET,
      klendReserve: RESERVE,
      klendCtoken: CTOKEN,
      openRoundId: 0n,
      paused: true,
      ...over,
    });

  const venueTick = (vault: bigint, over: Partial<TickContext> = {}) =>
    context({
      pool: venuePool(),
      openRound: null,
      principalVaultBalance: async () => vault,
      ...over,
    });

  /** The decoded amount of the single instruction a tick sent. */
  const amountSent = (sent: TransactionInstruction[][]): string => {
    const decoded = coder.decode((sent[0]?.[0] as TransactionInstruction).data);
    return (decoded?.data as { amount: { toString(): string } }).amount.toString();
  };

  it("deploys the excess above the idle target without being asked", async () => {
    // 10,000 free idle, target 10% of it: 9,000 may go.
    const { ctx, sent } = venueTick(10_000n * U);
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("deploy_to_venue");
    expect((sent[0] ?? []).map(label)).toEqual(["deploy_to_venue"]);
    expect(amountSent(sent)).toBe((9_000n * U).toString());
  });

  it("passes the pinned klend accounts and the three the venue backing needs", async () => {
    const { ctx, sent } = venueTick(10_000n * U);
    await runTick(ctx);
    const keys = (sent[0]?.[0]?.keys ?? []).map((key) => key.pubkey.toBase58());

    for (const pinned of [KLEND, MARKET, RESERVE, CTOKEN]) expect(keys).toContain(pinned.toBase58());
    // klend.rs documents the order: market authority, supply vault, cToken
    // mint, instructions sysvar; the program checks each against the reserve.
    expect(keys.slice(-4)).toEqual([LMA, LIQ_SUPPLY, CMINT].map((k) => k.toBase58()).concat(SYSVAR_IX));
  });

  it("passes the venue proposal PDA to a deploy, and skips on VenueProposalOpen without an alert", async () => {
    const { ctx, warned } = venueTick(10_000n * U, {
      send: async () => {
        throw new Error("VenueProposalOpen");
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.stepError).toBeUndefined();
    expect(outcome.action).toBeNull();
    expect(outcome.venueState?.failedAt.deploy).toBe(NOW);
    expect(warned.some((message) => message.includes("VenueProposalOpen"))).toBe(true);

    const built = await instructions.deployToVenue(venuePool(), 1n);
    expect(built[0]?.keys.map((key) => key.pubkey.toBase58())).toContain(
      venueProposalAddress(PROGRAM_ID, venuePool().address).toBase58(),
    );
  });

  // --- Venue-switch ticket 04: drain while a proposal stands.
  const LOCK = 48n * 60n * 60n;
  const elapsed = { proposedAt: NOW - LOCK - 10n };
  const heldPool = (over: Partial<PoolState> = {}) => venuePool({ venueValue: 5_000n * U, ...over });
  const drainTick = (over: Partial<TickContext> = {}) =>
    venueTick(1_000n * U, { pool: heldPool(), venueProposal: elapsed, ...over });

  it("drains the whole position once the lock has elapsed, signed by the Operator, and sends no deploy", async () => {
    const { ctx, sent } = drainTick();
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("drain_venue");
    expect((sent[0] ?? []).map(label)).toEqual(["drain_venue"]);
    expect(amountSent(sent)).toBe((5_000n * U).toString());
    const keys = keysOfIx(sent[0] ?? []);
    expect(keys).toContain(venueProposalAddress(PROGRAM_ID, heldPool().address).toBase58());
    // klend's extras ride along, so the redeem inside the drain can run.
    expect(keys.slice(-4)).toEqual([LMA, LIQ_SUPPLY, CMINT].map((k) => k.toBase58()).concat(SYSVAR_IX));
  });

  it("waits out the lock, and wakes when it ends", async () => {
    const { ctx, sent } = drainTick({ venueProposal: { proposedAt: NOW - LOCK + 30n } });
    const outcome = await runTick(ctx);

    expect(sent).toEqual([]);
    expect(outcome.action).toBeNull();
    expect(outcome.nextWakeAt).toBe(NOW + 30n);
  });

  it("sizes each step by the venue's free liquidity, one unit under it", async () => {
    const { ctx, sent } = drainTick({ venueAvailable: async () => 1_200n * U });
    await runTick(ctx);
    expect(amountSent(sent)).toBe((1_200n * U - 1n).toString());

    // More liquidity than position: the whole position.
    const roomy = drainTick({ venueAvailable: async () => 9_000n * U });
    await runTick(roomy.ctx);
    expect(amountSent(roomy.sent)).toBe((5_000n * U).toString());
  });

  it("stops draining when the position is down to dust (it migrates instead), the venue has no liquidity or the proposal is gone", async () => {
    // Dust: nothing more to drain, so the migration is what goes out.
    const dust = drainTick({ pool: heldPool({ venueValue: 100n * U }) });
    expect((await runTick(dust.ctx)).action).toBe("migrate_venue");

    for (const over of [
      { venueAvailable: async () => 0n },
      { venueAvailable: async () => 1n },
    ]) {
      const { ctx, sent } = drainTick(over);
      expect((await runTick(ctx)).action).toBeNull();
      expect(sent).toEqual([]);
    }

    // No proposal: the same pool deploys again instead of draining.
    const gone = drainTick({ venueProposal: null });
    expect((await runTick(gone.ctx)).action).toBe("deploy_to_venue");
  });

  it("cools down after a refused drain, with a warning and no alert", async () => {
    const { ctx, warned } = drainTick({
      send: async () => {
        throw new Error("VenueIlliquid");
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.stepError).toBeUndefined();
    expect(outcome.venueState?.failedAt.drain).toBe(NOW);
    expect(warned.some((message) => message.includes("drain refused"))).toBe(true);

    const retry = drainTick({ lastVenueState: outcome.venueState ?? null, now: NOW + 30n });
    await runTick(retry.ctx);
    expect(retry.sent).toEqual([]);
  });

  // --- Venue-switch ticket 05: migrate once the lock has elapsed and the
  // position is down to dust.
  const emptied = () => drainTick({ pool: heldPool({ venueValue: 40n * U }) });

  it("migrates when the lock has elapsed and the position is at or under min_venue_move, then resumes deploys", async () => {
    const { ctx, sent } = emptied();
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("migrate_venue");
    expect((sent[0] ?? []).map(label)).toEqual(["migrate_venue"]);
    const keys = keysOfIx(sent[0] ?? []);
    const old = heldPool();
    // The OLD pins and extras (the sync inside values the old venue), the
    // proposal, and the Admin who gets the rent back.
    for (const pinned of [old.klendProgram, old.klendMarket, old.klendReserve, old.klendCtoken, old.admin]) {
      expect(keys).toContain(pinned.toBase58());
    }
    expect(keys).toContain(venueProposalAddress(PROGRAM_ID, old.address).toBase58());
    expect(keys.slice(-4)).toEqual([LMA, LIQ_SUPPLY, CMINT].map((k) => k.toBase58()).concat(SYSVAR_IX));

  });

  it("a migration clears a deploy cool-down earned before it, and deploys run again once the proposal is gone", async () => {
    const cooling = { harvestedEpoch: null, failedAt: { deploy: NOW } };
    const { ctx } = drainTick({
      pool: heldPool({ venueValue: 40n * U }),
      lastVenueState: cooling,
    });
    const migrated = await runTick(ctx);
    expect(migrated.action).toBe("migrate_venue");
    expect(migrated.venueState?.failedAt.deploy).toBeUndefined();

    // The next tick reads the closed proposal as none and deploys.
    const next = venueTick(10_000n * U, { lastVenueState: migrated.venueState ?? null });
    expect((await runTick(next.ctx)).action).toBe("deploy_to_venue");
  });

  it("does not migrate before the lock ends or while the position is above dust, and drains first", async () => {
    const early = venueTick(1_000n * U, {
      pool: heldPool({ venueValue: 40n * U }),
      venueProposal: { proposedAt: NOW - LOCK + 30n },
    });
    expect((await runTick(early.ctx)).action).toBeNull();
    expect(early.sent).toEqual([]);

    const heavy = drainTick();
    expect((await runTick(heavy.ctx)).action).toBe("drain_venue");

    // At exactly min_venue_move the program accepts; one more and it does not.
    const edge = drainTick({ pool: heldPool({ venueValue: 100n * U }) });
    expect((await runTick(edge.ctx)).action).toBe("migrate_venue");
    const over = drainTick({ pool: heldPool({ venueValue: 100n * U + 1n }) });
    expect((await runTick(over.ctx)).action).toBe("drain_venue");
  });

  it("a migration the program refuses is a warning and a cool-down, not an alert", async () => {
    for (const code of ["VenueLockNotElapsed", "VenuePositionNotEmpty"]) {
      const { ctx, warned } = drainTick({
        pool: heldPool({ venueValue: 40n * U }),
        send: async () => {
          throw new Error(code);
        },
      });
      const outcome = await runTick(ctx);
      expect(outcome.stepError).toBeUndefined();
      expect(outcome.venueState?.failedAt.migrate).toBe(NOW);
      expect(warned.some((message) => message.includes(code))).toBe(true);
    }
  });

  it("takes the liquidity read only when a drain is due", async () => {
    let reads = 0;
    const venueAvailable = async () => {
      reads += 1;
      return null;
    };
    await runTick(venueTick(1_000n * U, { pool: heldPool(), venueAvailable }).ctx);
    await runTick(drainTick({ venueProposal: { proposedAt: NOW }, venueAvailable }).ctx);
    expect(reads).toBe(0);
    await runTick(drainTick({ venueAvailable }).ctx);
    expect(reads).toBe(1);
  });

  it("takes no extra accounts for the stub kind", async () => {
    const { ctx, sent } = venueTick(10_000n * U, {
      pool: venuePool({ klendProgram: PROGRAM_ID, venueKind: VENUE_KIND.stub }),
    });
    await runTick(ctx);
    expect(sent[0]?.[0]?.keys.map((key) => key.pubkey.toBase58())).not.toContain(SYSVAR_IX);
  });

  it("chooses accounts by the kind, not by which program is pinned", async () => {
    // klend kind with this program pinned still gets klend's four extras; the
    // stub kind with klend pinned gets none.
    const klendKind = venueTick(10_000n * U, { pool: venuePool({ klendProgram: PROGRAM_ID }) });
    await runTick(klendKind.ctx);
    expect(klendKind.sent[0]?.[0]?.keys.map((key) => key.pubkey.toBase58())).toContain(SYSVAR_IX);
    const stubKind = venueTick(10_000n * U, { pool: venuePool({ venueKind: VENUE_KIND.stub }) });
    await runTick(stubKind.ctx);
    expect(stubKind.sent[0]?.[0]?.keys.map((key) => key.pubkey.toBase58())).not.toContain(SYSVAR_IX);
  });

  it("builds nothing for a venue kind it does not know", async () => {
    const { ctx, sent } = venueTick(10_000n * U, { pool: venuePool({ venueKind: 2 }) });
    await runTick(ctx).catch(() => undefined);
    expect(sent).toHaveLength(0);
  });

  it("never deploys under the minimum size", async () => {
    // 110 free idle, target 11: only 99 is above it, under the 100 minimum.
    const { ctx, sent } = venueTick(110n * U);
    expect((await runTick(ctx)).action).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("counts the venue position and the queued withdrawals when sizing the target", async () => {
    // Free idle 4,000 (5,000 less 1,000 queued), venue 6,000: total 10,000,
    // target 1,000, so 3,000 is the excess, less the 0.6 margin (1 bp of 6,000).
    const { ctx, sent } = venueTick(5_000n * U, {
      pool: venuePool({ pendingWithdrawals: 1_000n * U, venueValue: 6_000n * U }),
    });
    await runTick(ctx);
    expect(amountSent(sent)).toBe((3_000n * U - 600_000n).toString());
  });

  it("leaves room for the gain deploy_to_venue books at its sync", async () => {
    // The surf fork's numbers: an exact fit failed once the program's sync
    // added the yield since the last write to venue_value.
    const pool = venuePool({ venueValue: 3_150_011_610n });
    const vault = 4_350_000_001n;
    const { ctx, sent } = venueTick(vault, { pool });
    await runTick(ctx);
    const amount = BigInt(amountSent(sent));

    // What the program allows after a sync that found `gain` more in the venue.
    const allowed = (gain: bigint) => vault - ((vault + pool.venueValue + gain) * 1_000n + 9_999n) / 10_000n;
    expect(amount).toBeLessThan(allowed(0n));
    expect(amount).toBeLessThanOrEqual(allowed(3_150_000n)); // a 0.1% gain still fits
  });

  it("recalls up to the target when free idle is under the floor", async () => {
    // Free idle 100, venue 9,900: total 10,000, floor 500, target 1,000.
    const { ctx, sent } = venueTick(100n * U, { pool: venuePool({ venueValue: 9_900n * U }) });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("recall");
    expect((sent[0] ?? []).map(label)).toEqual(["recall"]);
    expect(amountSent(sent)).toBe((900n * U).toString());
  });

  it("does not recall between the floor and the target", async () => {
    const { ctx, sent } = venueTick(700n * U, { pool: venuePool({ venueValue: 9_300n * U }) });
    expect((await runTick(ctx)).action).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("recalls exactly the gap when a small queued withdrawal is all that is short", async () => {
    // 40 in the vault against 50 queued: the gap is 10. Bringing free idle up
    // to the target would be 49, under the 100 minimum, and that is when the
    // program takes the exact gap instead.
    const { ctx, sent } = venueTick(40n * U, {
      pool: venuePool({ pendingWithdrawals: 50n * U, venueValue: 400n * U }),
    });
    await runTick(ctx);
    expect(sent[0]?.map(label)).toEqual(["recall"]);
    expect(amountSent(sent)).toBe((10n * U).toString());
  });

  it("never recalls more than the venue holds", async () => {
    const { ctx, sent } = venueTick(0n, {
      pool: venuePool({ pendingWithdrawals: 500n * U, venueValue: 300n * U }),
    });
    await runTick(ctx);
    // Free idle is -500: wanting the target and the gap, it settles for the
    // whole position, which is over the minimum.
    expect(amountSent(sent)).toBe((300n * U).toString());
  });

  it("does not deploy while deploy is paused, the venue is impaired or the pool is shut down", async () => {
    for (const over of [{ deployPaused: true }, { impaired: true }, { shutdown: true }]) {
      const { ctx, sent } = venueTick(10_000n * U, { pool: venuePool(over) });
      expect((await runTick(ctx)).action).toBeNull();
      expect(sent).toHaveLength(0);
    }
  });

  it("still recalls while impaired: a haircut is not a reason to leave Pending stuck", async () => {
    const { ctx, sent } = venueTick(100n * U, {
      pool: venuePool({ impaired: true, venueValue: 9_900n * U }),
    });
    await runTick(ctx);
    expect(sent[0]?.map(label)).toEqual(["recall"]);
  });

  it("does nothing on a pool whose klend addresses are not pinned yet", async () => {
    const { ctx, sent } = venueTick(10_000n * U, { pool: venuePool({ klendProgram: PublicKey.default }) });
    expect((await runTick(ctx)).action).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("does not retry a refused crank in a tight loop", async () => {
    const refused = venueTick(10_000n * U, {
      send: async () => {
        throw new Error("DeployExceedsIdle");
      },
    });
    const first = await runTick(refused.ctx);
    // Expected refusals warn; they are not a tick error.
    expect(first.stepError).toBeUndefined();
    expect(refused.warned).toHaveLength(1);
    expect(first.venueState?.failedAt.deploy).toBe(NOW);

    const soon = venueTick(10_000n * U, { lastVenueState: first.venueState ?? null, now: NOW + 30n });
    expect((await runTick(soon.ctx)).action).toBeNull();
    expect(soon.sent).toHaveLength(0);

    const later = venueTick(10_000n * U, {
      lastVenueState: first.venueState ?? null,
      now: NOW + VENUE_RETRY_SECONDS,
    });
    expect((await runTick(later.ctx)).action).toBe("deploy_to_venue");
  });

  it("records an unexpected crank failure as a tick error and carries on", async () => {
    const { ctx } = venueTick(10_000n * U, {
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.stepError).toBe("deploy failed: blockhash expired");
    expect(outcome.action).toBeNull();
  });

  // --- harvest: once per epoch, in the last HARVEST_LEAD_SECONDS before it ends.

  const harvestPool = (over: Partial<PoolState> = {}): PoolState =>
    venuePool({ venueValue: 9_000n * U, paused: false, ...over });
  const endingIn = (seconds: bigint) => epoch({ endsAt: NOW + seconds });

  it("harvests inside the window before the epoch ends, and only once", async () => {
    const first = context({
      pool: harvestPool(),
      openRound: null,
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
    });
    const outcome = await runTick(first.ctx);
    expect(outcome.action).toBe("harvest");
    expect((first.sent[0] ?? []).map(label)).toEqual(["harvest"]);
    expect(keysOfIx(first.sent[0] ?? [])).toContain(first.ctx.pool.treasury.toBase58());
    expect(outcome.venueState?.harvestedEpoch).toBe(2n);

    // Next tick: the epoch is marked, so nothing more goes out.
    const again = context({
      pool: harvestPool(),
      openRound: null,
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      lastVenueState: outcome.venueState ?? null,
    });
    expect((await runTick(again.ctx)).action).not.toBe("harvest");
  });

  it("does not harvest before the window, or while impaired", async () => {
    for (const [pool_, epoch_] of [
      [harvestPool(), endingIn(HARVEST_LEAD_SECONDS + 1n)],
      [harvestPool({ impaired: true }), endingIn(10n)],
    ] as const) {
      const { ctx } = context({
        pool: pool_,
        openRound: null,
        currentEpoch: epoch_,
        principalVaultBalance: async () => 1_000n * U,
      });
      expect((await runTick(ctx)).action).not.toBe("harvest");
    }
  });

  it("wakes when the harvest window opens", async () => {
    const { ctx } = context({
      pool: harvestPool({ paused: true }),
      openRound: null,
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS + 50n),
      principalVaultBalance: async () => 1_000n * U,
    });
    expect((await runTick(ctx)).nextWakeAt).toBe(NOW + 50n);
  });

  it("a failed harvest does not block the rest of the tick", async () => {
    const { ctx, sent } = context({
      pool: harvestPool(),
      openRound: null,
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "harvest")) throw new Error("ReserveStale");
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.stepError).toBe("harvest failed: ReserveStale");
    expect(outcome.action).toBe("create_round");
    expect(outcome.venueState?.failedAt.harvest).toBe(NOW);
    expect(outcome.venueState?.harvestedEpoch).toBeNull();
  });

  it("NothingToHarvest counts as harvested for the epoch", async () => {
    const { ctx } = context({
      pool: harvestPool(),
      openRound: null,
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "harvest")) throw new Error("NothingToHarvest");
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.stepError).toBeUndefined();
    expect(outcome.venueState?.harvestedEpoch).toBe(2n);
  });

  // --- Pending withdrawals the vault cannot cover: recall first, then push.

  it("recalls before pushing a matured withdrawal the vault cannot cover", async () => {
    const due = [{ owner: Keypair.generate().publicKey.toBase58(), amount: 500n * U }];
    const { ctx, sent } = venueTick(100n * U, {
      pool: venuePool({ pendingWithdrawals: 500n * U, venueValue: 9_900n * U }),
      duePendingWithdrawals: async () => due,
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("recall");
    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(["recall"]);
  });

  it("pushes the withdrawal once the vault covers it", async () => {
    const due = [{ owner: Keypair.generate().publicKey.toBase58(), amount: 500n * U }];
    const { ctx, sent } = venueTick(1_500n * U, {
      pool: venuePool({ pendingWithdrawals: 500n * U, venueValue: 8_500n * U }),
      duePendingWithdrawals: async () => due,
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("process_withdraw");
    expect((sent[0] ?? []).map(label)).toContain("process_withdraw");
  });

  it("falls through to the push, and its shortfall report, when the recall is refused", async () => {
    const due = [{ owner: Keypair.generate().publicKey.toBase58(), amount: 500n * U }];
    const { ctx } = venueTick(100n * U, {
      pool: venuePool({ pendingWithdrawals: 500n * U, venueValue: 9_900n * U }),
      duePendingWithdrawals: async () => due,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "recall")) throw new Error("VenueIlliquid");
        throw new Error("InsufficientVaultLiquidity");
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBeNull();
    expect(outcome.withdrawShortfall).toBe(400n * U);
    expect(outcome.venueState?.failedAt.recall).toBe(NOW);
  });
});

describe("instruction builders", () => {
  const keysOf = (ixs: readonly TransactionInstruction[]): string[] =>
    (ixs[0]?.keys ?? []).map((key) => key.pubkey.toBase58());

  it("hand void_round and rollover_epoch the request's randomness account", async () => {
    // The program matches both against the seed on the Round or Epoch, so a
    // builder that forgets the account cannot void or roll over at all.
    const openRound = round({ status: ROUND_STATUS.REQUESTED });
    expect(keysOf(await instructions.voidRound(pool(), openRound))).toContain(
      instructions.randomnessFor(openRound.vrfSeed).toBase58(),
    );

    const drawing = epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING });
    expect(keysOf(await instructions.rolloverEpoch(pool(), drawing))).toContain(
      instructions.randomnessFor(drawing.vrfSeed).toBase58(),
    );
  });
});

describe("randomness", () => {
  it("hashes seeds the way solana_keccak_hasher does", () => {
    expect(Buffer.from(keccak256(new Uint8Array(0))).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(Buffer.from(keccak256(Buffer.from("abc"))).toString("hex")).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  const NONCE_A = new Uint8Array(32).fill(1);
  const NONCE_B = new Uint8Array(32).fill(2);

  it("separates seeds by domain, pool, id and nonce", () => {
    const other = poolAddress(PROGRAM_ID, 2n);
    const base = vrfSeed("epoch", POOL, 7n, NONCE_A);
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n, NONCE_A))).toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("round", POOL, 7n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", other, 7n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", POOL, 8n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n, NONCE_B))).not.toEqual(
      Buffer.from(base),
    );
  });

  it("uses this program's PDA under test-vrf and ORAO's otherwise", () => {
    const seed = vrfSeed("round", POOL, 1n, NONCE_A);
    const test = randomnessAddress(PROGRAM_ID, seed, true);
    const orao = randomnessAddress(PROGRAM_ID, seed, false);
    expect(test.equals(orao)).toBe(false);
    expect(test).toEqual(
      PublicKey.findProgramAddressSync(
        [Buffer.from("test-vrf"), Buffer.from(seed)],
        PROGRAM_ID,
      )[0],
    );
  });

  it("accepts only a fulfilled RandomnessV2 account", () => {
    // [8 discriminator][1 tag][32 client][32 seed][64 randomness]
    const account = Buffer.concat([
      Buffer.from("8befb8d7e356bfe2", "hex"),
      Buffer.from([1]),
      Buffer.alloc(128, 9),
    ]);
    expect(isFulfilled(account)).toBe(true);

    const pending = Buffer.from(account);
    pending[8] = 0;
    expect(isFulfilled(pending)).toBe(false);

    const foreign = Buffer.from(account);
    foreign[0] = 0xff;
    expect(isFulfilled(foreign)).toBe(false);

    expect(isFulfilled(account.subarray(0, account.length - 1))).toBe(false);
    expect(isFulfilled(null)).toBe(false);
  });
});

describe("clockUnixTimestamp", () => {
  it("reads unix_timestamp out of the Clock sysvar", () => {
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    expect(clockUnixTimestamp(clock)).toBe(1_800_000_000n);
    expect(() => clockUnixTimestamp(undefined)).toThrow(/clock sysvar/);
  });
});

describe("msUntilWake", () => {
  it("converts a chain-seconds gap straight to wall-clock ms", () => {
    expect(msUntilWake(NOW, NOW + 30n)).toBe(30_000);
  });

  it("never goes negative for a deadline already behind now", () => {
    expect(msUntilWake(NOW, NOW - 5n)).toBe(0);
  });

  it("clamps to the safety interval for a far-off deadline", () => {
    expect(msUntilWake(NOW, NOW + 86_400n)).toBe(
      Number(SAFETY_INTERVAL_SECONDS) * 1000,
    );
  });
});
