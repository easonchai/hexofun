// Step selection is the whole operator: given a state, exactly one thing
// should happen. The instructions built here are the real ones, decoded back
// out of the recorded transaction, so a wrong account list still shows up.
import { KLEND_PROGRAM_ID } from "../chain/kvault";
import { kvaultFixture } from "../chain/kvault.fixture";
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
import { playerAddress, poolAddress, venueProposalAddress } from "../chain/pda";
import type { WinnerProof } from "../snapshot/epoch-draw";
import { buildSumTree } from "../snapshot/sum-tree";
import {
  EPOCH_STATUS,
  clockUnixTimestamp,
  type EpochState,
  type PoolState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";
import {
  DRAWN_UNPAID_ALERT_SECONDS,
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
import { epochSeed, isFulfilled, randomnessAddress } from "./vrf";

const AUTHORITY = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);

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
  vrfTimeout: 120n,
  payoutTimeout: 86_400n,
  paused: false,
  currentEpochId: 2n,
  totalPrincipal: 1_000_000_000n,
  shutdown: false,
  jackpotPaused: false,
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

/** An Epoch snapshot of five wallets, in leaf order (by wallet bytes), 10 to 50 Tickets each. */
const SNAPSHOT_OWNERS = Array.from({ length: 5 }, () => Keypair.generate().publicKey).sort((a, b) =>
  Buffer.compare(a.toBuffer(), b.toBuffer()),
);
const SNAPSHOT = buildSumTree(
  SNAPSHOT_OWNERS.map((owner, i) => ({ wallet: owner.toBuffer(), tickets: BigInt(10 * (i + 1)) })),
);
const NONCE = new Uint8Array(32).fill(9);
/** The winner `findWinner` names for `target`, as the Epoch snapshot rows would back it. */
function proofAt(target: bigint): WinnerProof {
  const { index, tickets } = SNAPSHOT.findWinner(target);
  return {
    commitment: SNAPSHOT,
    index,
    owner: (SNAPSHOT_OWNERS[index] as PublicKey).toBase58(),
    tickets,
    siblings: SNAPSHOT.proof(index),
  };
}
/** The arguments of the first recorded instruction, decoded back off its data. */
const argsOf = (ixs: readonly TransactionInstruction[] | undefined): Record<string, unknown> =>
  (coder.decode((ixs?.[0] as TransactionInstruction).data)?.data ?? {}) as Record<string, unknown>;

interface Recorder {
  ctx: TickContext;
  sent: TransactionInstruction[][];
  warned: string[];
  debugged: string[];
}

function context(over: Partial<TickContext> = {}): Recorder {
  const sent: TransactionInstruction[][] = [];
  const warned: string[] = [];
  const debugged: string[] = [];
  const ctx: TickContext = {
    now: NOW,
    pool: pool(),
    // A healthy mid-epoch state: epoch running, previous one already paid.
    currentEpoch: epoch(),
    previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
    ix: instructions,
    lastWithdrawState: null,
    lastVenueState: null,
    // No venue change open by default (venue-switch ticket 04).
    venueProposal: null,
    venueAvailable: async () => null,
    // Unconfigured by default (ticket 05): begin_epoch is never withheld in
    // any test that is not about the launch window.
    launchAt: null,
    fulfilled: async () => false,
    // No snapshot yet, no proof by default: the draw steps wait on them.
    drawRequest: async () => null,
    payoutProof: async () => null,
    snapshotMismatchEpoch: null,
    principalVaultBalance: async () => 0n,
    // Empty by default so step 6b stays quiet in every test that is not about it.
    duePendingWithdrawals: async () => [],
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    warn: (message) => warned.push(message),
    debug: (message) => debugged.push(message),
    ...over,
  };
  return { ctx, sent, warned, debugged };
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
  it("sends nothing on a healthy mid-epoch state", async () => {
    const result = await tickLabels();
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
    // The epoch end is a day off, so the safety interval is the soonest
    // thing that could re-check.
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  // --- 3. Begin Epoch: only once the previous Epoch (if any) is Paid or
  // Rolled over. The Round steps left with the program (off-chain-tickets
  // ticket 10).

  it("3. begins the first epoch when the pool has none", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  it("3. begins the next epoch once it has ended and the previous epoch is paid", async () => {
    const result = await tickLabels({
      pool: pool(),
      currentEpoch: epoch({ endsAt: NOW }),
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("3. does not begin the epoch while the previous epoch has not been sent to the draw", async () => {
    const result = await tickLabels({
      pool: pool(),
      currentEpoch: epoch({ endsAt: NOW }),
      previousEpoch: ended(),
    });
    expect(result.action).not.toBe("begin_epoch");
    expect(result.transactions).toBe(0);
  });

  // --- 3 (ticket 05): LAUNCH_AT holds back only the Pool's very first
  // begin_epoch (no Epoch yet), so deposits can open before the launch time
  // with nothing else in the tick changing.

  it("3. a future launch time withholds the first begin_epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
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
      pool: pool({ currentEpochId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      launchAt: NOW + 10n,
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 10n);
  });

  it("3. a past launch time begins the first epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      launchAt: NOW - 1n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  // game-jackpot-pause ticket 02: begin_epoch is refused under jackpot
  // pause, and a new pool starts that way.
  it("3. does not begin the first epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, jackpotPaused: true }),
      currentEpoch: null,
      previousEpoch: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. does not begin the next epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ jackpotPaused: true }),
      currentEpoch: epoch({ endsAt: NOW }),
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. LAUNCH_AT does not hold back a later epoch once one already exists", async () => {
    const result = await tickLabels({
      pool: pool(),
      currentEpoch: epoch({ endsAt: NOW }),
      launchAt: NOW + 3_600n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  // --- 3 (begin_epoch accounts): the program syncs the venue first, so the
  // instruction carries the pinned venue accounts and the sync's extras.

  it("3. passes the pinned venue accounts to begin_epoch", async () => {
    const venue = {
      klendProgram: Keypair.generate().publicKey,
      klendMarket: Keypair.generate().publicKey,
      klendReserve: Keypair.generate().publicKey,
      klendCtoken: Keypair.generate().publicKey,
    };
    const { ctx, sent } = context({
      pool: pool({ currentEpochId: 0n, ...venue }),
      currentEpoch: null,
      previousEpoch: null,
    });
    await runTick(ctx);
    const keys = keysOfIx(sent[0] ?? []);
    for (const key of Object.values(venue)) expect(keys).toContain(key.toBase58());
  });

  // --- 4. request_draw: the ended epoch goes to the draw once the backend has
  // built its snapshot (ticket 12). Until then the step reports it is waiting.

  it("4. reports an ended epoch as waiting on the snapshot and sends nothing", async () => {
    const { ctx, sent } = context({ previousEpoch: ended() });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    expect(outcome.snapshotPending).toEqual({ step: "request_draw", epochId: 1n });
  });

  it("4. holds as snapshot_pending until the Epoch row has a root, then sends request_draw with its four fields", async () => {
    const waiting = context({ previousEpoch: ended() });
    const first = await runTick(waiting.ctx);
    expect(first.snapshotPending).toEqual({ step: "request_draw", epochId: 1n });
    expect(waiting.sent).toHaveLength(0);

    const ready = context({
      previousEpoch: ended(),
      drawRequest: async () => ({ nonce: NONCE, snapshot: SNAPSHOT }),
    });
    const outcome = await runTick(ready.ctx);
    expect(outcome.action).toBe("request_draw");
    expect(outcome.snapshotPending).toBeUndefined();
    expect(ready.sent.map((ixs) => ixs.map(label))).toEqual([["request_draw"]]);
    const args = argsOf(ready.sent[0]) as Record<string, { toString(): string }>;
    expect(Buffer.from(args.nonce as unknown as number[])).toEqual(Buffer.from(NONCE));
    expect(Buffer.from(args.root as unknown as number[])).toEqual(SNAPSHOT.root);
    expect(args.total_tickets?.toString()).toBe(SNAPSHOT.total.toString());
    expect(args.depth).toBe(SNAPSHOT.depth);
    expect(args.leaf_count).toBe(SNAPSHOT.leafCount);
    // The randomness account is the one the seed over those fields names.
    const seed = epochSeed(POOL, 1n, NONCE, SNAPSHOT.root, SNAPSHOT.total);
    expect(keysOfIx(ready.sent[0] ?? [])).toContain(randomnessAddress(PROGRAM_ID, seed, true).toBase58());
  });

  it("4. an empty snapshot commits zeros, which the program rolls over", async () => {
    const empty = { root: Buffer.alloc(32), depth: 0, leafCount: 0, total: 0n };
    const { ctx, sent } = context({
      previousEpoch: ended(),
      drawRequest: async () => ({ nonce: NONCE, snapshot: empty }),
    });
    await runTick(ctx);
    const args = argsOf(sent[0]) as Record<string, { toString(): string }>;
    expect(Buffer.from(args.root as unknown as number[])).toEqual(Buffer.alloc(32));
    expect([args.total_tickets?.toString(), args.depth, args.leaf_count]).toEqual(["0", 0, 0]);
  });

  it("4. waits, and reports nothing, while the pool is shut down or the jackpot is paused", async () => {
    for (const over of [{ shutdown: true }, { jackpotPaused: true }]) {
      const { ctx, sent } = context({ pool: pool(over), previousEpoch: ended() });
      const outcome = await runTick(ctx);
      expect(sent).toHaveLength(0);
      expect(outcome.action).toBeNull();
      expect(outcome.snapshotPending).toBeUndefined();
    }
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

  it("5. draws once the pool is shut down: the program allows it, so a fulfilled epoch is not stranded", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["draw"]);
  });

  it("5. draws a fulfilled epoch in shutdown even past the timeout, never a rollover the program refuses", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["draw"]);
  });

  it("5. still rolls a shut-down pool's unfulfilled draw over once the timeout elapses", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
  });

  // --- 6. Payout: the winner's leaf and proof, out of the snapshot rows.

  const drawn = (over: Partial<EpochState> = {}): EpochState =>
    epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n, drawnAt: NOW - 10n, ...over });

  it("6. pays the winner with a proof as long as the snapshot is deep", async () => {
    const target = 42n;
    const winner = proofAt(target);
    const { ctx, sent } = context({
      previousEpoch: drawn({ target }),
      payoutProof: async (epochId, drawnTarget) => {
        expect([epochId, drawnTarget]).toEqual([1n, target]);
        return winner;
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("payout");
    expect(outcome.snapshotMismatchEpoch).toBeNull();
    expect(sent.map((ixs) => ixs.map(label))).toEqual([["payout"]]);
    const args = argsOf(sent[0]) as { index: number; tickets: { toString(): string }; siblings: unknown[] };
    expect(args.siblings).toHaveLength(SNAPSHOT.depth);
    expect(args.index).toBe(winner.index);
    expect(args.tickets.toString()).toBe(winner.tickets.toString());
    expect(keysOfIx(sent[0] ?? [])).toContain(playerAddress(PROGRAM_ID, POOL, new PublicKey(winner.owner)).toBase58());
  });

  it("6. a refused proof raises the mismatch once and the next tick does not retry", async () => {
    const proof = proofAt(42n);
    let attempts = 0;
    const warned: string[] = [];
    const common = {
      pool: pool({ paused: true }),
      previousEpoch: drawn(),
      payoutProof: async () => proof,
      send: async () => {
        attempts += 1;
        throw new Error("ProofRootMismatch");
      },
      warn: (message: string) => warned.push(message),
    };
    const first = await runTick(context(common).ctx);
    expect(first.action).toBeNull();
    expect(first.snapshotMismatchEpoch).toBe(1n);

    // The service hands the outcome back in as the next tick's context.
    const second = await runTick(context({ ...common, snapshotMismatchEpoch: first.snapshotMismatchEpoch ?? null }).ctx);
    expect(second.snapshotMismatchEpoch).toBe(1n);
    expect(attempts).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("ProofRootMismatch");
  });

  it("6. rows that cannot back the root are the same mismatch, with nothing sent", async () => {
    const { ctx, sent, warned } = context({ previousEpoch: drawn(), payoutProof: async () => null });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.snapshotMismatchEpoch).toBe(1n);
    expect(warned).toHaveLength(1);
  });

  it("6. (audit 04) an unknown payout failure is the step error, and the epoch still rolls over past its timeouts", async () => {
    const sends: string[] = [];
    const { ctx } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: drawn({ drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n) }),
      payoutProof: async () => proofAt(42n),
      send: async (ixs) => {
        const name = label(ixs[0]!);
        sends.push(name);
        if (name === "payout") throw new Error("InsufficientVaultLiquidity");
        return "sig";
      },
    });
    const outcome = await runTick(ctx);
    expect(sends).toEqual(["payout", "rollover_epoch"]);
    expect(outcome.action).toBe("rollover_epoch");
    expect(outcome.stepError).toBe("payout failed: InsufficientVaultLiquidity");
  });

  it("6. (audit 04) an unknown payout failure still lets a due withdrawal through", async () => {
    const sends: string[] = [];
    const { ctx } = context({
      pool: pool({ paused: true }),
      previousEpoch: drawn(),
      payoutProof: async () => proofAt(42n),
      duePendingWithdrawals: async () => pending(1),
      send: async (ixs) => {
        const name = label(ixs.at(-1)!);
        sends.push(name);
        if (name === "payout") throw new Error("InsufficientVaultLiquidity");
        return "sig";
      },
    });
    const outcome = await runTick(ctx);
    expect(sends).toEqual(["payout", "process_withdraw"]);
    expect(outcome.action).toBe("process_withdraw");
    expect(outcome.stepError).toBe("payout failed: InsufficientVaultLiquidity");
  });

  it("6. a payout that loses a race (an expected error) is a warning, not a step error", async () => {
    const { ctx, warned } = context({
      previousEpoch: drawn(),
      payoutProof: async () => proofAt(42n),
      send: async () => {
        throw new Error("EpochNotDrawn");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.stepError).toBeUndefined();
    expect(warned[0]).toContain("EpochNotDrawn");
  });

  it("6. a Drawn epoch with a stopped proof rolls over once its timeouts pass", async () => {
    const stopped = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: drawn({ drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n) }),
      payoutProof: async () => {
        throw new Error("not asked: this epoch's proof was refused");
      },
      snapshotMismatchEpoch: 1n,
    });
    const outcome = await runTick(stopped.ctx);
    expect(outcome.action).toBe("rollover_epoch");
    // Rolled over, no longer Drawn: the alert clears with the next tick's read.
    expect(outcome.snapshotMismatchEpoch).toBe(1n);
    const next = await runTick(
      context({ previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.ROLLED_OVER }), snapshotMismatchEpoch: 1n }).ctx,
    );
    expect(next.snapshotMismatchEpoch).toBeNull();
  });

  it("6. a winner with no Player account does not stop the tick, and the epoch rolls over past its timeouts", async () => {
    const sends: string[] = [];
    const { ctx, warned } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: drawn({ drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n) }),
      payoutProof: async () => proofAt(42n),
      send: async (ixs) => {
        const name = label(ixs[0]!);
        sends.push(name);
        if (name === "payout") throw new Error("AccountNotInitialized");
        return "sig";
      },
    });
    const outcome = await runTick(ctx);
    expect(sends).toEqual(["payout", "rollover_epoch"]);
    expect(outcome.action).toBe("rollover_epoch");
    expect(outcome.snapshotMismatchEpoch).toBeNull();
    expect(warned[0]).toContain("cannot be paid");
  });

  it("no tick, in any epoch state, sends a Round instruction", async () => {
    const proof = proofAt(42n);
    const labels = new Set<string>();
    for (const status of Object.values(EPOCH_STATUS)) {
      for (const over of [{}, { shutdown: true }, { jackpotPaused: true }]) {
        const { ctx, sent } = context({
          pool: pool(over),
          currentEpoch: epoch({ endsAt: NOW }),
          previousEpoch: epoch({ epochId: 1n, status, target: 42n, drawnAt: NOW - 10n, endsAt: NOW - 100n }),
          drawRequest: async () => ({ nonce: NONCE, snapshot: SNAPSHOT }),
          payoutProof: async () => proof,
          fulfilled: async () => true,
        });
        await runTick(ctx);
        for (const ixs of sent) for (const ix of ixs) labels.add(label(ix));
      }
    }
    expect([...labels].filter((name) => /round|position|grant|leaf/.test(name))).toEqual([]);
    expect(labels).toContain("request_draw");
    expect(labels).toContain("payout");
  });

  it("6. wakes at the payout timeout of a drawn epoch", async () => {
    // Paused, so nothing else contributes a nearer deadline.
    const result = await tickLabels({
      pool: pool({ paused: true, payoutTimeout: 30n }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 21n);
  });

  it("(audit-2026-10-10 03) wakes one second after a strict deadline, never at it", async () => {
    // `now` sits exactly on the deadline: the program's `now >` check is false,
    // so the tick does nothing, and a wake at `now` would spin until the clock moves.
    const vrf = await tickLabels({
      pool: pool({ paused: true }),
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW - 120n }),
    });
    expect(vrf.transactions).toBe(0);
    expect(vrf.nextWakeAt).toBe(NOW + 1n);

    const payout = await tickLabels({
      pool: pool({ paused: true, payoutTimeout: 30n }),
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n, drawnAt: NOW - 30n }),
    });
    expect(payout.nextWakeAt).toBe(NOW + 1n);
  });

  it("6. rolls the drawn epoch over once payout_timeout and the drawn-unpaid alert window have both passed", async () => {
    const { ctx, sent } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n),
      }),
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("rollover_epoch");
    expect((sent[0] ?? []).map(label)).toEqual(["rollover_epoch"]);
  });

  it("6. (ticket 12) withholds rolling a drawn epoch over until the drawn-unpaid alert window has passed, even past payout_timeout", async () => {
    const { ctx, sent } = context({
      pool: pool({ payoutTimeout: 30n, paused: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        // Past payoutTimeout, but well inside DRAWN_UNPAID_ALERT_SECONDS.
        drawnAt: NOW - 31n,
      }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
    // No proof to send, so the epoch is only waiting out the alert window.
    expect(outcome.snapshotMismatchEpoch).toBe(1n);
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
      pool: pool({ paused: true }),
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

  it("6b. reports the gap and carries on when the vault is short", async () => {
    const { ctx, sent, warned } = context({
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
    // A short vault delays cash and nothing else.
    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("computes the VRF timeout as the deadline when it is the closest one", async () => {
    const result = await tickLabels({
      pool: pool({ paused: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 70n,
      }),
    });
    expect(result.transactions).toBe(0);
    // vrfTimeout (120n) minus the 70 elapsed seconds, plus the strict
    // deadline's one second, beats both the epoch end and the 60 s safety interval.
    expect(result.nextWakeAt).toBe(NOW + 51n);
  });

  it("6b. sizes the shortfall against the batch it tried, not the whole queue", async () => {
    const { ctx } = context({
      pool: pool({ paused: true }),
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

  it("6b. (ticket 06) any other program failure switches to single-send mode and records the error instead of throwing", async () => {
    const { ctx } = context({
      duePendingWithdrawals: async () => pending(1),
      send: async () => {
        throw new Error("AccountFrozen");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(outcome.stepError).toMatch(/AccountFrozen/);
    expect(outcome.withdrawState?.singleMode).toBe(true);
  });

  it("6b. (audit-2026-10-10 03) a timeout, a pending transaction or a blockhash error counts against nobody and keeps batching", async () => {
    const [entry] = pending(1);
    if (entry === undefined) throw new Error("test setup");
    const transient = [
      "transaction 5Kx still pending after 30000ms; the blockhash has not expired yet",
      "blockhash expired",
      "ETIMEDOUT",
      "fetch failed",
    ];
    let state: WithdrawState | null = null;
    for (const message of transient) {
      const { ctx } = context({
        lastWithdrawState: state,
        duePendingWithdrawals: async () => [entry],
        send: async () => {
          throw new Error(message);
        },
      });
      const outcome = await runTick(ctx);
      expect(outcome.stepError).toContain(message);
      state = outcome.withdrawState ?? state;
      expect(state?.singleMode).toBe(false);
      expect(state?.failures.size).toBe(0);
      expect(state?.skipped.size).toBe(0);
    }

    // The same owner in single mode: still no count, still not skipped.
    const single: WithdrawState = { epochId: 2n, singleMode: true, failures: new Map(), skipped: new Set() };
    for (let i = 0; i < WITHDRAW_FAILURE_LIMIT + 1; i += 1) {
      const { ctx } = context({
        lastWithdrawState: single,
        duePendingWithdrawals: async () => [entry],
        send: async () => {
          throw new Error("ETIMEDOUT");
        },
      });
      const outcome = await runTick(ctx);
      expect(outcome.withdrawState?.failures.size).toBe(0);
      expect(outcome.withdrawState?.skipped.size).toBe(0);
    }
  });

  it("6b. (audit 04) a NothingPending owner is dropped for the tick and the rest are paid, with no failure counted", async () => {
    const due = pending(3);
    const bad = due[1]!.owner;
    const paid: string[][] = [];
    const { ctx } = context({
      duePendingWithdrawals: async () => due,
      send: async (ixs) => {
        const owners = due.map((e) => e.owner).filter((o) => ixs.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === o)));
        if (owners.includes(bad)) throw new Error("NothingPending");
        paid.push(owners);
        return "sig";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("process_withdraw");
    // The offender is isolated by halving; everyone else lands in this tick.
    expect(paid.flat().sort()).toEqual([due[0]!.owner, due[2]!.owner].sort());
    expect(outcome.stepError).toBeUndefined();
    expect(outcome.withdrawState?.singleMode).toBe(false);
    expect(outcome.withdrawState?.failures.size).toBe(0);
  });

  it("6b. (audit 04) in single mode a NothingPending head does not block the next owner or add a failure", async () => {
    const due = pending(2);
    const failures = new Map([[due[0]!.owner, 1]]);
    const { ctx, sent } = context({
      duePendingWithdrawals: async () => due,
      lastWithdrawState: { epochId: 2n, singleMode: true, failures, skipped: new Set() },
      send: async (ixs) => {
        if (ixs.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === due[0]!.owner))) {
          throw new Error("NothingPending");
        }
        sent.push(ixs);
        return "sig";
      },
    });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(1);
    expect(outcome.stepError).toBeUndefined();
    expect(outcome.withdrawState?.failures.get(due[0]!.owner)).toBe(1);
  });

  it("6b. (audit 04) a queue of owners who were all paid already sends nothing and sets no error", async () => {
    const { ctx } = context({
      duePendingWithdrawals: async () => pending(2),
      send: async () => {
        throw new Error("NothingPending");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(outcome.stepError).toBeUndefined();
    expect(outcome.withdrawState?.singleMode).toBe(false);
  });

  it("6b. sends no withdrawal while the pool is impaired, and resumes when it clears", async () => {
    const due = pending(2);
    let asked = 0;
    const withdrawals = async () => {
      asked += 1;
      return due;
    };
    const impaired = context({
      pool: pool({ paused: true, impaired: true }),
      duePendingWithdrawals: withdrawals,
    });
    const held = await runTick(impaired.ctx);
    expect(held.action).toBeNull();
    expect(held.stepError).toBeUndefined();
    expect(impaired.sent).toHaveLength(0);
    expect(asked).toBe(0);

    const cleared = context({
      pool: pool({ paused: true, impaired: false }),
      duePendingWithdrawals: withdrawals,
    });
    const resumed = await runTick(cleared.ctx);
    expect(resumed.action).toBe("process_withdraw");
    expect((cleared.sent[0] ?? []).filter((ix) => label(ix) === "process_withdraw")).toHaveLength(2);
  });

  it("6b. (ticket 06) falls back to single sends after a batch failure", async () => {
    const owners = pending(3);
    let attempt = 0;
    const { ctx, sent } = context({
      pool: pool({ paused: true }),
      duePendingWithdrawals: async () => owners,
      send: async (ixs) => {
        attempt += 1;
        if (attempt === 1) throw new Error("AccountFrozen");
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
      pool: pool({ paused: true }),
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
        pool: pool({ paused: true }),
        lastWithdrawState: i === 0 ? { epochId: 2n, singleMode: true, failures: new Map(), skipped: new Set() } : state,
        duePendingWithdrawals: async () => [entry],
        send: async () => {
          throw new Error("AccountFrozen");
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
      pool: pool({ paused: true }),
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
      currentEpoch: epoch({ endsAt: NOW }),
      duePendingWithdrawals: async () => pending(1),
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("begin_epoch");
    expect(outcome.withdrawShortfall).toBeUndefined();
  });

  // --- 7. Create Round.

  // game-jackpot-pause ticket 02: create_round is refused under game pause.
  // --- 7. The previous Round gets REVEAL_SECONDS (1 s) past its `endsAt`
  // before the next one opens; the reveal itself fires when the draw lands,
  // usually before `endsAt`.

  // --- 8. Release a leaf (mainnet-readiness-fixes 08): lowest priority, one
  // per tick, only for the owner `leafToRelease` names.

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
      pool: pool({ payoutTimeout: 86_400n, paused: true }),
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
      pool: pool({ payoutTimeout: 86_400n, paused: true }),
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
      paused: true,
      ...over,
    });

  const venueTick = (vault: bigint, over: Partial<TickContext> = {}) =>
    context({
      pool: venuePool(),
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
    // The OLD pins (the sync inside values the old venue), the
    // proposal, and the Admin who gets the rent back.
    for (const pinned of [old.klendProgram, old.klendMarket, old.klendReserve, old.klendCtoken, old.admin]) {
      expect(keys).toContain(pinned.toBase58());
    }
    expect(keys).toContain(venueProposalAddress(PROGRAM_ID, old.address).toBase58());
    // The sync inside only values the position, which klend does without extras.
    expect(keys).not.toContain(LMA.toBase58());
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
    const { ctx, sent } = venueTick(10_000n * U, { pool: venuePool({ venueKind: 9 }) });
    await runTick(ctx).catch(() => undefined);
    expect(sent).toHaveLength(0);
  });

  describe("a kVault pool", () => {
    const f = kvaultFixture([
      { ctokens: 10n, available: 100n },
      { ctokens: 10n, available: 900n },
    ]);
    const kvaultPool = (over: Partial<PoolState> = {}) =>
      venuePool({ venueKind: VENUE_KIND.kvault, klendMarket: f.view.vault, kvault: f.view, ...over });
    const n = f.view.allocations.length;

    it("derives the remaining accounts from the vault state it was handed, not from env", async () => {
      const { ctx, sent } = venueTick(10_000n * U, { pool: kvaultPool() });
      await runTick(ctx);
      const keys = (sent[0]?.[0]?.keys ?? []).map((key) => key.pubkey.toBase58());
      // The pins and the fixed accounts come first, then the layout of kvault.rs
      // starting at the klend program (the pinned program is that key here too).
      const rest = keys.slice(keys.lastIndexOf(KLEND_PROGRAM_ID.toBase58()));
      expect(rest[0]).toBe(KLEND_PROGRAM_ID.toBase58());
      expect(rest.slice(1, 1 + n)).toEqual(f.view.allocations.map((a) => a.reserve.toBase58()));
      expect(rest.slice(1 + n, 1 + 2 * n)).toEqual(f.view.allocations.map((a) => a.market.toBase58()));
      expect(rest[1 + 2 * n]).toBe(f.view.tokenVault.toBase58());
      // The vault state again, writable, so the pinned read-only slot can be written.
      const last = sent[0]?.[0]?.keys.at(-1);
      expect(last?.pubkey.toBase58()).toBe(f.view.vault.toBase58());
      expect(last?.isWritable).toBe(true);
    });

    it("follows a changed allocation list on the next tick", async () => {
      const g = kvaultFixture([{ ctokens: 5n, available: 7n }]);
      const { ctx, sent } = venueTick(10_000n * U, {
        pool: kvaultPool({ kvault: g.view, klendMarket: g.view.vault }),
      });
      await runTick(ctx);
      const keys = (sent[0]?.[0]?.keys ?? []).map((key) => key.pubkey.toBase58());
      expect(keys).toContain(g.view.allocations[0]!.reserve.toBase58());
      expect(keys).not.toContain(f.view.allocations[0]!.reserve.toBase58());
    });

    it("passes the accepted mint writable to a redeem and not to a deploy", async () => {
      const deploy = venueTick(10_000n * U, { pool: kvaultPool() });
      await runTick(deploy.ctx);
      const deployMint = deploy.sent[0]?.[0]?.keys.filter((k) => k.pubkey.equals(USDC) && k.isWritable);
      expect(deployMint).toHaveLength(0);
      const recall = venueTick(100n * U, { pool: kvaultPool({ venueValue: 9_900n * U }) });
      await runTick(recall.ctx);
      expect(recall.sent[0]?.[0]?.keys.filter((k) => k.pubkey.equals(USDC) && k.isWritable)).not.toHaveLength(0);
    });

    it("drains with the redeem accounts and migrates with the value-only ones", async () => {
      const drain = drainTick({ pool: kvaultPool({ venueValue: 5_000n * U }) });
      await runTick(drain.ctx);
      const dk = drain.sent[0]?.[0]?.keys ?? [];
      // Accepted mint writable (the vault's withdraw writes it), vault state writable.
      expect(dk.filter((k) => k.pubkey.equals(USDC) && k.isWritable)).not.toHaveLength(0);
      expect(dk.at(-1)?.pubkey.toBase58()).toBe(USDC.toBase58());

      const migrate = drainTick({ pool: kvaultPool({ venueValue: 40n * U }) });
      await runTick(migrate.ctx);
      const mk = (migrate.sent[0]?.[0]?.keys ?? []).map((k) => k.pubkey.toBase58());
      expect(mk).toContain(f.view.allocations[0]!.reserve.toBase58());
      expect(mk).not.toContain(f.view.tokenVault.toBase58());
    });

    it("refuses to build when the vault was not read", async () => {
      const { ctx, sent } = venueTick(10_000n * U, {
        pool: venuePool({ venueKind: VENUE_KIND.kvault, klendMarket: f.view.vault }),
      });
      await runTick(ctx).catch(() => undefined);
      expect(sent).toHaveLength(0);
    });
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

  it("recalls the whole position after shutdown, band or not (fork-run-fixes 11)", async () => {
    // Free idle 2,000 against a target of 300: no recall before shutdown.
    const pool = venuePool({ shutdown: true, venueValue: 1_000n * U });
    const { ctx, sent } = venueTick(2_000n * U, { pool });
    expect((await runTick(ctx)).action).toBe("recall");
    expect(amountSent(sent)).toBe((1_000n * U).toString());

    // Under min_venue_move too: what the sync booked last time still comes home.
    const dust = venueTick(2_000n * U, { pool: venuePool({ shutdown: true, venueValue: 3n }) });
    await runTick(dust.ctx);
    expect(amountSent(dust.sent)).toBe("3");

    const empty = venueTick(2_000n * U, { pool: venuePool({ shutdown: true, venueValue: 0n }) });
    expect((await runTick(empty.ctx)).action).toBeNull();
  });

  it("sizes the shutdown recall by the venue's free liquidity, and recalls rather than drains", async () => {
    let reads = 0;
    const { ctx, sent } = venueTick(2_000n * U, {
      pool: venuePool({ shutdown: true, venueValue: 1_000n * U }),
      venueProposal: elapsed,
      venueAvailable: async () => {
        reads += 1;
        return 400n * U;
      },
    });
    await runTick(ctx);
    expect(reads).toBe(1);
    expect(sent[0]?.map(label)).toEqual(["recall"]);
    expect(amountSent(sent)).toBe((400n * U - 1n).toString());
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
        currentEpoch: epoch_,
        principalVaultBalance: async () => 1_000n * U,
      });
      expect((await runTick(ctx)).action).not.toBe("harvest");
    }
  });

  it("wakes when the harvest window opens", async () => {
    const { ctx } = context({
      pool: harvestPool({ paused: true }),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS + 50n),
      principalVaultBalance: async () => 1_000n * U,
    });
    expect((await runTick(ctx)).nextWakeAt).toBe(NOW + 50n);
  });

  it("a failed harvest does not block the rest of the tick", async () => {
    const { ctx, sent } = context({
      pool: harvestPool(),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      duePendingWithdrawals: async () => [{ owner: Keypair.generate().publicKey.toBase58(), amount: 1n }],
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "harvest")) throw new Error("ReserveStale");
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.stepError).toBe("harvest failed: ReserveStale");
    expect(outcome.action).toBe("process_withdraw");
    expect(outcome.venueState?.failedAt.harvest).toBe(NOW);
    expect(outcome.venueState?.harvestedEpoch).toBeNull();
  });

  it("(audit 04) an unknown payout failure still lets a due venue crank through", async () => {
    const sends: string[] = [];
    const { ctx } = context({
      pool: harvestPool(),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n, drawnAt: NOW - 10n }),
      principalVaultBalance: async () => 1_000n * U,
      payoutProof: async () => proofAt(42n),
      send: async (ixs) => {
        const name = label(ixs[0]!);
        sends.push(name);
        if (name === "payout") throw new Error("InsufficientVaultLiquidity");
        return "sig";
      },
    });
    const outcome = await runTick(ctx);
    expect(sends).toEqual(["payout", "harvest"]);
    expect(outcome.action).toBe("harvest");
    expect(outcome.stepError).toBe("payout failed: InsufficientVaultLiquidity");
  });

  it("(audit 04) a failed harvest is ready again after 90 seconds; a failed deploy is not", async () => {
    const failedAt = NOW - 90n;
    const harvest = context({
      pool: harvestPool(),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      lastVenueState: { harvestedEpoch: null, failedAt: { harvest: failedAt } },
    });
    expect((await runTick(harvest.ctx)).action).toBe("harvest");

    const justFailed = context({
      pool: harvestPool(),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      lastVenueState: { harvestedEpoch: null, failedAt: { harvest: NOW - 89n } },
    });
    expect((await runTick(justFailed.ctx)).action).toBeNull();

    // 10_000 USDC idle on an empty venue: a deploy is due unless it is cooling.
    const deploy = venueTick(10_000n * U, {
      lastVenueState: { harvestedEpoch: null, failedAt: { deploy: failedAt } },
    });
    expect((await runTick(deploy.ctx)).action).toBeNull();
  });

  it("a harvest refused with HarvestBelowMinimum is a warning and a cooldown, not a step error", async () => {
    const { ctx, warned } = context({
      pool: harvestPool(),
      currentEpoch: endingIn(HARVEST_LEAD_SECONDS - 1n),
      principalVaultBalance: async () => 1_000n * U,
      send: async () => {
        throw new Error("HarvestBelowMinimum");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.stepError).toBeUndefined();
    expect(warned).toEqual(["harvest refused, retrying in a while: HarvestBelowMinimum"]);
    expect(outcome.venueState?.failedAt.harvest).toBe(NOW);
    expect(outcome.venueState?.harvestedEpoch).toBeNull();
  });

  it("NothingToHarvest counts as harvested for the epoch", async () => {
    const { ctx } = context({
      pool: harvestPool(),
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

  const pending1 = () => [{ owner: Keypair.generate().publicKey.toBase58(), amount: 1_000_000n }];

  it("5. in shutdown the drawn epoch pays, then venue recall and a due withdrawal run on later ticks", async () => {
    const owed = pending1();
    const shut = (over: Partial<TickContext>) =>
      context({
        pool: venuePool({ shutdown: true, venueValue: 1_000n * U }),
        principalVaultBalance: async () => 2_000n * U,
        duePendingWithdrawals: async () => owed,
        ...over,
      });

    const draw = shut({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW - 10n }),
      fulfilled: async () => true,
    });
    expect((await runTick(draw.ctx)).action).toBe("draw");

    const pay = shut({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n, drawnAt: NOW - 10n }),
      payoutProof: async (_, target) => proofAt(target),
    });
    expect((await runTick(pay.ctx)).action).toBe("payout");

    // Paid: the loop is over, and the tick reaches the cranks and the queue.
    const recall = shut({ previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }) });
    expect((await runTick(recall.ctx)).action).toBe("recall");

    const withdraw = shut({
      pool: venuePool({ shutdown: true, venueValue: 0n }),
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
    });
    expect((await runTick(withdraw.ctx)).action).toBe("process_withdraw");
  });

  // --- Audit-2026-10-10 03: a refused epoch-loop step never holds the cranks or the queue.

  const refusedSteps: {
    step: string;
    over: Partial<TickContext>;
    pool?: Partial<PoolState>;
  }[] = [
    {
      step: "begin_epoch",
      over: {
        currentEpoch: epoch({ endsAt: NOW - 1n }),
        previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
      },
    },
    {
      step: "request_draw",
      over: {
        previousEpoch: ended(),
        drawRequest: async () => ({ nonce: NONCE, snapshot: SNAPSHOT }),
      },
    },
    {
      step: "draw",
      over: {
        previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW - 10n }),
        fulfilled: async () => true,
      },
    },
    {
      step: "rollover_epoch",
      over: {
        previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW - 121n }),
      },
    },
    {
      step: "rollover_epoch",
      over: {
        previousEpoch: epoch({
          epochId: 1n,
          status: EPOCH_STATUS.DRAWN,
          target: 42n,
          drawnAt: NOW - 100_000n,
        }),
        snapshotMismatchEpoch: 1n,
      },
    },
  ];

  it.each(refusedSteps)(
    "$step throwing is the step error, and the same tick still cranks the venue and pays a due withdrawal",
    async ({ step, over }) => {
      const due = pending1();
      const sent: TransactionInstruction[][] = [];
      const { ctx } = context({
        // Free idle 10,000 against a target of 1,000: a deploy is due.
        pool: venuePool(),
        principalVaultBalance: async () => 10_000n * U,
        duePendingWithdrawals: async () => due,
        ...over,
        send: async (ixs) => {
          if (ixs.some((ix) => label(ix) === step)) throw new Error("VrfRequestRefused");
          sent.push(ixs);
          return "signature";
        },
      });
      const outcome = await runTick(ctx);

      // The venue crank lands first and ends the tick; the queue is paid on the next one.
      expect(outcome.action).toBe("deploy_to_venue");
      expect(outcome.stepError).toBe(`${step} failed: VrfRequestRefused`);

      const later = context({
        pool: venuePool(),
        principalVaultBalance: async () => 100n * U,
        duePendingWithdrawals: async () => due,
        ...over,
        send: async (ixs) => {
          if (ixs.some((ix) => label(ix) === step)) throw new Error("VrfRequestRefused");
          sent.push(ixs);
          return "signature";
        },
      });
      const next = await runTick(later.ctx);
      expect(next.action).toBe("process_withdraw");
      expect(next.stepError).toBe(`${step} failed: VrfRequestRefused`);
    },
  );

  it("an expected race error on a guarded step stays at debug and the tick still falls through", async () => {
    const { ctx, debugged } = context({
      pool: venuePool(),
      principalVaultBalance: async () => 10_000n * U,
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW - 10n }),
      fulfilled: async () => true,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "draw")) throw new Error("EpochNotDrawing");
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("deploy_to_venue");
    expect(outcome.stepError).toBeUndefined();
    expect(debugged).toEqual(["draw skipped: EpochNotDrawing"]);
  });
});

describe("instruction builders", () => {
  const keysOf = (ixs: readonly TransactionInstruction[]): string[] =>
    (ixs[0]?.keys ?? []).map((key) => key.pubkey.toBase58());

  it("hands rollover_epoch the request's randomness account", async () => {
    // The program matches it against the seed on the Epoch, so a builder that
    // forgets the account cannot roll over at all.
    const drawing = epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING });
    expect(keysOf(await instructions.rolloverEpoch(pool(), drawing))).toContain(
      instructions.randomnessFor(drawing.vrfSeed).toBase58(),
    );
  });

  it("pays a House leaf to the pinned House, whose address keeps the first Operator's seed (audit-2026-10-09 02)", async () => {
    // After set_operator the leaf owner is the new Operator, whose own PDA is not the House.
    const rotated = pool({ operator: Keypair.generate().publicKey });
    const leaf = { index: 0, owner: rotated.operator.toBase58(), tickets: 1n, siblings: [] };
    const keys = keysOf(await instructions.payout(rotated, 1n, leaf));
    expect(keys).toContain(rotated.house.toBase58());
    expect(keys).not.toContain(playerAddress(PROGRAM_ID, POOL, rotated.operator).toBase58());
  });
});

describe("randomness", () => {
  it("uses this program's PDA under test-vrf and ORAO's otherwise", () => {
    const seed = new Uint8Array(32).fill(1);
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
