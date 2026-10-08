// Ticket 01 (reveal-timing): the operator writes `lastTickAt` from the clock
// at the moment `writeState` runs, after the tick's transaction has
// confirmed, not from the clock at the tick's start. Otherwise a slow devnet
// confirmation reads as a stall (spec.md "Operator" and status.ts's 10 s
// freshness window). Against a real Postgres, since that upsert is the thing
// under test; the chain is fake, with `send` the only seam that matters here.
const TEST_DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { epochAddress, poolAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { EPOCH_STATUS } from "./chain-state";
import { OperatorService } from "./operator.service";
import { ensurePoolRow } from "./pool-row.fixture";
import { msUntilWake, SAFETY_INTERVAL_SECONDS } from "./tick";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const POOL_ADDRESS = POOL.toBase58();
/** A pool a cutover left behind (ADR 0016): same program, older id. */
const RETIRED_POOL_ADDRESS = poolAddress(PROGRAM_ID, 99n).toBase58();

// No RPC is reached: `beginEpoch`'s `.instruction()` only encodes calldata.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);

const bn = (value: bigint | number): BN => new BN(value.toString());

/** Every test here fabricates its own chain and DB reads, so the config
 *  service only needs to answer the one key `OperatorService` asks it for. */
const fakeConfig = {
  get: () => 60,
} as unknown as ConfigService<HexVaultEnv, true>;

const pool = (overrides: object = {}) => ({
  poolId: bn(1),
  admin: Keypair.generate().publicKey,
  operator: Keypair.generate().publicKey,
  acceptedMint: Keypair.generate().publicKey,
  principalVault: Keypair.generate().publicKey,
  jackpotVault: Keypair.generate().publicKey,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  // No epoch yet: the tick's only possible move is step 3, `begin_epoch`, so
  // `send` fires without any Epoch fixture.
  currentEpochId: bn(0),
  currentEpochStart: bn(0),
  currentEpochEndsAt: bn(0),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  totalPrincipal: bn(0),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  version: 1,
  shutdown: false,
  ...overrides,
});

describe.skipIf(!DB_AVAILABLE)("OperatorService end-of-tick timestamp", () => {
  it("records lastTickAt at or after the instant a slow send resolves", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });

    const accounts = new Map<string, Buffer>();
    accounts.set(
      POOL.toBase58(),
      await program.coder.accounts.encode("pool", pool()),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const START_MS = 1_800_000_000_000;
    let clockMs = START_MS;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => clockMs);

    // Stands in for a slow devnet confirmation: the wall clock advances 15 s,
    // past the 10 s freshness window (status.ts), before `send` resolves.
    let sendResolvedAtMs = 0;
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: new CountingConnection(accounts),
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      recordChainTime: () => {},
      send: async (
        _instructions: TransactionInstruction[],
      ): Promise<string> => {
        clockMs += 15_000;
        sendResolvedAtMs = clockMs;
        return "fake-signature";
      },
    };

    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      fakeConfig,
    );

    try {
      const outcome = await operator.runOnce();
      expect(outcome.action).toBe("begin_epoch");
      // Acted this tick, so the deadline (a chain timestamp) collapses to
      // "now": zero wall-clock ms to wait before looking again.
      expect(outcome.waitMs).toBe(0);

      const state = await prisma.operatorState.findUniqueOrThrow({
        where: { poolAddress: POOL_ADDRESS },
      });
      expect(Number(state.lastTickAt)).toBeGreaterThanOrEqual(
        Math.floor(sendResolvedAtMs / 1000),
      );
      // The pre-fix behaviour recorded the tick's start time, 15 s earlier.
      expect(Number(state.lastTickAt)).toBeGreaterThan(
        Math.floor(START_MS / 1000),
      );
      // nextWakeAt is written from the same wall clock as lastTickAt, waitMs
      // (here 0) past it (ticket 03).
      expect(state.nextWakeAt).toEqual(state.lastTickAt);
    } finally {
      dateNowSpy.mockRestore();
      await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.$disconnect();
    }
  });
});

// Ticket 10: a database blip during a failing tick must not itself crash the
// process. No DB needed here — both the RPC read and the state write are
// fakes, so this covers the catch-path write in isolation.
describe("OperatorService catch-path state write", () => {
  it("does not reject when recording the tick's own error also fails", async () => {
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: {
        getMultipleAccountsInfo: async () => {
          throw new Error("boom: rpc down");
        },
      },
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      recordChainTime: () => {},
    };
    const failingPrisma = {
      operatorState: {
        upsert: async () => {
          throw new Error("db blip");
        },
      },
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      failingPrisma as unknown as PrismaService,
      fakeConfig,
    );

    const outcome = await operator.runOnce();
    expect(outcome.action).toBeNull();
  });
});

// Ticket 10: Nest only calls onModuleDestroy when enableShutdownHooks() is
// on (main.ts); this covers that it actually waits for the tick in flight
// rather than tearing down underneath it.
describe("OperatorService.onModuleDestroy", () => {
  it("awaits the in-flight tick before resolving", async () => {
    let releaseTick: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: {
        getMultipleAccountsInfo: async () => {
          await gate;
          throw new Error("boom: rpc down");
        },
        removeAccountChangeListener: async () => {},
      },
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      recordChainTime: () => {},
    };
    const prisma = { operatorState: { upsert: async () => {} } };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma as unknown as PrismaService,
      fakeConfig,
    );

    const tickPromise = operator.tick();
    let destroyed = false;
    const destroyPromise = operator.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toBe(false);

    releaseTick();
    await tickPromise;
    await destroyPromise;
    expect(destroyed).toBe(true);
  });
});

// Step 6b's queue comes straight out of Postgres, so the predicate is the
// query, not any JS the tick runs afterwards: a wrong `lt`/`lte` here either
// pays a withdrawal a whole epoch early or never pays it at all.
describe.skipIf(!DB_AVAILABLE)("OperatorService.duePendingWithdrawals", () => {
  const owner = (): string => Keypair.generate().publicKey.toBase58();
  const LIVE = { now: 1_000n, epochSeconds: 86_400n, shutdown: false };

  const player = (over: {
    owner: string;
    pendingWithdraw: bigint;
    pendingEpoch: bigint;
    requestedAt?: bigint;
  }) => ({
    poolAddress: POOL_ADDRESS,
    principal: 0n,
    tickets: 0n,
    epochId: 0n,
    isHouse: false,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    ...over,
  });

  const makeOperator = (prisma: PrismaService) =>
    new OperatorService(
      {
        program,
        programId: PROGRAM_ID,
        keypair: Keypair.generate(),
        connection: new CountingConnection(new Map()),
        poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      } as unknown as ChainService,
      prisma,
      fakeConfig,
    );

  it("returns only the requests the pool has moved past, oldest first", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();

    const oldest = owner();
    const newer = owner();
    const thisEpoch = owner();
    const zeroAmount = owner();
    const retired = owner();
    const owners = [oldest, newer, thisEpoch, zeroAmount, retired];
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await ensurePoolRow(prisma, RETIRED_POOL_ADDRESS, 99n);
    await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    await prisma.player.createMany({
      data: [
        // Owed and past its epoch, but in a retired pool (ADR 0016): the
        // Active pool's vault must never pay it.
        {
          ...player({ owner: retired, pendingWithdraw: 3_000_000n, pendingEpoch: 1n }),
          poolAddress: RETIRED_POOL_ADDRESS,
        },
        // Out of order on purpose: the ordering has to come from the query.
        player({ owner: newer, pendingWithdraw: 2_000_000n, pendingEpoch: 4n }),
        player({ owner: oldest, pendingWithdraw: 1_000_000n, pendingEpoch: 2n }),
        // Requested in the epoch that is still running: locked until it ends.
        player({ owner: thisEpoch, pendingWithdraw: 9_000_000n, pendingEpoch: 5n }),
        // Already paid, so the row survives with nothing owed on it.
        player({ owner: zeroAmount, pendingWithdraw: 0n, pendingEpoch: 1n }),
      ],
    });

    const operator = makeOperator(prisma);

    try {
      // Private: the seam this test needs is the query, and reaching it
      // through a whole fabricated tick would assert the batching instead.
      const due = await operator["duePendingWithdrawals"](5n, LIVE);
      expect(due.filter((entry) => owners.includes(entry.owner))).toEqual([
        { owner: oldest, amount: 1_000_000n },
        { owner: newer, amount: 2_000_000n },
      ]);
    } finally {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
      await prisma.$disconnect();
    }
  });

  // mainnet-readiness-fixes 03: the program also pays past the deadline and
  // once shut down, which the epoch test alone never selects.
  it("also returns requests past requestedAt + epochSeconds, and every request once shut down", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const stale = owner();
    const fresh = owner();
    const owners = [stale, fresh];
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    // Both requested in the running epoch 5; only `stale` is past the deadline.
    await prisma.player.createMany({
      data: [
        player({ owner: stale, pendingWithdraw: 1_000_000n, pendingEpoch: 5n, requestedAt: 100n }),
        player({ owner: fresh, pendingWithdraw: 2_000_000n, pendingEpoch: 5n, requestedAt: 900n }),
      ],
    });
    const operator = makeOperator(prisma);
    try {
      const mine = (due: { owner: string }[]) => due.filter((entry) => owners.includes(entry.owner));
      // 100 + 500 < 1_000, but 900 + 500 is not.
      const frozen = { now: 1_000n, epochSeconds: 500n, shutdown: false };
      expect(mine(await operator["duePendingWithdrawals"](5n, frozen)).map((entry) => entry.owner)).toEqual([stale]);
      const shutdown = { ...frozen, shutdown: true };
      expect(mine(await operator["duePendingWithdrawals"](5n, shutdown)).map((entry) => entry.owner)).toEqual([
        stale,
        fresh,
      ]);
    } finally {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
      await prisma.$disconnect();
    }
  });
});

describe.skipIf(!DB_AVAILABLE)("OperatorService read budget", () => {
  it("costs two account reads per tick and sleeps the safety interval when there is nothing to do", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });

    const CHAIN_NOW = 1_800_000_000n;
    // An Epoch running well past the safety interval: the crank has nothing to
    // do for a long time, which is the state it spends most of an epoch in.
    const idlePool = pool({
      paused: true,
      currentEpochId: bn(1),
      currentEpochStart: bn(CHAIN_NOW - 100n),
      currentEpochEndsAt: bn(CHAIN_NOW + 86_300n),
    });
    const accounts = new Map<string, Buffer>();
    accounts.set(
      POOL.toBase58(),
      await program.coder.accounts.encode("pool", idlePool),
    );
    accounts.set(
      epochAddress(PROGRAM_ID, POOL, 1n).toBase58(),
      await program.coder.accounts.encode("epoch", {
        epochId: bn(1),
        startsAt: bn(CHAIN_NOW - 100n),
        endsAt: bn(CHAIN_NOW + 86_300n),
        // Ended, not Open: the Epoch's own status is not what this test is
        // measuring.
        status: EPOCH_STATUS.ENDED,
        jackpotAmount: bn(0),
        vrfSeed: Array(32).fill(0),
        requestedAt: bn(0),
        target: bn(0),
        winner: PublicKey.default,
        bump: 255,
      }),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(CHAIN_NOW, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const connection = new CountingConnection(accounts);
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection,
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      epochAddress: (id: bigint) => epochAddress(PROGRAM_ID, POOL, id),
      recordChainTime: () => {},
      send: async () => {
        throw new Error("an idle tick must not send anything");
      },
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      fakeConfig,
    );

    try {
      for (let i = 0; i < 3; i++) {
        const outcome = await operator.runOnce();
        expect(outcome.action).toBeNull();
        // runOnce swallows a failed tick into a null action, so without this
        // a broken fixture would look like a quiet crank.
        const state = await prisma.operatorState.findUniqueOrThrow({
          where: { poolAddress: POOL_ADDRESS },
        });
        expect(state.lastError).toBeNull();
        expect(outcome.nextWakeAt).toBe(CHAIN_NOW + SAFETY_INTERVAL_SECONDS);
        // The whole point of the ticket: an idle crank waits a minute, not a
        // second. At one tick per second this line reads 1_000.
        expect(outcome.waitMs).toBe(msUntilWake(CHAIN_NOW, outcome.nextWakeAt));
        expect(outcome.waitMs).toBe(Number(SAFETY_INTERVAL_SECONDS) * 1000);
      }

      // Two batched reads per tick, the Pool with the clock and then the
      // cycle, and nothing else. A reintroduced poll shows up here.
      expect(connection.callCounts()).toEqual({ getMultipleAccountsInfo: 6 });
    } finally {
      await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.$disconnect();
    }
  });
});

// Production-hardening ticket 03: every chain read now has a timeout, which
// the operator's tick had none of before this ticket. A timed-out read is
// just another failed tick to `runOnce` (it already wraps every read in
// try/catch and writes `lastError`), so this proves that generic recovery
// against the specific new failure mode instead of assuming it still holds.
describe.skipIf(!DB_AVAILABLE)("OperatorService RPC failure recovery", () => {
  it("records lastError from a timed-out read, and recovers on the next tick", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });

    const accounts = new Map<string, Buffer>();
    accounts.set(POOL.toBase58(), await program.coder.accounts.encode("pool", pool()));
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const connection = new CountingConnection(accounts);
    const realRead = connection.getMultipleAccountsInfo.bind(connection);
    // Stands in for `ChainService`'s resilient connection (ticket 03) timing
    // a hung read out: the very first read the tick makes rejects, once,
    // exactly what a real timeout now surfaces as.
    let failNextRead = true;
    connection.getMultipleAccountsInfo = (keys) => {
      if (!failNextRead) return realRead(keys);
      failNextRead = false;
      return Promise.reject(new Error("RPC getMultipleAccountsInfo timed out after 10000ms"));
    };

    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection,
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      recordChainTime: () => {},
      send: async () => "signature",
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      fakeConfig,
    );

    try {
      await operator.runOnce();
      const afterFailure = await prisma.operatorState.findUniqueOrThrow({
        where: { poolAddress: POOL_ADDRESS },
      });
      expect(afterFailure.lastError).toMatch(/timed out/);
      // Ticket 09: a failing tick never stamps lastSuccessAt.
      expect(afterFailure.lastSuccessAt).toBeNull();

      // The single-flight guard resets in `runOnce`'s `finally`, so the next
      // call is never skipped by the failed one still "running".
      await operator.runOnce();
      const afterRecovery = await prisma.operatorState.findUniqueOrThrow({
        where: { poolAddress: POOL_ADDRESS },
      });
      expect(afterRecovery.lastError).toBeNull();
      // Ticket 09: the recovering tick stamps it.
      expect(afterRecovery.lastSuccessAt).not.toBeNull();
    } finally {
      await prisma.operatorState.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.$disconnect();
    }
  });
});

// Pool cutover (ADR 0016, ticket 02): after POOL_ID moves to a new pool, the
// database still holds the retired pool's OperatorState and Cursor. The
// operator must read and write only the Active pool's rows, or it would
// report the retired pool's last tick as its own.
describe.skipIf(!DB_AVAILABLE)("OperatorService on a freshly cut-over pool", () => {
  const ACTIVE = poolAddress(PROGRAM_ID, 42n);
  const ACTIVE_ADDRESS = ACTIVE.toBase58();
  const both = { poolAddress: { in: [ACTIVE_ADDRESS, RETIRED_POOL_ADDRESS] } };

  it("reads no cursor and no last tick for the new pool, then writes its own OperatorState row", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await ensurePoolRow(prisma, RETIRED_POOL_ADDRESS, 99n);
    await ensurePoolRow(prisma, ACTIVE_ADDRESS, 42n);
    await prisma.operatorState.deleteMany({ where: both });
    await prisma.cursor.deleteMany({ where: both });

    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    await prisma.operatorState.create({
      data: { poolAddress: RETIRED_POOL_ADDRESS, lastTickAt: 1n, lastAction: "retired" },
    });

    // No Epoch yet, so the first tick has a move: begin_epoch.
    const CHAIN_NOW = nowSeconds;
    const accounts = new Map<string, Buffer>();
    accounts.set(
      ACTIVE_ADDRESS,
      await program.coder.accounts.encode("pool", pool({ poolId: bn(42) })),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(CHAIN_NOW, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const sent: TransactionInstruction[][] = [];
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: new CountingConnection(accounts),
      poolAddress: () => ACTIVE,
      venueProposalAddress: () => PublicKey.default,
      epochAddress: (id: bigint) => epochAddress(PROGRAM_ID, ACTIVE, id),
      recordChainTime: () => {},
      send: async (instructions: TransactionInstruction[]) => {
        sent.push(instructions);
        return "signature";
      },
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      fakeConfig,
    );
    const activeState = () =>
      prisma.operatorState.findUnique({ where: { poolAddress: ACTIVE_ADDRESS } });

    try {
      // No row yet: /status reads null last tick for the new pool.
      expect(await activeState()).toBeNull();

      // The first tick sends begin_epoch and creates the Active pool's row
      // beside the retired one instead of overwriting it.
      const first = await operator.runOnce();
      expect(first.action).toBe("begin_epoch");
      expect(sent).toHaveLength(1);
      const row = await activeState();
      expect(row?.lastTickAt).not.toBeNull();
      expect(row?.lastError).toBeNull();
      expect(row?.lastAction).toBe("begin_epoch");
      const retired = await prisma.operatorState.findUniqueOrThrow({
        where: { poolAddress: RETIRED_POOL_ADDRESS },
      });
      expect(retired.lastTickAt).toBe(1n);
      expect(retired.lastAction).toBe("retired");
    } finally {
      await prisma.operatorState.deleteMany({ where: both });
      await prisma.cursor.deleteMany({ where: both });
      await prisma.$disconnect();
    }
  });

  it("skips the state write, without failing the tick, before the indexer mirrors the Pool row", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    // A pool id no test ever gives a Pool row, so the foreign key cannot hold.
    const UNMIRRORED = poolAddress(PROGRAM_ID, 4_242n);
    const accounts = new Map<string, Buffer>();
    accounts.set(
      UNMIRRORED.toBase58(),
      await program.coder.accounts.encode("pool", pool({ poolId: bn(4_242) })),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);
    const operator = new OperatorService(
      {
        program,
        programId: PROGRAM_ID,
        keypair: Keypair.generate(),
        connection: new CountingConnection(accounts),
        poolAddress: () => UNMIRRORED,
        venueProposalAddress: () => PublicKey.default,
        recordChainTime: () => {},
        send: async () => "signature",
      } as unknown as ChainService,
      prisma,
      fakeConfig,
    );

    try {
      // The success path's write used to throw here, turning a sent
      // begin_epoch into a "tick failed" with a foreign-key error.
      const outcome = await operator.runOnce();
      expect(outcome.action).toBe("begin_epoch");
      expect(
        await prisma.operatorState.findUnique({ where: { poolAddress: UNMIRRORED.toBase58() } }),
      ).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });
});

// Off-chain-tickets ticket 10: until the Epoch snapshot exists (ticket 12) the
// draw steps send nothing and say why, once per step and epoch. No database:
// the state write is a fake.
describe("OperatorService snapshot_pending", () => {
  it("reports request_draw as waiting on the snapshot without sending, and logs it once", async () => {
    const CHAIN_NOW = 1_800_000_000n;
    const epoch = (epochId: bigint, status: number, endsAt: bigint) => ({
      epochId: bn(epochId),
      startsAt: bn(endsAt - 86_400n),
      endsAt: bn(endsAt),
      status,
      jackpotAmount: bn(0),
      vrfSeed: Array(32).fill(0),
      requestedAt: bn(0),
      target: bn(0),
      winner: PublicKey.default,
      drawnAt: bn(0),
      registrationOpenedAt: bn(0),
      bump: 255,
    });
    const accounts = new Map<string, Buffer>();
    accounts.set(POOL.toBase58(), await program.coder.accounts.encode("pool", pool({ currentEpochId: bn(2) })));
    accounts.set(
      epochAddress(PROGRAM_ID, POOL, 1n).toBase58(),
      await program.coder.accounts.encode("epoch", epoch(1n, EPOCH_STATUS.ENDED, CHAIN_NOW - 1_000n)),
    );
    accounts.set(
      epochAddress(PROGRAM_ID, POOL, 2n).toBase58(),
      await program.coder.accounts.encode("epoch", epoch(2n, EPOCH_STATUS.OPEN, CHAIN_NOW + 85_400n)),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(CHAIN_NOW, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const sent: TransactionInstruction[][] = [];
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: new CountingConnection(accounts),
      poolAddress: () => POOL,
      venueProposalAddress: () => PublicKey.default,
      epochAddress: (id: bigint) => epochAddress(PROGRAM_ID, POOL, id),
      recordChainTime: () => {},
      send: async (instructions: TransactionInstruction[]) => {
        sent.push(instructions);
        return "signature";
      },
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      {
        operatorState: { upsert: async () => {} },
        player: { findMany: async () => [] },
      } as unknown as PrismaService,
      fakeConfig,
    );
    const log = vi.spyOn(operator["logger"], "log").mockImplementation(() => {});

    const first = await operator.runOnce();
    const second = await operator.runOnce();

    expect(first.action).toBeNull();
    expect(first.snapshotPending).toEqual({ step: "request_draw", epochId: 1n });
    expect(second.snapshotPending).toEqual({ step: "request_draw", epochId: 1n });
    expect(sent).toEqual([]);
    expect(log.mock.calls.filter(([line]) => String(line).includes("snapshot_pending"))).toHaveLength(1);
  });
});
