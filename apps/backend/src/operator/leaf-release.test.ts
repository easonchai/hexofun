// Mainnet-readiness-fixes 08: which Player's leaf the Operator may release,
// and the winner() check that no two Players share a leaf. The release
// candidates come from Postgres and are confirmed against the account on
// chain, so the DB-backed half drives the real query with a fake RPC.
const TEST_DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { AnchorProvider, BN, Program, Wallet, type Idl } from "@anchor-lang/core";
import type { ConfigService } from "@nestjs/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { playerAddress, poolAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { EPOCH_STATUS, type EpochState, type PoolState } from "./chain-state";
import { firstReleasable, isReleasable, type LeafHolder } from "./leaf-release";
import { OperatorService } from "./operator.service";
import { ensurePoolRow } from "./pool-row.fixture";
import type { SparringService } from "./sparring";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const POOL_ADDRESS = POOL.toBase58();

const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);

const noopSparring = { wake: () => {} } as unknown as SparringService;
const fakeConfig = { get: () => 60 } as unknown as ConfigService<HexVaultEnv, true>;
const noIndexer = {
  unsettledPositions: async () => [],
  referralGrantsDue: async () => [],
  markReferralGrantsSent: async () => {},
  sentReferralGrants: async () => [],
  roundsToClose: async () => [],
};

const holder = (over: Partial<LeafHolder> = {}): LeafHolder => ({
  owner: "owner",
  leafIndex: 7,
  isHouse: false,
  principal: 0n,
  pendingWithdraw: 0n,
  openPositions: 0,
  epochId: 3n,
  ...over,
});

describe("isReleasable", () => {
  const CURRENT = 5n;

  it("accepts an empty Player last touched two epochs ago", () => {
    expect(isReleasable(holder({ epochId: 3n }), CURRENT)).toBe(true);
  });

  it("refuses a live Player, whatever the mirror said", () => {
    expect(isReleasable(holder({ principal: 1n }), CURRENT)).toBe(false);
    expect(isReleasable(holder({ pendingWithdraw: 1n }), CURRENT)).toBe(false);
    expect(isReleasable(holder({ openPositions: 1 }), CURRENT)).toBe(false);
  });

  it("refuses the House, a Player without a leaf, and one empty for less than a full epoch", () => {
    expect(isReleasable(holder({ isHouse: true }), CURRENT)).toBe(false);
    expect(isReleasable(holder({ leafIndex: 0 }), CURRENT)).toBe(false);
    expect(isReleasable(holder({ epochId: 4n }), CURRENT)).toBe(false);
    expect(isReleasable(holder({ epochId: 5n }), CURRENT)).toBe(false);
  });

  it("picks the first releasable owner and skips gone accounts", () => {
    expect(
      firstReleasable(
        [null, holder({ owner: "live", principal: 5n }), holder({ owner: "empty" })],
        CURRENT,
      ),
    ).toBe("empty");
    expect(firstReleasable([null, holder({ principal: 5n })], CURRENT)).toBeNull();
  });
});

describe.skipIf(!DB_AVAILABLE)("OperatorService.leafToRelease", () => {
  const CURRENT = 10n;
  const owner = (): string => Keypair.generate().publicKey.toBase58();

  const row = (over: {
    owner: string;
    principal?: bigint;
    pendingWithdraw?: bigint;
    epochId?: bigint;
    leafIndex?: number;
    isHouse?: boolean;
  }) => ({
    poolAddress: POOL_ADDRESS,
    principal: 0n,
    entries: 0n,
    epochId: 3n,
    isHouse: false,
    pendingWithdraw: 0n,
    pendingEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    bonusEpoch: 0n,
    bonusGranted: 0n,
    leafIndex: 7,
    ...over,
  });

  /** The Player account as it is on chain. */
  const encoded = async (
    who: string,
    over: { principal?: bigint; openPositions?: number; leafIndex?: number; epochId?: bigint } = {},
  ): Promise<Buffer> =>
    program.coder.accounts.encode("player", {
      owner: new PublicKey(who),
      principal: new BN((over.principal ?? 0n).toString()),
      entries: new BN(0),
      epochId: new BN((over.epochId ?? 3n).toString()),
      isHouse: false,
      bump: 255,
      pendingWithdraw: new BN(0),
      pendingEpoch: new BN(0),
      requestedAt: new BN(0),
      boughtEpoch: new BN(0),
      boughtAmount: new BN(0),
      bonusEpoch: new BN(0),
      bonusGranted: new BN(0),
      yieldIndex: new BN(0),
      leafIndex: over.leafIndex ?? 7,
      version: 2,
      pendingDeposit: new BN(0),
      pendingDepositEpoch: new BN(0),
      openPositions: over.openPositions ?? 0,
      reserved: new Array<number>(44).fill(0),
    });

  const pool = { address: POOL, currentEpochId: CURRENT } as unknown as PoolState;

  const makeOperator = (prisma: PrismaService, connection: CountingConnection) =>
    new OperatorService(
      {
        program,
        programId: PROGRAM_ID,
        keypair: Keypair.generate(),
        connection,
        poolAddress: () => POOL,
        playerAddress: (who: PublicKey) => playerAddress(PROGRAM_ID, POOL, who),
        venueProposalAddress: () => PublicKey.default,
      } as unknown as ChainService,
      prisma,
      noIndexer,
      noopSparring,
      fakeConfig,
    );

  it("nominates only empty Players with a leaf, confirms them on chain, and never a live one", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const empty = owner();
    const staleMirror = owner(); // the mirror shows it empty, the chain says it deposited
    const live = owner();
    const withdrawing = owner();
    const recent = owner();
    const house = owner();
    const released = owner(); // already leafless
    const owners = [empty, staleMirror, live, withdrawing, recent, house, released];
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    await prisma.player.createMany({
      data: [
        row({ owner: live, principal: 5n }),
        row({ owner: withdrawing, pendingWithdraw: 5n }),
        row({ owner: recent, epochId: CURRENT - 1n }),
        row({ owner: house, isHouse: true }),
        row({ owner: released, leafIndex: 0 }),
        // Oldest first, so the stale row is examined before the good one.
        row({ owner: staleMirror, epochId: 1n }),
        row({ owner: empty, epochId: 2n }),
      ],
    });
    const connection = new CountingConnection(new Map());
    connection.setAccount(playerAddress(PROGRAM_ID, POOL, new PublicKey(staleMirror)), await encoded(staleMirror, { principal: 9n }));
    connection.setAccount(playerAddress(PROGRAM_ID, POOL, new PublicKey(empty)), await encoded(empty));
    const operator = makeOperator(prisma, connection);

    try {
      // Private: the query and the chain check are the seam under test.
      const pick = await operator["leafToRelease"](pool);
      expect(pick).toBe(empty);

      // Examined owners are skipped for the rest of the epoch, so the stale row
      // does not hold the slot and a released owner is not picked twice.
      operator["skippedLeaves"].set(empty, CURRENT);
      expect(await operator["leafToRelease"](pool)).toBeNull();

      // A new epoch forgets the skips.
      const later = { ...pool, currentEpochId: CURRENT + 1n } as unknown as PoolState;
      expect(await operator["leafToRelease"](later)).toBe(empty);
    } finally {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
      await prisma.$disconnect();
    }
  });

  it("refuses a Player the chain shows with an open Position or a different leaf state", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const betting = owner();
    const gone = owner();
    const owners = [betting, gone];
    await ensurePoolRow(prisma, POOL_ADDRESS, 1n);
    await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    await prisma.player.createMany({ data: owners.map((o) => row({ owner: o })) });
    const connection = new CountingConnection(new Map());
    connection.setAccount(playerAddress(PROGRAM_ID, POOL, new PublicKey(betting)), await encoded(betting, { openPositions: 1 }));
    // `gone` has no account at all.
    const operator = makeOperator(prisma, connection);
    try {
      expect(await operator["leafToRelease"](pool)).toBeNull();
    } finally {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
      await prisma.$disconnect();
    }
  });
});

describe("OperatorService.winner", () => {
  // One leaf holding 100 Principal, idle through epoch 2: leaf 1 owns every target.
  const tree = (() => {
    const data = Buffer.alloc(56 + 56);
    data.writeBigUInt64LE(1n, 16);
    data.writeBigUInt64LE(100n, 56);
    return data;
  })();

  const make = (players: { owner: PublicKey; leafIndex: number }[]) => {
    const accounts = players.map(({ owner, leafIndex }) => ({
      publicKey: playerAddress(PROGRAM_ID, POOL, owner),
      account: { owner, leafIndex, isHouse: false },
    }));
    return new OperatorService(
      {
        program: {
          idl: program.idl,
          coder: program.coder,
          account: { player: { all: async () => accounts } },
        },
        programId: PROGRAM_ID,
        keypair: Keypair.generate(),
        connection: { getAccountInfo: async () => ({ data: tree }) },
        playerAddress: (who: PublicKey) => playerAddress(PROGRAM_ID, POOL, who),
      } as unknown as ChainService,
      {} as PrismaService,
      noIndexer,
      noopSparring,
      fakeConfig,
    );
  };

  const epoch = { epochId: 2n, target: 5n, status: EPOCH_STATUS.DRAWN } as unknown as EpochState;
  const pool = { weightTree: Keypair.generate().publicKey } as unknown as PoolState;

  it("finds the one Player on the leaf, ignoring released Players at leaf 0", async () => {
    const holderKey = Keypair.generate().publicKey;
    const operator = make([
      { owner: holderKey, leafIndex: 1 },
      { owner: Keypair.generate().publicKey, leafIndex: 0 },
      { owner: Keypair.generate().publicKey, leafIndex: 2 },
    ]);
    expect(await operator["winner"](pool, epoch)).toEqual({
      owner: holderKey.toBase58(),
      isHouse: false,
    });
  });

  it("refuses to pick a winner when two Players share a leaf", async () => {
    const operator = make([
      { owner: Keypair.generate().publicKey, leafIndex: 1 },
      { owner: Keypair.generate().publicKey, leafIndex: 1 },
    ]);
    await expect(operator["winner"](pool, epoch)).rejects.toThrow(/leaf 1 is held by 2 Players/);
  });
});
