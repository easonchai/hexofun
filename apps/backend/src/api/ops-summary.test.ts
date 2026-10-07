// Own database so a parallel run of api.test.ts, which truncates hexvault_api,
// cannot wipe these rows.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_ops";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import type { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  type AccountInfo,
} from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { EPOCH_STATUS, ROUND_STATUS } from "../operator/chain-state";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { ApiService } from "./api.service";
import { findStuck, OpsSummaryService } from "./ops-summary";

const NOW = 1_800_000_000n;
const VRF_TIMEOUT = 180n;
const PAYOUT_TIMEOUT = 3_600n;

const poolTimes = { vrfTimeout: VRF_TIMEOUT, payoutTimeout: PAYOUT_TIMEOUT, jackpotPaused: false };
const round = (over: Partial<Parameters<typeof findStuck>[0]["openRound"] & object>) => ({
  roundId: 5n,
  endsAt: NOW - 10n,
  status: ROUND_STATUS.OPEN,
  vrfSeed: new Uint8Array(32),
  requestedAt: 0n,
  ...over,
});
const epoch = (over: Partial<Parameters<typeof findStuck>[0]["previousEpoch"] & object>) => ({
  epochId: 6n,
  startsAt: 0n,
  endsAt: NOW - 1_000n,
  status: EPOCH_STATUS.ENDED,
  jackpotAmount: 0n,
  vrfSeed: new Uint8Array(32),
  requestedAt: 0n,
  target: 0n,
  drawnAt: 0n,
  endedAt: NOW - 1_000n,
  ...over,
});
const unfulfilled = async (): Promise<boolean> => false;
const fulfilled = async (): Promise<boolean> => true;

describe("findStuck", () => {
  const stuck = (over: Partial<Parameters<typeof findStuck>[0]>) =>
    findStuck({
      now: NOW,
      pool: poolTimes,
      openRound: null,
      previousEpoch: null,
      fulfilled: unfulfilled,
      ...over,
    });

  it("names nothing when there is no Round or epoch", async () => {
    expect(await stuck({})).toEqual({ round: null, epoch: null });
  });

  it("names an Open Round once it is past its end plus vrf_timeout", async () => {
    expect((await stuck({ openRound: round({ endsAt: NOW - VRF_TIMEOUT - 1n }) })).round).toEqual({
      id: 5n,
      status: ROUND_STATUS.OPEN,
    });
    expect((await stuck({ openRound: round({ endsAt: NOW - VRF_TIMEOUT }) })).round).toBeNull();
  });

  it("names a Requested Round past vrf_timeout, but not a fulfilled one", async () => {
    const requested = round({ status: ROUND_STATUS.REQUESTED, requestedAt: NOW - VRF_TIMEOUT - 1n });
    expect((await stuck({ openRound: requested })).round).toEqual({
      id: 5n,
      status: ROUND_STATUS.REQUESTED,
    });
    expect((await stuck({ openRound: requested, fulfilled })).round).toBeNull();
    const fresh = round({ status: ROUND_STATUS.REQUESTED, requestedAt: NOW - 5n });
    expect((await stuck({ openRound: fresh })).round).toBeNull();
  });

  it("names an Ended epoch past vrf_timeout, unless the jackpot is paused", async () => {
    const ended = epoch({ endedAt: NOW - VRF_TIMEOUT - 1n, endsAt: 0n });
    expect((await stuck({ previousEpoch: ended })).epoch).toEqual({
      id: 6n,
      status: EPOCH_STATUS.ENDED,
    });
    expect(
      (await stuck({ previousEpoch: ended, pool: { ...poolTimes, jackpotPaused: true } })).epoch,
    ).toBeNull();
  });

  it("measures an Ended epoch from the later of its end and when it was opened", async () => {
    const ended = epoch({ endedAt: 0n, endsAt: NOW - 5n });
    expect((await stuck({ previousEpoch: ended })).epoch).toBeNull();
  });

  it("names a Drawing epoch past vrf_timeout only while its randomness is unfulfilled", async () => {
    const drawing = epoch({ status: EPOCH_STATUS.DRAWING, requestedAt: NOW - VRF_TIMEOUT - 1n });
    expect((await stuck({ previousEpoch: drawing })).epoch?.status).toBe(EPOCH_STATUS.DRAWING);
    expect((await stuck({ previousEpoch: drawing, fulfilled })).epoch).toBeNull();
  });

  it("names a Drawn epoch past payout_timeout", async () => {
    const drawn = epoch({ status: EPOCH_STATUS.DRAWN, drawnAt: NOW - PAYOUT_TIMEOUT - 1n });
    expect((await stuck({ previousEpoch: drawn })).epoch?.status).toBe(EPOCH_STATUS.DRAWN);
    const recent = epoch({ status: EPOCH_STATUS.DRAWN, drawnAt: NOW - 60n });
    expect((await stuck({ previousEpoch: recent })).epoch).toBeNull();
  });

  it("ignores a Paid or RolledOver epoch", async () => {
    expect((await stuck({ previousEpoch: epoch({ status: EPOCH_STATUS.PAID }) })).epoch).toBeNull();
  });
});

const POOL = Keypair.generate().publicKey;
const RETIRED = Keypair.generate().publicKey;
const PRINCIPAL_VAULT = Keypair.generate().publicKey;
const RESERVE = Keypair.generate().publicKey;
const ADMIN = Keypair.generate().publicKey.toBase58();
const VAULT_BALANCE = 9_000_000n;
const E18 = 10n ** 18n;

const accountInfo = (data: Buffer, owner: PublicKey = SystemProgram.programId): AccountInfo<Buffer> => ({
  data,
  owner,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});

function tokenAccount(amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: PublicKey.default,
      owner: PublicKey.default,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

/** A klend reserve at klend's offsets: 500k free of 5M (90% used), curve 0% at
 *  0, 5.51% at 95%; klend keeps 10%. */
function reserveData(): Buffer {
  const data = Buffer.alloc(8_624);
  data.writeBigUInt64LE(500_000_000_000n, 224);
  const borrowedSf = 4_500_000_000_000n << 60n;
  data.writeBigUInt64LE(borrowedSf & 0xffff_ffff_ffff_ffffn, 232);
  data.writeBigUInt64LE(borrowedSf >> 64n, 240);
  data.writeUInt8(10, 4_870);
  const curve = [[0, 0], [9_500, 551], ...Array.from({ length: 9 }, () => [10_000, 3_634])];
  curve.forEach(([util, rate], i) => {
    data.writeUInt32LE(util as number, 4_920 + i * 8);
    data.writeUInt32LE(rate as number, 4_924 + i * 8);
  });
  return data;
}

/** On-chain accounts the fake RPC serves, by address. A program account is its
 *  decoded fields as JSON: the fake coder just parses it back. */
const chainAccounts = new Map<string, AccountInfo<Buffer>>();
const program = (fields: Record<string, unknown>): AccountInfo<Buffer> =>
  accountInfo(Buffer.from(JSON.stringify(fields)));

const address = (seed: string, id: bigint) => new PublicKey(Buffer.alloc(32, `${seed}${id}`));
const fakeChain = {
  connection: {
    rpcEndpoint: "http://127.0.0.1:8899",
    getSlot: async () => 1,
    getAccountInfo: async (key: PublicKey) => chainAccounts.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((key) => {
        if (key.equals(PRINCIPAL_VAULT)) return tokenAccount(VAULT_BALANCE);
        if (key.equals(RESERVE)) return accountInfo(reserveData());
        return chainAccounts.get(key.toBase58()) ?? null;
      }),
    getTokenAccountBalance: async () => ({ value: { amount: "0" } }),
  },
  program: {
    idl: { instructions: [] },
    coder: {
      accounts: {
        decode: (name: string, data: Buffer) => {
          const fields = JSON.parse(data.toString());
          // The venue rules read the pinned program as a key; an unpinned pool is the default key.
          return name === "pool" ? { ...fields, klendProgram: PublicKey.default } : fields;
        },
      },
    },
  },
  programId: Keypair.generate().publicKey,
  keypair: Keypair.generate(),
  poolAddress: () => POOL,
  epochAddress: (id: bigint) => address("e", id),
  roundAddress: (id: bigint) => address("r", id),
  jackpotVaultAddress: () => Keypair.generate().publicKey,
  principalVaultAddress: () => PRINCIPAL_VAULT,
};

const config = { get: () => undefined } as unknown as ConfigService<HexVaultEnv, true>;

const harvested = (slot: bigint, poolAddress: string, feePaid: string, prizePaid: string, name = "Harvested") => ({
  slot,
  signature: `sig${slot}`,
  index: 0,
  poolAddress,
  name,
  data: { pool: poolAddress, feePaid, prizePaid, gain: "1", fee: "1" },
  blockTime: 1n,
});

const poolRow = (address: string) => ({
  ...LIVE_POOL_DEFAULTS,
  address,
  poolId: 1n,
  admin: ADMIN,
  operator: address,
  mint: address,
  epochSeconds: 86_400n,
  epochAnchor: 0n,
  roundSeconds: 60n,
  closeBuffer: 5n,
  minDeposit: 0n,
  paused: false,
  currentEpochId: 7n,
  currentEpochEndsAt: 0n,
  previousEpochEndsAt: 0n,
  totalPrincipal: 20_000_000n,
  pendingWithdrawals: 3_000_000n,
  minJackpot: 0n,
  houseCutBps: 0,
  baseRateBps: 488,
  ticketsPerUsdc: 1,
  bonusCapBps: 0,
  bonusEpoch: 0n,
  bonusGranted: 0n,
  version: 1,
  shutdown: false,
  updatedSlot: 1n,
});

describe.skipIf(!isDatabaseReachableSync(TEST_DATABASE_URL))("OpsSummaryService", () => {
  let prisma: PrismaService;
  let ops: OpsSummaryService;

  beforeAll(() => {
    prisma = new PrismaService({ datasourceUrl: TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Pool", "Epoch", "Round", "Player", "Position", "Event", "Cursor", "OperatorState", "YieldIndexPoint", "WeightTreeState" CASCADE',
    );
    chainAccounts.clear();
    // New services per test: the balance read is cached for 15 s.
    const api = new ApiService(prisma, fakeChain as unknown as ChainService, config);
    ops = new OpsSummaryService(prisma, api, fakeChain as unknown as ChainService, config);
  });

  const seedActive = async () => {
    await prisma.pool.create({
      data: {
        ...poolRow(POOL.toBase58()),
        klendReserve: RESERVE.toBase58(),
        venueValue: 11_000_000n,
        feeOwed: 5n,
        prizeOwed: 6n,
        yieldOwed: 7n,
        deficit: 8n,
        lastSyncAt: NOW - 60n,
        yieldIndex: new Prisma.Decimal(E18.toString()),
        yieldFeeBps: 1_000,
        idleFloorBps: 500,
        idleTargetBps: 1_000,
        reserveShareCapBps: 2_000,
        reserveLiquidityFloorBps: 3_000,
        minVenueMove: 1_000_000n,
        lossToleranceBps: 50,
      },
    });
  };

  it("sums the Harvested events of this pool into the lifetime totals", async () => {
    await seedActive();
    await prisma.pool.create({ data: poolRow(RETIRED.toBase58()) });
    await prisma.event.createMany({
      data: [
        harvested(1n, POOL.toBase58(), "100", "4000"),
        harvested(2n, POOL.toBase58(), "23", "9007199254740993"),
        harvested(3n, POOL.toBase58(), "999", "999", "Synced"),
        harvested(4n, RETIRED.toBase58(), "555", "555"),
      ],
    });

    const summary = await ops.getOpsSummary();

    expect(summary.harvestedToTreasury).toBe(123n);
    expect(summary.harvestedToJackpot).toBe(9007199254744993n);
    expect(summary.totalPrincipal).toBe(20_000_000n);
    expect(summary.venueValue).toBe(11_000_000n);
    expect([summary.feeOwed, summary.prizeOwed, summary.yieldOwed, summary.deficit]).toEqual([
      5n, 6n, 7n, 8n,
    ]);
    expect(summary.lastSyncAt).toBe(NOW - 60n);
    expect(summary.admin).toBe(ADMIN);
    // `poolRow` gives the pool its own address as the operator.
    expect(summary.operatorKey).toBe(POOL.toBase58());
    expect(summary.venueParams).toEqual({
      yieldFeeBps: 1_000,
      idleFloorBps: 500,
      idleTargetBps: 1_000,
      reserveShareCapBps: 2_000,
      reserveLiquidityFloorBps: 3_000,
      minVenueMove: 1_000_000n,
      lossToleranceBps: 50,
    });
    expect(summary.supplyRateBps).toBeGreaterThan(0);
    // The /status payload rides along.
    expect(summary.pendingWithdrawals).toBe(3_000_000n);
    expect(summary.vaultLiquidity).toBe(VAULT_BALANCE);
    expect(summary).toHaveProperty("solvencyMargin");
    expect(summary).toHaveProperty("rpcOk");
  });

  it("reports the open venue proposal with its unlock time, and null when none is open", async () => {
    await seedActive();
    const none = await ops.getOpsSummary();
    expect(none.venueProposal).toBeNull();
    expect(none.venueKind).toBe(0);

    const target = Keypair.generate().publicKey.toBase58();
    await prisma.venueProposal.create({
      data: {
        poolAddress: POOL.toBase58(),
        venueKind: 2,
        klendProgram: target,
        klendMarket: target,
        klendReserve: target,
        klendCtoken: target,
        proposedAt: NOW,
        updatedSlot: 1n,
      },
    });
    const open = await ops.getOpsSummary();
    expect(open.venueProposal).toEqual({
      venueKind: 2,
      klendProgram: target,
      klendMarket: target,
      klendReserve: target,
      klendCtoken: target,
      proposedAt: NOW,
      unlocksAt: NOW + 172_800n,
    });
  });

  it("lists the open deficit, the unpaid withdrawals and the Fast pause wallets", async () => {
    await seedActive();
    const wallet = Keypair.generate().publicKey.toBase58();
    const player = {
      poolAddress: POOL.toBase58(), principal: 0n, entries: 0n, epochId: 0n, isHouse: false,
      pendingWithdraw: 0n, pendingEpoch: 0n, boughtEpoch: 0n, boughtAmount: 0n, bonusEpoch: 0n, bonusGranted: 0n,
    };
    await prisma.player.createMany({
      data: [
        // The pool is in epoch 7: a request made in 6 is due, one made in 7 is not.
        { ...player, owner: "alice", pendingWithdraw: 4n, pendingEpoch: 6n },
        { ...player, owner: "bob", pendingWithdraw: 5n, pendingEpoch: 7n },
        { ...player, owner: "carol" },
      ],
    });
    const configured = {
      get: (name: string) => (name === "OPS_WALLETS" ? [wallet] : undefined),
    } as unknown as ConfigService<HexVaultEnv, true>;
    const api = new ApiService(prisma, fakeChain as unknown as ChainService, configured);
    const summary = await new OpsSummaryService(prisma, api, fakeChain as unknown as ChainService, configured).getOpsSummary();

    expect(summary.fastPauseWallets).toEqual([wallet]);
    expect(summary.todo).toEqual([
      expect.objectContaining({ code: "DEFICIT_OPEN", due: "now", amount: 8n }),
      expect.objectContaining({ code: "WITHDRAWS_DUE", due: "bot", amount: 4n, owner: "alice" }),
    ]);
  });

  it("returns zero totals for a pool that has never harvested", async () => {
    await seedActive();
    const summary = await ops.getOpsSummary();
    expect(summary.harvestedToTreasury).toBe(0n);
    expect(summary.harvestedToJackpot).toBe(0n);
    expect(summary.stuck).toEqual({ round: null, epoch: null });
  });

  it("names the Round and epoch the chain says are stuck", async () => {
    await seedActive();
    chainAccounts.set(
      POOL.toBase58(),
      program({
        ...Object.fromEntries(
          [
            "epochSeconds", "roundSeconds", "closeBuffer", "pendingWithdrawals", "venueValue",
            "feeOwed", "prizeOwed", "idleFloorBps", "idleTargetBps", "minVenueMove",
            "nextRoundId", "totalPrincipal",
          ].map((k) => [k, "0"]),
        ),
        vrfTimeout: String(VRF_TIMEOUT),
        payoutTimeout: String(PAYOUT_TIMEOUT),
        currentEpochId: "7",
        openRoundId: "5",
        jackpotPaused: false,
      }),
    );
    chainAccounts.set(
      address("r", 5n).toBase58(),
      program({ roundId: "5", endsAt: String(NOW - 1_000n), status: ROUND_STATUS.OPEN, vrfSeed: [], requestedAt: "0" }),
    );
    chainAccounts.set(
      address("e", 6n).toBase58(),
      program({
        epochId: "6", startsAt: "0", endsAt: String(NOW - 9_000n), status: EPOCH_STATUS.ENDED,
        jackpotAmount: "0", vrfSeed: [], requestedAt: "0", target: "0", drawnAt: "0",
        registrationOpenedAt: String(NOW - 9_000n),
      }),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(NOW, 32);
    chainAccounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), accountInfo(clock));

    const { stuck } = await ops.getOpsSummary();
    expect(stuck).toEqual({
      round: { id: 5n, status: ROUND_STATUS.OPEN },
      epoch: { id: 6n, status: EPOCH_STATUS.ENDED },
    });
  });

  it("returns stuck null, not a clean pool, when the chain read fails", async () => {
    await seedActive();
    const reads = fakeChain.connection.getMultipleAccountsInfo;
    // The balance read behind /status asks for the vault; only the stuck read
    // asks for the Clock sysvar, so fail that one.
    fakeChain.connection.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      if (keys.some((key) => key.equals(SYSVAR_CLOCK_PUBKEY))) throw new Error("rpc down");
      return reads(keys);
    };
    try {
      const summary = await ops.getOpsSummary();
      expect(summary.stuck).toBeNull();
      expect(summary.totalPrincipal).toBe(20_000_000n);
    } finally {
      fakeChain.connection.getMultipleAccountsInfo = reads;
    }
  });

  it("reports the same nulls and zeros /status does for an unindexed pool", async () => {
    const summary = await ops.getOpsSummary();
    expect(summary.totalPrincipal).toBe(0n);
    expect(summary.venueValue).toBe(0n);
    expect([summary.feeOwed, summary.prizeOwed, summary.yieldOwed, summary.deficit]).toEqual([
      0n, 0n, 0n, 0n,
    ]);
    expect(summary.harvestedToTreasury).toBe(0n);
    expect(summary.harvestedToJackpot).toBe(0n);
    expect(summary.lastSyncAt).toBe(0n);
    expect(summary.admin).toBeNull();
    expect(summary.operatorKey).toBeNull();
    expect(summary.venueParams).toBeNull();
    expect(summary.venueKind).toBeNull();
    expect(summary.venueProposal).toBeNull();
    expect(summary.supplyRateBps).toBeNull();
    expect(summary.stuck).toEqual({ round: null, epoch: null });
    expect(summary.todo).toEqual([]);
    expect(summary.fastPauseWallets).toEqual([]);
    expect(summary.pendingWithdrawals).toBe(0n);
    expect(summary.solvencyMargin).toBeNull();
  });
});
