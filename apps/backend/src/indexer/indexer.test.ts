// Against a real Postgres, with the chain faked: the RPC responses are the
// only thing stubbed, so the Anchor coders, the row mapping and every SQL
// statement are the real ones.
//
// DATABASE_URL is set before PrismaService is constructed (the client reads it
// then, not at import), so this suite never touches the dev database.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_indexer";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { BN, BorshCoder, convertIdlToCamelCase } from "@anchor-lang/core";
import type { ConfigService } from "@nestjs/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "../api/invite-code";
import { ChainService } from "../chain/chain.service";
import { withRpcFallback } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { loadIdl } from "../chain/idl";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { ROUND_STATUS } from "./decode";
import { IndexerService, type LogBatch } from "./indexer.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
const POOL_ID = 1n;
// The same coder ChainService's Program builds, available before beforeAll so
// the log fixtures can be laid out at module scope.
const coder = new BorshCoder(convertIdlToCamelCase(idl));

let prisma: PrismaService;
let chain: ChainService;
let connection: CountingConnection;
let indexer: IndexerService;

const OWNER = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const WEIGHT_TREE = Keypair.generate().publicKey;

// Wrapped in one top-level describe, rather than adding `.skipIf` to each of
// the six describes below, because they share this file's beforeAll/afterAll/
// beforeEach: skipping only the describes would still run those hooks (and
// their Prisma connections) against an unreachable or wrong-auth database.
describe.skipIf(!DB_AVAILABLE)("indexer against Postgres", () => {

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  connection = new CountingConnection();
  const env: Partial<HexVaultEnv> = {
    OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
    POOL_ID: POOL_ID.toString(),
    PROGRAM_ID: PROGRAM_ID.toBase58(),
    RPC_URL: "http://127.0.0.1:1",
    REFERRAL_QUALIFY_SECONDS: 604_800,
  };
  // SAFETY: ChainService reads the first four keys above through `get`;
  // IndexerService reads REFERRAL_QUALIFY_SECONDS the same way.
  const config = {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
  // SAFETY: the fake stands in for the RPC calls the indexer makes; this
  // suite drives no code path that reaches any other Connection method.
  chain = new ChainService(connection as unknown as Connection, config);
  indexer = new IndexerService(prisma, chain, config);
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  connection.clearAccounts();
  connection.pageSize = 1_000;
  connection.watched = [];
  connection.resetCalls();
  connection.failOnCallNumber = undefined;
  connection.noProgramAccountsV2 = false;
  // The indexer is built once for the suite, so the flag it latches when an
  // RPC lacks V2 has to be cleared between tests, and so does what the live
  // path has written (a fresh process starts with neither).
  indexer["v2Unsupported"] = false;
  indexer["v2UnsupportedSince"] = undefined;
  indexer["freshWrites"].clear();
  await wipe();
});

async function wipe(): Promise<void> {
  // Pool goes last: every pool-scoped table references it, onDelete Restrict.
  await prisma.$transaction([
    prisma.event.deleteMany(),
    prisma.cursor.deleteMany(),
    prisma.venueProposal.deleteMany(),
    prisma.position.deleteMany(),
    prisma.player.deleteMany(),
    prisma.round.deleteMany(),
    prisma.epoch.deleteMany(),
    prisma.yieldIndexPoint.deleteMany(),
    prisma.weightTreeState.deleteMany(),
    prisma.referral.deleteMany(),
    prisma.referralGrantShare.deleteMany(),
    prisma.referralGrant.deleteMany(),
    prisma.referralCode.deleteMany(),
    prisma.inviteCode.deleteMany(),
    prisma.pool.deleteMany(),
  ]);
}

// ------------------------------------------------------------- fixtures

/** The Active pool's address, the one the indexer scopes every row to. */
const active = (): string => chain.poolAddress().toBase58();
/** Another pool the same database mirrored before a cutover (ADR 0016). */
const RETIRED_POOL = Keypair.generate().publicKey.toBase58();

/** Compound keys for a unique lookup of an Active-pool Epoch/Round or Player. */
const byId = (id: bigint) => ({ poolAddress_id: { poolAddress: active(), id } });
const byOwner = (owner: string) => ({ poolAddress_owner: { poolAddress: active(), owner } });

/** A Pool row as the indexer would mirror it, for tests that write
 *  pool-scoped rows directly and so need their foreign key to exist. */
const poolRecord = (overrides: object = {}) => ({
  address: active(),
  poolId: POOL_ID,
  admin: OWNER.toBase58(),
  operator: OWNER.toBase58(),
  pendingAdmin: null,
  mint: STRANGER.toBase58(),
  epochSeconds: 86_400n,
  epochAnchor: 0n,
  roundSeconds: 60n,
  closeBuffer: 5n,
  minDeposit: 1_000_000n,
  paused: false,
  currentEpochId: 1n,
  currentEpochEndsAt: 0n,
  previousEpochEndsAt: 0n,
  totalPrincipal: 100_000_000_000n, // 100,000 USDC: ample, no pool cap bind
  pendingWithdrawals: 0n,
  minJackpot: 1_000_000n,
  houseCutBps: 600,
  baseRateBps: 0,
  ticketsPerUsdc: 10,
  bonusCapBps: 10_000, // 100%: no pool cap bind unless a test overrides it
  bonusEpoch: 0n,
  bonusGranted: 0n,
  version: 1,
  shutdown: false,
  updatedSlot: 1n,
  ...overrides,
});

const seedActivePool = async (): Promise<void> => {
  await prisma.pool.create({ data: poolRecord() });
};

const bn = (value: bigint | number): BN => new BN(value.toString());
const zeros = (length: number): number[] => new Array<number>(length).fill(0);

// The coder knows the camelCased account names, the same ones the indexer
// passes; a casing drift in Anchor breaks the encode here and the fetch there.
async function put(name: string, pubkey: PublicKey, account: object): Promise<void> {
  const data = await chain.program.coder.accounts.encode(name, account);
  connection.setAccount(pubkey, data);
}

const poolAccount = (overrides: object = {}) => ({
  poolId: bn(POOL_ID),
  admin: OWNER,
  operator: OWNER,
  pendingAdmin: PublicKey.default,
  acceptedMint: STRANGER,
  principalVault: chain.principalVaultAddress(),
  jackpotVault: chain.jackpotVaultAddress(),
  treasury: STRANGER,
  buybackReserve: STRANGER,
  house: chain.playerAddress(OWNER),
  vrfNetworkState: STRANGER,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(1_000),
  currentEpochEndsAt: bn(2_000),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  nextRoundId: bn(2),
  openRoundId: bn(1),
  totalPrincipal: bn(3_000_000),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  pendingWithdrawals: bn(0),
  minJackpot: bn(1_000_000),
  payoutTimeout: bn(86_400),
  // Ticket 14: the venue and the Weight tree. The tree is not in the fake
  // RPC's accounts unless a test puts it there, so the mirror reads nothing.
  weightTree: WEIGHT_TREE,
  klendProgram: STRANGER,
  klendMarket: STRANGER,
  klendReserve: STRANGER,
  klendCtoken: STRANGER,
  venueKind: 0,
  yieldIndex: bn(0),
  venueValue: bn(0),
  lastSyncAt: bn(0),
  ...overrides,
});

const epochAccount = (overrides: object = {}) => ({
  epochId: bn(1),
  startsAt: bn(1_000),
  endsAt: bn(2_000),
  status: 1,
  jackpotAmount: bn(10_000_000),
  vrfSeed: zeros(32),
  requestedAt: bn(0),
  target: bn(42),
  winner: PublicKey.default,
  bump: 255,
  ...overrides,
});

const roundAccount = (overrides: object = {}) => ({
  roundId: bn(1),
  epochId: bn(1),
  startsAt: bn(1_000),
  endsAt: bn(1_060),
  status: 0,
  tileTotals: zeros(36).map((total) => bn(total)),
  pot: bn(0),
  vrfSeed: zeros(32),
  requestedAt: bn(0),
  winningTile: 0,
  bump: 255,
  ...overrides,
});

const playerAccount = (owner: PublicKey, overrides: object = {}) => ({
  owner,
  principal: bn(3_000_000),
  entries: bn(2_500_000),
  epochId: bn(1),
  isHouse: false,
  bump: 255,
  pendingWithdraw: bn(0),
  pendingEpoch: bn(0),
  ...overrides,
});

const positionAccount = (owner: PublicKey, round: PublicKey) => ({
  owner,
  round,
  tiles: bn(0b1011),
  stakePerTile: bn(1_000),
  bump: 255,
});

describe("account sync", () => {
  it("mirrors one of each account into Postgres", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("round", round, roundAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));

    await indexer.syncAccounts();

    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({
        poolId: POOL_ID,
        totalPrincipal: 3_000_000n,
        currentEpochId: 1n,
        paused: false,
        updatedSlot: 100n,
      });

    const epoch = await prisma.epoch.findUniqueOrThrow({ where: byId(1n) });
    expect(epoch.jackpotAmount).toBe(10_000_000n);
    // Pubkey::default means payout has not run; the column stays null.
    expect(epoch.winner).toBeNull();

    const stored = await prisma.round.findUniqueOrThrow({ where: byId(1n) });
    // Tile 0 is a real tile, so an unsettled round must not claim it won.
    expect(stored.winningTile).toBeNull();
    expect((stored.tileTotals as string[]).length).toBe(36);

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ principal: 3_000_000n, entries: 2_500_000n, isHouse: false });

    expect(await prisma.position.findMany()).toMatchObject([
      { owner: OWNER.toBase58(), roundId: 1n, tiles: 11n, stakePerTile: 1_000n },
    ]);
  });

  // venue-switch ticket 03
  it("mirrors the open venue proposal, and drops it when a full walk or a log read finds it gone", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const proposal = chain.venueProposalAddress();
    const target = Keypair.generate().publicKey;
    await put("pool", chain.poolAddress(), poolAccount());
    await put("venueProposal", proposal, {
      pool: chain.poolAddress(),
      venueKind: 2,
      klendProgram: target,
      klendMarket: target,
      klendReserve: target,
      klendCtoken: target,
      proposedAt: bn(1_800_000_000),
      bump: 255,
    });

    await indexer.syncAccounts();
    expect(await prisma.venueProposal.findUniqueOrThrow({ where: { poolAddress: active() } }))
      .toMatchObject({
        venueKind: 2,
        klendReserve: target.toBase58(),
        proposedAt: 1_800_000_000n,
      });

    // A log-triggered read that finds no account is the cancel.
    connection.deleteAccount(proposal);
    await indexer["refreshFromLogs"]([], 200n);
    expect(await prisma.venueProposal.count()).toBe(0);

    // And a full walk that does not see it removes a row left behind.
    await prisma.venueProposal.create({
      data: {
        poolAddress: active(),
        venueKind: 0,
        klendProgram: "a",
        klendMarket: "b",
        klendReserve: "c",
        klendCtoken: "d",
        proposedAt: 1n,
        updatedSlot: 1n,
      },
    });
    indexer["lastSyncedSlot"] = undefined;
    indexer["freshWrites"].clear();
    await indexer.syncAccounts();
    expect(await prisma.venueProposal.count()).toBe(0);
  });

  it("records the winning tile once the round is settled", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", chain.roundAddress(1n), roundAccount({ status: 2, winningTile: 17 }));
    await indexer.syncAccounts();
    expect((await prisma.round.findUniqueOrThrow({ where: byId(1n) })).winningTile).toBe(17);
  });

  it("no longer deletes a Position by its absence from a sweep", async () => {
    // A closed account and an unchanged one both look like "not returned" to
    // an incremental walk, so a sweep can no longer tell them apart; only the
    // `PositionSettled` event (see "event ingest" below) may remove the row.
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    const pool = chain.poolAddress();
    await put("pool", pool, poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);

    connection.deleteAccount(chain.positionAddress(round, OWNER));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);
  });

  // ticket 06: the full walk is the backstop for a missed `PositionSettled`.
  it("deletes a Position by its absence on a full walk", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts(); // full walk, establishes the row
    expect(await prisma.position.count()).toBe(1);

    connection.deleteAccount(chain.positionAddress(round, OWNER));
    indexer["lastFullWalkAt"] = 0; // force the next sweep full too, not incremental
    await indexer.syncAccounts();

    expect(await prisma.position.count()).toBe(0);
  });

  // ticket 06: the full walk is the backstop for a missed `RoundClosed`; the
  // row is marked closed and kept, matching ops-and-envs ticket 08, not
  // deleted the way an absent Position is.
  it("marks a Round closed, not deleted, on a full walk that finds its account gone", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await indexer.syncAccounts(); // full walk, establishes the row
    expect((await prisma.round.findUniqueOrThrow({ where: byId(1n) })).closed).toBe(false);

    connection.deleteAccount(round);
    indexer["lastFullWalkAt"] = 0; // force the next sweep full too, not incremental
    await indexer.syncAccounts();

    const stored = await prisma.round.findUniqueOrThrow({ where: byId(1n) });
    expect(stored.closed).toBe(true);
    // Kept, not blanked: it still mirrors the round's last on-chain state.
    expect(stored.status).toBe(ROUND_STATUS.OPEN);
  });

  it("walks every page of a multi-page result into the same rows a single page would", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    connection.pageSize = 1; // four accounts, one per page: four calls

    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(4);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({ poolId: POOL_ID });
    expect(await prisma.round.findUniqueOrThrow({ where: byId(1n) })).toMatchObject({ id: 1n });
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ owner: OWNER.toBase58() });
    expect(await prisma.position.findMany()).toMatchObject([
      { owner: OWNER.toBase58(), roundId: 1n },
    ]);
  });

  it("an incremental sweep asks for changedSinceSlot and only touches the rows the RPC reports", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts(); // full walk, establishes lastSyncedSlot
    const syncedSlot = indexer["lastSyncedSlot"];
    if (typeof syncedSlot !== "bigint") throw new Error("expected lastSyncedSlot to be set by the full walk above");
    expect(syncedSlot).toBe(100n);

    connection.resetCalls();
    // Simulate the RPC reporting only the Pool as changed; Round and Position
    // are unchanged and so absent from this result.
    connection.clearAccounts();
    await put("pool", chain.poolAddress(), poolAccount({ totalPrincipal: bn(999) }));
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
    // SAFETY: the fake only ever receives [programId, config] from the indexer.
    const [, config] = connection.lastParams("getProgramAccountsV2") as [string, { changedSinceSlot?: number }];
    expect(config.changedSinceSlot).toBe(Number(syncedSlot));

    expect((await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } })).totalPrincipal)
      .toBe(999n);
    // The old absence-based delete would have wiped these; they must survive.
    expect(await prisma.round.count()).toBe(1);
    expect(await prisma.position.count()).toBe(1);
  });

  it("forces a fresh full walk once the safety interval has elapsed, even with a known slot", async () => {
    indexer["lastSyncedSlot"] = 42n;
    indexer["lastFullWalkAt"] = Date.now() - (60 * 60 * 1000 + 1);
    await put("pool", chain.poolAddress(), poolAccount());
    connection.resetCalls();

    await indexer.syncAccounts();

    // SAFETY: the fake only ever receives [programId, config] from the indexer.
    const [, config] = connection.lastParams("getProgramAccountsV2") as [string, { changedSinceSlot?: number }];
    expect(config.changedSinceSlot).toBeUndefined();
  });

  it("a page failure mid-walk leaves the previous synced state and slot intact", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.syncAccounts();
    const syncedSlot = indexer["lastSyncedSlot"];

    connection.pageSize = 1;
    connection.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));
    connection.resetCalls(); // count fresh from this walk's first page
    connection.failOnCallNumber = { method: "getProgramAccountsV2", number: 2 }; // the walk's second page

    await expect(indexer.syncAccounts()).rejects.toThrow();

    expect(indexer["lastSyncedSlot"]).toBe(syncedSlot);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({ poolId: POOL_ID });
  });

  it("the counting connection: seven calls for a full walk, one for a quiet incremental sweep", async () => {
    indexer["lastSyncedSlot"] = undefined;
    indexer["lastFullWalkAt"] = 0;
    await put("pool", chain.poolAddress(), poolAccount());
    // Padding so the walk spans seven one-account pages; the padding never
    // matches a real discriminator, so it is silently dropped, same as any
    // account from an abandoned program build.
    for (let i = 0; i < 6; i++) {
      connection.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));
    }
    connection.pageSize = 1;
    connection.resetCalls();

    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(7);

    connection.resetCalls();
    connection.clearAccounts();
    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
  });

  it("falls back to the plain call on an RPC without getProgramAccountsV2, and stops asking for it", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    connection.noProgramAccountsV2 = true;
    connection.resetCalls();

    await indexer.syncAccounts();

    // One V2 attempt, then the plain call answers with the same rows.
    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.round.count()).toBe(1);
    expect(await prisma.position.findMany()).toMatchObject([{ owner: OWNER.toBase58(), roundId: 1n }]);

    // A second sweep does not retry V2, and without changedSinceSlot it walks
    // everything again, so a closed Position is still caught by its absence.
    connection.resetCalls();
    connection.deleteAccount(chain.positionAddress(round, OWNER));
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(0);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.position.count()).toBe(0);
  });

  // beta-launch-fixes ticket 08: the flag is not permanent.
  it("gives getProgramAccountsV2 another try after an hour", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["v2Unsupported"] = true;
    indexer["v2UnsupportedSince"] = Date.now() - 61 * 60 * 1000; // just past the 1h window
    connection.resetCalls();

    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBeGreaterThan(0);
    expect(indexer["v2Unsupported"]).toBe(false);
  });

  it("ignores an account that does not sit at this pool's PDA", async () => {
    // Same layout, different pool: the account carries no pool field, so
    // writing it would file a sibling pool's row under the Active pool.
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", Keypair.generate().publicKey, playerAccount(STRANGER));
    await put("epoch", Keypair.generate().publicKey, epochAccount({ epochId: bn(9) }));
    await indexer.syncAccounts();
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.epoch.count()).toBe(0);
  });

  it("skips a pool left behind by an older program layout and still syncs this one", async () => {
    // A pool bootstrapped before the epoch-anchor upgrade is 22 bytes short
    // of the current layout; decoding it must not fail the whole sweep.
    const stale = await chain.program.coder.accounts.encode("pool", poolAccount());
    connection.setAccount(Keypair.generate().publicKey, stale.subarray(0, -22));
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.syncAccounts();
    expect(await prisma.pool.count()).toBe(1);
  });

  it("stamps the cursor with the sync time so /status can age it", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.tick();
    const cursor = await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } });
    expect(cursor.updatedAt).not.toBeNull();
    expect(Number(cursor.updatedAt)).toBeGreaterThan(Date.now() / 1000 - 60);
  });
});

// Security review ticket 14: `withRpcFallback` fails over per call, with no
// stickiness (rpc-fallback.ts), so a flaky primary can hand a paginated full
// walk its first page and the fallback its second. Builds its own
// ChainService/IndexerService over a wrapped pair of CountingConnections
// (`connection`/`chain`/`indexer` above share one always-primary fake) so the
// failover path actually engages.
describe("full-walk RPC endpoint consistency (security review ticket 14)", () => {
  it("aborts a paginated walk rather than mixing pages from two different RPC endpoints, writing nothing", async () => {
    const primary = new CountingConnection();
    const fallback = new CountingConnection();
    primary.pageSize = 1;
    fallback.pageSize = 1;
    const wrapped = withRpcFallback(
      primary as unknown as Connection,
      fallback as unknown as Connection,
      1_000,
    );
    const env: Partial<HexVaultEnv> = {
      OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
      POOL_ID: POOL_ID.toString(),
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      RPC_URL: "http://127.0.0.1:1",
      REFERRAL_QUALIFY_SECONDS: 604_800,
    };
    // SAFETY: same shape as the suite's own beforeAll config stub.
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    const localChain = new ChainService(wrapped, config);
    const localIndexer = new IndexerService(prisma, localChain, config);

    // Two accounts on the primary so pageSize 1 needs a second page; the
    // fallback holds none, standing in for a second provider whose index
    // simply differs from the primary's.
    const poolData = await localChain.program.coder.accounts.encode("pool", poolAccount());
    primary.setAccount(localChain.poolAddress(), poolData);
    primary.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));

    // The primary's *second* getProgramAccountsV2 call looks like a timeout
    // (rpc-fallback.ts's isFailoverWorthy), so withRpcFallback retries it on
    // the fallback mid-walk, exactly the race this test is proving is safe.
    const realRpcRequest = primary._rpcRequest.bind(primary);
    let primaryCalls = 0;
    primary._rpcRequest = (method: string, params: unknown[]) => {
      primaryCalls += 1;
      if (method === "getProgramAccountsV2" && primaryCalls === 2) {
        return Promise.reject(new Error("RPC getProgramAccountsV2 timed out after 10000ms"));
      }
      return realRpcRequest(method, params);
    };

    await expect(localIndexer.syncAccounts()).rejects.toThrow(/different RPC endpoint/);

    // fetchAll threw before syncAccounts ever opened a Prisma transaction, so
    // the Pool that page 1 alone did see never lands, and no earlier row's
    // absence gets misread as "gone" either.
    expect(await prisma.pool.count()).toBe(0);
  });

  // beta-launch-fixes ticket 08: `withRpcFallback` fails over per call with
  // no stickiness, so one call landing on the fallback and getting "method
  // not found" back must not be read as the primary lacking the extension.
  it("does not disable getProgramAccountsV2 when only the fallback RPC answers method-not-found", async () => {
    const primary = new CountingConnection();
    const fallback = new CountingConnection();
    fallback.noProgramAccountsV2 = true;
    const wrapped = withRpcFallback(
      primary as unknown as Connection,
      fallback as unknown as Connection,
      1_000,
    );
    const env: Partial<HexVaultEnv> = {
      OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
      POOL_ID: POOL_ID.toString(),
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      RPC_URL: "http://127.0.0.1:1",
      REFERRAL_QUALIFY_SECONDS: 604_800,
    };
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    const localChain = new ChainService(wrapped, config);
    const localIndexer = new IndexerService(prisma, localChain, config);

    const poolData = await localChain.program.coder.accounts.encode("pool", poolAccount());
    primary.setAccount(localChain.poolAddress(), poolData);

    // The primary's own getProgramAccountsV2 call looks like a timeout, so
    // withRpcFallback retries this one call on the fallback, which lacks the
    // extension and answers "method not found".
    const realRpcRequest = primary._rpcRequest.bind(primary);
    primary._rpcRequest = (method: string, params: unknown[]) => {
      if (method === "getProgramAccountsV2") {
        return Promise.reject(new Error("RPC getProgramAccountsV2 timed out after 10000ms"));
      }
      return realRpcRequest(method, params);
    };

    // This one sweep degrades (no page ever actually answered), but the flag
    // must stay false: it was the fallback, not the primary, that said
    // "method not found".
    await expect(localIndexer.syncAccounts()).rejects.toThrow(/getProgramAccountsV2 returned no pages/);
    expect(localIndexer["v2Unsupported"]).toBe(false);

    // Restore normal primary behaviour: the next sweep succeeds via V2 on
    // the primary, proving the fallback's false "method not found" did not
    // disable it for good.
    primary._rpcRequest = realRpcRequest;
    await localIndexer.syncAccounts();
    expect(await prisma.pool.count()).toBe(1);
  });
});

// ----------------------------------------------------------- event ingest

/** A `Program data:` log line, built through the same IDL the indexer reads. */
function dataLine(name: string, fields: object): string {
  const event = (idl.events ?? []).find((candidate) => candidate.name === name);
  if (!event) throw new Error(`event ${name} is not in the IDL`);
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  const body = coder.types.encode(camel, fields);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64")}`;
}

function batch(signature: string, slot: bigint, lines: string[]): LogBatch {
  return {
    signature,
    slot,
    blockTime: 1_700_000_000n,
    logs: [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      ...lines,
      `Program ${PROGRAM_ID.toBase58()} success`,
    ],
  };
}

const deposited = dataLine("Deposited", {
  owner: OWNER,
  amount: bn(1_000_000),
  principal: bn(1_000_000),
  entries: bn(1_000_000),
});
const epochBegan = dataLine("EpochBegan", {
  epochId: bn(2),
  startsAt: bn(1_000),
  endsAt: bn(2_000),
});
const roundOpened = dataLine("RoundOpened", {
  roundId: bn(4),
  epochId: bn(2),
  startsAt: bn(1_000),
  endsAt: bn(1_060),
});
const positionSettled = dataLine("PositionSettled", {
  roundId: bn(1),
  owner: OWNER,
  reward: bn(0),
  refund: bn(0),
});
const roundClosed = dataLine("RoundClosed", {
  round: Keypair.generate().publicKey,
  roundId: bn(1),
});

// Parameterized, not fixed consts like `deposited`: ticket 07's tests build a
// different event sequence (cross up, dip, restore) per case.
const depositedFor = (owner: PublicKey, amount: number, principal: number, entries: number) =>
  dataLine("Deposited", { owner, amount: bn(amount), principal: bn(principal), entries: bn(entries) });
// A request that refunds `amount` of a pending deposit and queues nothing: the
// refunded part is what lowers Principal, which is what the referral tracker
// reads.
const withdrawRequestedFor = (owner: PublicKey, amount: number, pending: number, pendingEpoch = 1) =>
  dataLine("WithdrawRequested", {
    owner,
    amount: bn(amount),
    pending: bn(pending),
    pendingEpoch: bn(pendingEpoch),
    refunded: bn(amount),
    paid: bn(amount),
    redeemed: bn(0),
  });
// Live yield settles inside the money instructions and emits no event of its
// own; a processed withdrawal carries the Principal left, which is what the
// referral tracker needs.
const withdrawnFor = (owner: PublicKey, paid: number, principal: number) =>
  dataLine("Withdrawn", {
    owner,
    amount: bn(paid),
    principal: bn(principal),
    entries: bn(principal),
  });
const jackpotPaidFor = (
  winner: PublicKey,
  amount: number,
  compounded: boolean,
  epochId = 1,
  isHouse = false,
) => dataLine("JackpotPaid", { epochId: bn(epochId), winner, amount: bn(amount), isHouse, compounded });

describe("event ingest", () => {
  // Event, Cursor and every other row below references the Pool row, which
  // in production the first sweep writes before any event lands (see tick).
  beforeEach(seedActivePool);

  it("deletes the Position row when PositionSettled lands, without a sweep", async () => {
    await prisma.position.create({
      data: {
        address: "pos-x",
        poolAddress: active(),
        owner: OWNER.toBase58(),
        roundId: 1n,
        tiles: 1n,
        stakePerTile: 1n,
      },
    });

    expect(await indexer.ingestLogs(batch("sig-settle", 30n, [positionSettled]))).toBe(1);

    expect(await prisma.position.count()).toBe(0);
  });

  it("marks a Round closed on RoundClosed, keeping its last mirrored state", async () => {
    await prisma.round.create({
      data: {
        poolAddress: active(),
        id: 1n,
        epochId: 5n,
        startsAt: 0n,
        endsAt: 60n,
        status: ROUND_STATUS.SETTLED,
        pot: 500_000n,
        houseCut: 10_000n,
        winningTile: 7,
        tileTotals: [],
      },
    });

    expect(await indexer.ingestLogs(batch("sig-close", 31n, [roundClosed]))).toBe(1);

    const round = await prisma.round.findUniqueOrThrow({ where: byId(1n) });
    expect(round.closed).toBe(true);
    // The account is gone on chain; nothing here re-derives its fields, so
    // they must be exactly what the last mirror wrote.
    expect(round).toMatchObject({ status: ROUND_STATUS.SETTLED, pot: 500_000n, winningTile: 7 });
  });


  it("stores an event once when the live path reports it at a later slot", async () => {
    // Surfpool's finalized log notification carries a slot ~31 past the
    // transaction's own, which the catch-up poll reports.
    expect(await indexer.ingestLogs(batch("sig1", 10n, [deposited]))).toBe(1);
    expect(await indexer.ingestLogs(batch("sig1", 41n, [deposited]))).toBe(0);
    expect(await prisma.event.count()).toBe(1);
  });

  it("stores each event once and leaves the cursor on the newest batch", async () => {
    const first = batch("sig1", 10n, [deposited, epochBegan]);
    const second = batch("sig2", 11n, [roundOpened]);
    const third = batch("sig3", 12n, [deposited]);

    expect(await indexer.ingestLogs(first)).toBe(2);
    expect(await indexer.ingestLogs(second)).toBe(1);
    // The replay a websocket reconnect or a catch-up overlap produces.
    expect(await indexer.ingestLogs(first)).toBe(0);
    // Replaying an older batch must not drag the resume point backwards.
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      lastSignature: "sig2",
      lastSlot: 11n,
    });
    expect(await indexer.ingestLogs(third)).toBe(1);

    expect(await prisma.event.count()).toBe(4);
    expect(
      (await prisma.event.findMany({ orderBy: [{ slot: "asc" }, { index: "asc" }] })).map(
        (event) => [event.signature, event.index, event.name],
      ),
    ).toEqual([
      ["sig1", 0, "Deposited"],
      ["sig1", 1, "EpochBegan"],
      ["sig2", 0, "RoundOpened"],
      ["sig3", 0, "Deposited"],
    ]);

    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      lastSignature: "sig3",
      lastSlot: 12n,
    });
  });

  it("keeps u64 amounts exact and block time alongside the row", async () => {
    await indexer.ingestLogs(batch("sig9", 20n, [deposited]));
    const event = await prisma.event.findFirstOrThrow();
    expect(event.blockTime).toBe(1_700_000_000n);
    expect(event.poolAddress).toBe(active());
    expect(event.data).toMatchObject({ owner: OWNER.toBase58(), amount: "1000000" });
  });

  // ADR 0014, docs/plan/referral-page ticket 01: a wallet's first deposit
  // gets it a ReferralCode, not the depositor-owned InviteCode ticket 06
  // used to create.
  it("creates a ReferralCode on a wallet's first Deposited event", async () => {
    await indexer.ingestLogs(batch("sig-first-deposit", 40n, [deposited]));

    const codes = await prisma.referralCode.findMany();
    expect(codes).toHaveLength(1);
    expect(codes[0]?.owner).toBe(OWNER.toBase58());
    expect(codes[0]?.code).toHaveLength(INVITE_CODE_LENGTH);
    for (const char of codes[0]?.code ?? "") {
      expect(INVITE_CODE_ALPHABET).toContain(char);
    }
    expect(await prisma.inviteCode.count()).toBe(0);
  });

  it("does not create a second ReferralCode on a later Deposited event for the same wallet", async () => {
    await indexer.ingestLogs(batch("sig-first-deposit", 40n, [deposited]));
    const first = await prisma.referralCode.findUniqueOrThrow({ where: { owner: OWNER.toBase58() } });

    await indexer.ingestLogs(
      batch("sig-second-deposit", 41n, [depositedFor(OWNER, 500_000, 1_500_000, 1_500_000)]),
    );

    const codes = await prisma.referralCode.findMany({ where: { owner: OWNER.toBase58() } });
    expect(codes).toHaveLength(1);
    expect(codes[0]?.code).toBe(first.code);
  });

  // ADR 0016: "first deposit" is first ever. A wallet that got its code
  // depositing into a retired pool keeps it, and its first Deposited in the
  // Active pool must not trip ReferralCode's unique owner index.
  it("keeps the ReferralCode a retired pool's deposit created on a first deposit into the Active pool", async () => {
    await prisma.referralCode.create({
      data: { code: "OLDCODE2", owner: OWNER.toBase58(), createdAt: 1n },
    });

    expect(await indexer.ingestLogs(batch("sig-new-pool-deposit", 40n, [deposited]))).toBe(1);

    expect(await prisma.referralCode.findMany()).toMatchObject([
      { code: "OLDCODE2", owner: OWNER.toBase58() },
    ]);
  });

  it("advances the cursor past a transaction that emitted nothing", async () => {
    expect(await indexer.ingestLogs(batch("sig0", 5n, ["Program log: no events here"]))).toBe(0);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      lastSignature: "sig0",
      lastSlot: 5n,
    });
  });

  // Several pools share one program on devnet and events carry no pool field,
  // so listening on the program id fed every sibling pool's feed into this one.
  it("lists and subscribes on the pool PDA, never the program id", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    connection.watched = [];
    indexer["subscribeToLogs"]();
    indexer["subscribeToSync"]();
    await indexer.tick();

    const pool = chain.poolAddress().toBase58();
    expect(connection.watched.map((address) => address.toBase58())).toEqual([pool, pool, pool]);
  });

  // Ticket 04: the live path costs no `getBlockTime` call, and must not
  // borrow the backfill path's real block time or fall back to wall time.
  it("timestamps a live event from the last observed chain time, not a block-time lookup", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    chain.recordChainTime(1_234_567n);
    indexer["lastSyncedSlot"] = 100n; // the first sweep has landed
    indexer["subscribeToLogs"]();

    const pool = chain.poolAddress();
    connection.fireLogs(
      pool,
      "finalized",
      { err: null, signature: "sig-live", logs: batch("sig-live", 0n, [deposited]).logs },
      77,
    );
    await indexer["queue"];

    const event = await prisma.event.findFirstOrThrow({ where: { signature: "sig-live" } });
    expect(event.blockTime).toBe(1_234_567n);
    expect(event.slot).toBe(77n);
  });

  it("keeps the transaction's own block time on a backfilled event, even with a different chain time observed live", async () => {
    chain.recordChainTime(999_999n);
    expect(await indexer.ingestLogs(batch("sig-backfill", 40n, [deposited]))).toBe(1);
    const event = await prisma.event.findFirstOrThrow({ where: { signature: "sig-backfill" } });
    // batch()'s own fixed block time, not the 999_999n last observed live.
    expect(event.blockTime).toBe(1_700_000_000n);
  });

  // beta-launch-fixes ticket 08: the live path stores the event but never
  // advances the cursor, so a gap between two live events is always
  // replayed by the next catch-up rather than the cursor having already
  // jumped past the missed one.
  it("a live event does not move the cursor; a later catch-up still replays an older gap", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["lastSyncedSlot"] = 100n; // the first sweep has landed
    indexer["subscribeToLogs"]();

    const pool = chain.poolAddress();
    connection.fireLogs(
      pool,
      "finalized",
      { err: null, signature: "sig-live-only", logs: batch("sig-live-only", 0n, [deposited]).logs },
      50,
    );
    await indexer["queue"];

    // The live event was stored...
    await prisma.event.findFirstOrThrow({ where: { signature: "sig-live-only" } });
    // ...but the cursor never moved, so a websocket gap before this event
    // stays visible to the next catch-up instead of looking already caught up.
    expect(await prisma.cursor.findUnique({ where: { poolAddress: active() } })).toBeNull();

    // The RPC's own signature history has an older signature the live path
    // never saw (the gap), plus the one it did see.
    connection.signaturesForAddress = [
      { signature: "sig-live-only", slot: 50, err: null, blockTime: 1_700_000_050 },
      { signature: "sig-gap", slot: 10, err: null, blockTime: 1_700_000_010 },
    ];
    connection.setTransaction(
      "sig-gap",
      batch("sig-gap", 10n, [depositedFor(STRANGER, 1, 1, 1)]).logs,
    );
    connection.setTransaction("sig-live-only", batch("sig-live-only", 50n, [deposited]).logs);

    await indexer["catchUpEvents"]();

    await prisma.event.findFirstOrThrow({ where: { signature: "sig-gap" } });
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      lastSignature: "sig-live-only",
      lastSlot: 50n,
    });
  });
});

// ticket 06: a long outage can pile up more signatures than one page.
describe("event catch-up", () => {
  beforeEach(seedActivePool);

  it(
    "pages past 1,000 signatures and stores a 2,500-signature backlog once",
    async () => {
      const total = 2_500;
      // The fake, like the real RPC, answers newest first.
      connection.signaturesForAddress = Array.from({ length: total }, (_, i) => {
        const slot = total - i; // sig-(total-1) is newest, at slot `total`
        return { signature: `sig-${slot - 1}`, slot, err: null, blockTime: 1_700_000_000 + slot };
      });
      for (let id = 0; id < total; id++) {
        connection.setTransaction(`sig-${id}`, batch(`sig-${id}`, 1n, [roundOpened]).logs);
      }

      await indexer["catchUpEvents"]();

      // 1,000 + 1,000 + 500: the third page comes back short, which is what
      // ends the walk with no cursor to stop at.
      expect(connection.callsTo("getSignaturesForAddress")).toBe(3);
      expect(await prisma.event.count()).toBe(total);
      expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
        lastSignature: `sig-${total - 1}`,
        lastSlot: BigInt(total),
      });
    },
    120_000,
  );

  it(
    "on a second run, pages only back to the cursor, not past it",
    async () => {
      const total = 1_500;
      connection.signaturesForAddress = Array.from({ length: total }, (_, i) => {
        const slot = total - i;
        return { signature: `sig-${slot - 1}`, slot, err: null, blockTime: 1_700_000_000 + slot };
      });
      for (let id = 0; id < total; id++) {
        connection.setTransaction(`sig-${id}`, batch(`sig-${id}`, 1n, [roundOpened]).logs);
      }
      await indexer["catchUpEvents"]();
      expect(await prisma.event.count()).toBe(total);

      // A fresh signature lands on top of the existing backlog.
      connection.signaturesForAddress = [
        { signature: "sig-new", slot: total + 1, err: null, blockTime: 1_700_000_000 + total + 1 },
        ...connection.signaturesForAddress,
      ];
      connection.setTransaction("sig-new", batch("sig-new", 1n, [roundOpened]).logs);
      connection.resetCalls();

      await indexer["catchUpEvents"]();

      // The cursor already sits on sig-1499; one page reaches it well before
      // 1,000 signatures, so this does not walk the whole array again.
      expect(connection.callsTo("getSignaturesForAddress")).toBe(1);
      expect(await prisma.event.count()).toBe(total + 1);
    },
    120_000,
  );
});

// `getProgramAccountsV2`'s index runs 13 to 24 seconds behind the chain
// (measured against devnet), so a sweep fired by a log hands back a snapshot
// from before the transaction that fired it. A confirmed log re-reads the
// accounts it names instead, and the sweep must not undo that.
describe("live account refresh", () => {
  const fire = async (logs: string[], slot: number): Promise<void> => {
    indexer["subscribeToSync"]();
    connection.fireLogs(
      chain.poolAddress(),
      "confirmed",
      { err: null, signature: `sig-${slot}`, logs: batch(`sig-${slot}`, BigInt(slot), logs).logs },
      slot,
    );
    await indexer["queue"];
  };

  // ADR 0016: epoch ids restart at 1 on every pool, so the Active pool's
  // epoch 1 lands beside a retired pool's, never on top of it.
  it("writes the Active pool's epoch 1 on EpochBegan beside a retired pool's epoch 1, leaving it untouched", async () => {
    await prisma.pool.create({ data: poolRecord({ address: RETIRED_POOL, poolId: 0n }) });
    const retiredEpoch = {
      poolAddress: RETIRED_POOL,
      id: 1n,
      startsAt: 0n,
      endsAt: 1n,
      status: 4,
      jackpotAmount: 5n,
      target: "0",
    };
    await prisma.epoch.create({ data: retiredEpoch });
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());

    await fire(
      [dataLine("EpochBegan", { epochId: bn(1), startsAt: bn(1_000), endsAt: bn(2_000) })],
      300,
    );

    expect(await prisma.epoch.count()).toBe(2);
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).toMatchObject({
      startsAt: 1_000n,
      jackpotAmount: 10_000_000n,
      status: 1,
    });
    expect(
      await prisma.epoch.findUniqueOrThrow({
        where: { poolAddress_id: { poolAddress: RETIRED_POOL, id: 1n } },
      }),
    ).toMatchObject({ startsAt: 0n, endsAt: 1n, jackpotAmount: 5n, status: 4 });
  });

  // ADR 0016: a brand-new pool on an empty database. A live event landing
  // before the first sweep has no Pool row for its foreign key, so it is left
  // to catch-up, and the first tick writes the Pool before the Event and
  // Cursor that reference it.
  it("on an empty database, the first tick writes the Pool before a live event that arrived ahead of it", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["subscribeToLogs"]();
    connection.fireLogs(
      chain.poolAddress(),
      "finalized",
      { err: null, signature: "sig-early", logs: batch("sig-early", 0n, [deposited]).logs },
      90,
    );
    await indexer["queue"];
    expect(await prisma.event.count()).toBe(0);

    connection.signaturesForAddress = [
      { signature: "sig-early", slot: 90, err: null, blockTime: 1_700_000_090 },
    ];
    connection.setTransaction("sig-early", batch("sig-early", 90n, [deposited]).logs);
    await indexer.tick();

    // tick() only clears the failure it recorded when the whole tick succeeded.
    expect(indexer["lastFailure"]).toBeUndefined();
    await prisma.pool.findUniqueOrThrow({ where: { address: active() } });
    expect(await prisma.event.findMany()).toMatchObject([
      { signature: "sig-early", poolAddress: active() },
    ]);
    expect(
      await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } }),
    ).toMatchObject({ lastSignature: "sig-early", lastSlot: 90n });
  });

  it("re-reads the accounts one log names, in a single call, and writes them", async () => {
    const round = chain.roundAddress(4n);
    await put("pool", chain.poolAddress(), poolAccount({ openRoundId: bn(4), nextRoundId: bn(5) }));
    await put("epoch", chain.epochAddress(2n), epochAccount({ epochId: bn(2) }));
    await put("round", round, roundAccount({ roundId: bn(4), epochId: bn(2) }));
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    connection.resetCalls();

    await fire([roundOpened, deposited], 300);

    expect(connection.callsTo("getMultipleAccountsInfo")).toBe(1);
    // The walk is the safety net now, not the live path: no page of it here.
    expect(connection.callsTo("_rpcRequest")).toBe(0);
    expect(await prisma.round.findUniqueOrThrow({ where: byId(4n) })).toMatchObject({
      epochId: 2n,
      status: 0,
    });
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ principal: 3_000_000n });
  });

  it("drops a Position the settle closed, without waiting for a full walk", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);

    // settle_position closed it: the account reads back as gone.
    connection.clearAccounts();
    await put("pool", chain.poolAddress(), poolAccount());
    await fire([positionSettled], 301);

    expect(await prisma.position.count()).toBe(0);
  });

  it("keeps a sweep's older snapshot from overwriting what the log path wrote", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    // The open Round is asked for by position rather than by event, so it
    // has to be one the mirror already knows about.
    await indexer.syncAccounts();

    // The live read sees the settled Round…
    await put("round", round, roundAccount({ status: 2, winningTile: 17 }));
    await fire([], 500);
    expect((await prisma.round.findUniqueOrThrow({ where: byId(1n) })).winningTile).toBe(17);

    // …and a sweep whose snapshot predates it still reports it Open. The
    // fake answers every walk from slot 100, well behind the log's 500.
    await put("round", round, roundAccount({ status: 0, winningTile: 0 }));
    await indexer.syncAccounts();

    const stored = await prisma.round.findUniqueOrThrow({ where: byId(1n) });
    expect(stored.status).toBe(2);
    expect(stored.winningTile).toBe(17);
  });

  it("lets a sweep that has caught up write again", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await indexer.syncAccounts();

    await put("round", round, roundAccount({ status: 2, winningTile: 17 }));
    await fire([], 50); // behind the fake's own sweep slot of 100

    await put("round", round, roundAccount({ status: 0, winningTile: 0 }));
    await indexer.syncAccounts();

    expect((await prisma.round.findUniqueOrThrow({ where: byId(1n) })).status).toBe(0);
    expect(indexer["freshWrites"].size).toBe(0);
  });
});

// ------------------------------------------------ live yield (ticket 14)

/** A Weight tree account holding `nodes`, the layout weight_tree.rs reads:
 *  a 56-byte header with the node count at byte 16, then 56-byte nodes. A
 *  node is its `principal_sum` and two slots of stamp, base and a u64 Ticket count.
 *  Epoch 1 is odd, so it lives in the second slot. */
function weightTreeAccount(
  nodes: { principalSum: bigint; slot: { base: bigint; weight: bigint } | null }[],
): Buffer {
  const data = Buffer.alloc(56 + nodes.length * 56);
  data.writeBigUInt64LE(BigInt(nodes.length), 16);
  nodes.forEach((node, i) => {
    const at = 56 + i * 56;
    data.writeBigUInt64LE(node.principalSum, at);
    if (node.slot === null) return;
    data.writeBigUInt64LE(1n, at + 32);
    data.writeBigUInt64LE(node.slot.base, at + 40);
    data.writeBigUInt64LE(node.slot.weight, at + 48);
  });
  return data;
}

describe("live yield mirror", () => {
  const fire = async (logs: string[], slot: number): Promise<void> => {
    indexer["subscribeToSync"]();
    connection.fireLogs(
      chain.poolAddress(),
      "confirmed",
      { err: null, signature: `sig-${slot}`, logs: batch(`sig-${slot}`, BigInt(slot), logs).logs },
      slot,
    );
    await indexer["queue"];
  };
  const E18 = 10n ** 18n;

  it("mirrors the new Pool fields and the Player's yield index and leaf", async () => {
    await put(
      "pool",
      chain.poolAddress(),
      poolAccount({
        yieldIndex: bn(E18 + E18 / 20n),
        venueValue: bn(40_000_000),
        lastSyncAt: bn(1_700_000_000),
        yieldOwed: bn(11),
        feeOwed: bn(12),
        prizeOwed: bn(13),
        deficit: bn(14),
        yieldFeeBps: 1_000,
        idleFloorBps: 500,
        idleTargetBps: 1_000,
        reserveShareCapBps: 500,
        reserveLiquidityFloorBps: 20_000,
        minVenueMove: bn(100_000_000),
        lossToleranceBps: 1,
        deployPaused: true,
        impaired: true,
        buyTicketsPaused: true,
      }),
    );
    await put(
      "player",
      chain.playerAddress(OWNER),
      playerAccount(OWNER, { yieldIndex: bn(E18), leafIndex: 3 }),
    );

    await indexer.syncAccounts();

    expect(await prisma.pool.findUniqueOrThrow({ where: { address: active() } })).toMatchObject({
      weightTree: WEIGHT_TREE.toBase58(),
      klendReserve: STRANGER.toBase58(),
      venueValue: 40_000_000n,
      lastSyncAt: 1_700_000_000n,
      yieldOwed: 11n,
      feeOwed: 12n,
      prizeOwed: 13n,
      deficit: 14n,
      yieldFeeBps: 1_000,
      idleFloorBps: 500,
      idleTargetBps: 1_000,
      reserveShareCapBps: 500,
      reserveLiquidityFloorBps: 20_000,
      minVenueMove: 100_000_000n,
      lossToleranceBps: 1,
      deployPaused: true,
      impaired: true,
      buyTicketsPaused: true,
    });
    const pool = await prisma.pool.findUniqueOrThrow({ where: { address: active() } });
    expect(pool.yieldIndex.toFixed(0)).toBe((E18 + E18 / 20n).toString());
    const player = await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) });
    expect(player.yieldIndex.toFixed(0)).toBe(E18.toString());
    expect(player.leafIndex).toBe(3);
  });

  it("stores a Yield index point for each sync, thinned to one a minute", async () => {
    const sync = async (index: bigint, at: number): Promise<void> => {
      await put("pool", chain.poolAddress(), poolAccount({ yieldIndex: bn(index), lastSyncAt: bn(at) }));
      await indexer.syncAccounts();
    };
    // A pool that never synced has no index worth a point.
    await sync(0n, 0);
    expect(await prisma.yieldIndexPoint.count()).toBe(0);

    await sync(E18, 1_000);
    await sync(E18 + 1n, 1_030); // 30 s after the last point: thinned out
    await sync(E18 + 2n, 1_060); // a minute after: stored
    await sync(E18 + 2n, 1_060); // the same sync seen again: no duplicate
    await sync(E18 + 3n, 1_100); // 40 s after the 1,060 point: thinned out

    const points = await prisma.yieldIndexPoint.findMany({ orderBy: { at: "asc" } });
    expect(points.map((point) => [point.poolAddress, point.at, point.yieldIndex.toFixed(0)])).toEqual([
      [active(), 1_000n, E18.toString()],
      [active(), 1_060n, (E18 + 2n).toString()],
    ]);
  });

  it("writes the Yield index point from a live log too", async () => {
    await put("pool", chain.poolAddress(), poolAccount({ yieldIndex: bn(E18), lastSyncAt: bn(5_000) }));
    await fire([], 400);
    expect((await prisma.yieldIndexPoint.findMany()).map((point) => point.at)).toEqual([5_000n]);
  });

  it("mirrors the Weight tree's header and the root of the current epoch", async () => {
    // Epoch 1 runs 1,000 s. Leaf 1 sat idle at Principal 7 (7 x 1,000 = 7,000);
    // Fenwick node 2 holds leaves 1 and 2 together: 7,000 + 2,500.
    connection.setAccount(
      WEIGHT_TREE,
      weightTreeAccount([
        { principalSum: 7n, slot: null },
        { principalSum: 9n, slot: { base: 9n, weight: 9_500n } },
      ]),
    );
    await put("pool", chain.poolAddress(), poolAccount());

    await indexer.syncAccounts();

    expect(await prisma.weightTreeState.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      nodeCount: 2n,
      epochId: 1n,
    });
    expect(
      (await prisma.weightTreeState.findUniqueOrThrow({ where: { poolAddress: active() } })).rootWeight.toFixed(0),
    ).toBe("9500");
  });

  it("still mirrors the Pool when the tree account cannot be read, and keeps the last tree state", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.syncAccounts();

    expect(await prisma.pool.count()).toBe(1);
    expect(await prisma.weightTreeState.count()).toBe(0);
  });

  it("stores each live-yield event under the Active pool, with its figures exact", async () => {
    const pool = chain.poolAddress();
    const lines = [
      dataLine("Synced", {
        pool,
        gain: bn(1_000),
        fee: bn(100),
        depositorShare: bn(700),
        prizeShare: bn(150),
        yieldIndex: bn(E18 * 4n),
        venueValue: bn(40_000_000),
        deficitRepaid: bn(50),
      }),
      dataLine("Withdrawn", {
        owner: OWNER,
        amount: bn(480),
        principal: bn(2_500),
        entries: bn(2_400),
      }),
      dataLine("VenueDeployed", { pool, amount: bn(40_000_000), venueValue: bn(40_000_100) }),
      dataLine("VenueRecalled", { pool, amount: bn(5_000_000), venueValue: bn(35_000_100) }),
      dataLine("Harvested", {
        pool,
        gain: bn(1_000),
        fee: bn(100),
        depositorShare: bn(700),
        prizeShare: bn(150),
        feePaid: bn(99),
        prizePaid: bn(150),
      }),
      dataLine("ImpairedSet", {
        pool,
        loss: bn(900),
        prizeAbsorbed: bn(300),
        feeAbsorbed: bn(100),
        deficit: bn(500),
      }),
      dataLine("ImpairedCleared", { pool, deficit: bn(500), cause: 1 }),
      dataLine("PositionSettled", { roundId: bn(1), owner: OWNER, reward: bn(0), refund: bn(250) }),
    ];
    await seedActivePool();

    expect(await indexer.ingestLogs(batch("sig-live", 40n, lines))).toBe(lines.length);

    const events = await prisma.event.findMany({ orderBy: { index: "asc" } });
    expect(events.map((event) => [event.poolAddress, event.name])).toEqual(
      [
        "Synced",
        "Withdrawn",
        "VenueDeployed",
        "VenueRecalled",
        "Harvested",
        "ImpairedSet",
        "ImpairedCleared",
        "PositionSettled",
      ].map((name) => [active(), name]),
    );
    expect(events[0]?.data).toMatchObject({ yieldIndex: (E18 * 4n).toString(), depositorShare: "700" });
    expect(events[1]?.data).toMatchObject({ amount: "480", principal: "2500" });
    expect(events[7]?.data).toMatchObject({ refund: "250", reward: "0" });
  });

  it("re-reads the Player a Withdrawn names, without a sweep", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER, { principal: bn(2_500) }));

    await fire(
      [
        dataLine("Withdrawn", {
          owner: OWNER,
          amount: bn(500),
          principal: bn(2_500),
          entries: bn(2_500),
        }),
      ],
      410,
    );

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) })).toMatchObject({
      principal: 2_500n,
    });
  });
});

// -------------------------------------------------------- operator reads

describe("operator queries", () => {
  const ALICE = Keypair.generate().publicKey.toBase58();
  const BOB = Keypair.generate().publicKey.toBase58();
  const CAROL = Keypair.generate().publicKey.toBase58();
  const DAVE = Keypair.generate().publicKey.toBase58();

  const player = (owner: string, overrides: object = {}) => ({
    poolAddress: active(),
    owner,
    principal: 0n,
    entries: 0n,
    epochId: 5n,
    isHouse: false,
    pendingWithdraw: 0n,
    pendingEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    bonusEpoch: 0n,
    bonusGranted: 0n,
    ...overrides,
  });

  beforeEach(async () => {
    await seedActivePool();
    await prisma.epoch.create({
      data: {
        poolAddress: active(),
        id: 5n,
        startsAt: 1_000n,
        endsAt: 2_000n,
        status: 1,
        jackpotAmount: 0n,
        target: "0",
      },
    });
    await prisma.player.createMany({
      data: [
        player(ALICE, { entries: 3n }),
        player(BOB),
        player(CAROL, { entries: 9n }),
        player(DAVE, { epochId: 3n, principal: 2n }),
      ],
    });
  });

  it("finds the round the operator may still act on", async () => {
    await prisma.round.createMany({
      data: [
        { poolAddress: active(), id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] },
        { poolAddress: active(), id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, houseCut: 0n, tileTotals: [] },
      ],
    });
    expect(await indexer.getOpenRound()).toMatchObject({ id: 2n, status: 1 });
  });

  it("lists positions across every round that has reached a terminal status", async () => {
    await prisma.round.createMany({
      data: [
        { poolAddress: active(), id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] }, // Settled
        { poolAddress: active(), id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, houseCut: 0n, tileTotals: [] }, // Requested: still live
        { poolAddress: active(), id: 3n, epochId: 5n, startsAt: 120n, endsAt: 180n, status: 4, pot: 0n, houseCut: 0n, tileTotals: [] }, // Voided
      ],
    });
    await prisma.position.createMany({
      data: [
        { poolAddress: active(), address: "pos-a", owner: ALICE, roundId: 1n, tiles: 1n, stakePerTile: 1n },
        { poolAddress: active(), address: "pos-b", owner: BOB, roundId: 2n, tiles: 1n, stakePerTile: 1n },
        { poolAddress: active(), address: "pos-c", owner: CAROL, roundId: 3n, tiles: 1n, stakePerTile: 1n },
      ],
    });
    const positions = await indexer.unsettledPositions();
    expect(positions.sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      { address: "pos-a", owner: ALICE, roundId: 1n },
      { address: "pos-c", owner: CAROL, roundId: 3n },
    ]);
  });

  it("lists terminal, not-yet-closed rounds with nothing left owed on them", async () => {
    await prisma.round.createMany({
      data: [
        { poolAddress: active(), id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] }, // Settled, still has a Position
        { poolAddress: active(), id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] }, // Settled, clear
        { poolAddress: active(), id: 3n, epochId: 5n, startsAt: 120n, endsAt: 180n, status: 1, pot: 5n, houseCut: 0n, tileTotals: [] }, // Requested: still live
        { poolAddress: active(), id: 4n, epochId: 5n, startsAt: 180n, endsAt: 240n, status: 4, pot: 0n, houseCut: 0n, tileTotals: [], closed: true }, // Voided, already closed
      ],
    });
    await prisma.position.create({
      data: { poolAddress: active(), address: "pos-a", owner: ALICE, roundId: 1n, tiles: 1n, stakePerTile: 1n },
    });
    expect(await indexer.roundsToClose()).toEqual([2n]);
  });

  it("reads a single epoch and every player", async () => {
    expect(await indexer.getEpoch(5n)).toMatchObject({ id: 5n, status: 1 });
    expect(await indexer.getEpoch(6n)).toBeNull();
    expect((await indexer.getPlayers()).length).toBe(4);
  });

  // ADR 0016: a retired pool's rows share the tables but never reach the
  // operator.
  it("never hands the operator a retired pool's epoch, player or round", async () => {
    await prisma.pool.create({ data: poolRecord({ address: RETIRED_POOL, poolId: 0n }) });
    await prisma.epoch.create({
      data: {
        poolAddress: RETIRED_POOL,
        id: 6n,
        startsAt: 0n,
        endsAt: 1n,
        status: 1,
        jackpotAmount: 0n,
        target: "0",
      },
    });
    await prisma.player.create({
      data: player(Keypair.generate().publicKey.toBase58(), { poolAddress: RETIRED_POOL, entries: 9n }),
    });
    await prisma.round.create({
      data: {
        poolAddress: RETIRED_POOL,
        id: 9n,
        epochId: 6n,
        startsAt: 0n,
        endsAt: 60n,
        status: 0,
        pot: 0n,
        houseCut: 0n,
        tileTotals: [],
      },
    });

    expect(await indexer.getEpoch(6n)).toBeNull();
    expect((await indexer.getPlayers()).length).toBe(4);
    expect(await indexer.getOpenRound()).toBeNull();
  });
});

// docs/plan/hexo-referrals ticket 07: aboveSince tracks off the events
// themselves, not the live Player mirror, so events out of real-time order
// (a dip and a restore inside one batch) still cross the threshold twice.
describe("referral qualification", () => {
  const referee = OWNER.toBase58();

  beforeEach(seedActivePool);

  async function seedReferral(overrides: object = {}): Promise<void> {
    await prisma.referral.create({
      data: {
        referee,
        referrer: STRANGER.toBase58(),
        code: "ABCD2345",
        boundAt: 0n,
        aboveSince: null,
        principal: 0n,
        ...overrides,
      },
    });
  }

  it("ignores a Principal-changing event for a wallet with no Referral row", async () => {
    expect(await indexer.ingestLogs(batch("sig-noref", 1n, [depositedFor(OWNER, 60_000_000, 60_000_000, 60_000_000)]))).toBe(1);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("crosses up through 50 USDC on a deposit and stamps aboveSince", async () => {
    await seedReferral();
    await indexer.ingestLogs(
      batch("sig-cross", 1n, [depositedFor(OWNER, 60_000_000, 60_000_000, 60_000_000)]),
    );
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(60_000_000n);
    expect(row.aboveSince).toBe(1_700_000_000n); // batch()'s fixed block time
  });

  it("a refund dropping Principal below 50 USDC clears aboveSince", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    await indexer.ingestLogs(
      batch("sig-withdraw", 1n, [withdrawRequestedFor(OWNER, 20_000_000, 20_000_000)]),
    );
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(40_000_000n);
    expect(row.aboveSince).toBeNull();
  });

  it("a processed withdrawal takes Principal to the figure it carries, and below 50 USDC clears aboveSince", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    await indexer.ingestLogs(
      batch("sig-withdrawn", 1n, [withdrawnFor(OWNER, 20_000_000, 40_000_007)]),
    );
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(40_000_007n);
    expect(row.aboveSince).toBeNull();
  });

  it("a compounded JackpotPaid adds to Principal; an uncompounded one is ignored", async () => {
    await seedReferral({ principal: 40_000_000n });
    await indexer.ingestLogs(
      batch("sig-jackpot-un", 1n, [jackpotPaidFor(OWNER, 20_000_000, false)]),
    );
    expect((await prisma.referral.findUniqueOrThrow({ where: { referee } })).principal).toBe(
      40_000_000n,
    );

    await indexer.ingestLogs(batch("sig-jackpot-comp", 2n, [jackpotPaidFor(OWNER, 20_000_000, true)]));
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(60_000_000n);
    expect(row.aboveSince).toBe(1_700_000_000n);
  });

  it("a dip then a restore in the same batch crosses twice, in order", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    // One transaction's logs carry both events (e.g. a withdrawal request
    // immediately followed, in the same batch, by a deposit): the reducer
    // must apply them in emission order, not net them into one delta.
    await indexer.ingestLogs(
      batch("sig-diprestore", 1n, [
        withdrawRequestedFor(OWNER, 15_000_000, 15_000_000),
        depositedFor(OWNER, 25_000_000, 55_000_000, 55_000_000),
      ]),
    );
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(55_000_000n);
    // The restore is what set it, at this batch's block time; a naive
    // net-delta computation (60m -> 55m, still above) would have left the
    // original aboveSince untouched instead of restarting the clock.
    expect(row.aboveSince).toBe(1_700_000_000n);
  });

  it("replaying an already-ingested batch is a no-op (idempotent on the cursor)", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    const withdraw = batch("sig-replay", 1n, [withdrawRequestedFor(OWNER, 20_000_000, 20_000_000)]);
    await indexer.ingestLogs(withdraw);
    expect(await indexer.ingestLogs(withdraw)).toBe(0);
    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(40_000_000n);
    expect(row.aboveSince).toBeNull();
  });

  // ticket 13's security review: a finalized-catch-up sweep (after downtime)
  // used to enqueue one signature at a time, so a live event for the same
  // referee could be scheduled between two still-unprocessed backlog
  // signatures, applying it before an older delta that chronologically
  // precedes it. Principal-changing deltas are order-sensitive, unlike the
  // idempotent position/invite-code side effects elsewhere in persist().
  it("never applies a live event between two backlog signatures for the same referee", async () => {
    await seedReferral();

    // The backlog getSignaturesForAddress would answer with after downtime:
    // newest first, per the real RPC's own ordering (catchUpEvents reverses
    // it before replaying).
    connection.signaturesForAddress = [
      { signature: "sig-mid", slot: 20, err: null, blockTime: 1_100 },
      { signature: "sig-old", slot: 10, err: null, blockTime: 1_000 },
    ];
    connection.setTransaction(
      "sig-old",
      batch("sig-old", 10n, [depositedFor(OWNER, 60_000_000, 60_000_000, 60_000_000)]).logs,
    );
    connection.setTransaction(
      "sig-mid",
      batch("sig-mid", 20n, [withdrawRequestedFor(OWNER, 15_000_000, 45_000_000)]).logs,
    );
    // Opens a window between sig-old settling and sig-mid being enqueued for
    // the live event below to race into.
    connection.getTransactionDelayMs = 20;
    indexer["lastSyncedSlot"] = 100n; // the first sweep has landed
    indexer["subscribeToLogs"]();
    // The live path timestamps from the chain clock the indexer last
    // observed, not from fireLogs' own arguments (see subscribeToLogs).
    chain.recordChainTime(1_200n);

    const catchUp = indexer["catchUpEvents"]();
    await new Promise((resolve) => setTimeout(resolve, 5));
    connection.fireLogs(
      chain.poolAddress(),
      "finalized",
      {
        err: null,
        signature: "sig-live",
        logs: batch("sig-live", 30n, [depositedFor(OWNER, 80_000_000, 80_000_000, 80_000_000)]).logs,
      },
      30,
    );
    await catchUp;
    await indexer["queue"];

    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    // Chronological order is old (cross up) -> mid (drops back below 50
    // USDC, clearing aboveSince) -> live (crosses up again, restarting the
    // clock at its own block time). A live event landing between the two
    // backlog signatures would skip the dip and leave `aboveSince` at the
    // old crossing instead.
    expect(row.principal).toBe(80_000_000n);
    expect(row.aboveSince).toBe(1_200n);
  });

  // beta-launch-fixes ticket 08: a missed Principal-changing event (a
  // websocket gap) leaves the Referral row overstating a referee's
  // Principal until something else happens to touch it; a full sweep must
  // self-heal that against the mirrored Player.
  it("a full sweep reconciles a Referral's Principal against the mirrored Player and clears aboveSince if it now falls below the threshold", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    await put("pool", chain.poolAddress(), poolAccount());
    await put(
      "player",
      chain.playerAddress(OWNER),
      playerAccount(OWNER, { principal: bn(10_000_000) }),
    );
    indexer["lastSyncedSlot"] = undefined; // force a full walk

    await indexer.syncAccounts();

    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(10_000_000n);
    expect(row.aboveSince).toBeNull();
  });

  it("a full sweep leaves a Referral untouched when its Principal already matches the mirrored Player", async () => {
    await seedReferral({ principal: 3_000_000n, aboveSince: null });
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER)); // default principal 3,000,000
    indexer["lastSyncedSlot"] = undefined;

    await indexer.syncAccounts();

    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(3_000_000n);
    expect(row.aboveSince).toBeNull();
  });

  it("an incremental (non-full) sweep does not reconcile Referral Principal", async () => {
    await seedReferral({ principal: 60_000_000n, aboveSince: 1_600_000_000n });
    await put("pool", chain.poolAddress(), poolAccount());
    await put(
      "player",
      chain.playerAddress(OWNER),
      playerAccount(OWNER, { principal: bn(10_000_000) }),
    );
    indexer["lastSyncedSlot"] = undefined;
    await indexer.syncAccounts(); // first sweep is always full; get past it

    // Reset the Referral row back to its drifted state, then run a sweep
    // that is now incremental (lastSyncedSlot is set from the sweep above).
    await prisma.referral.update({
      where: { referee },
      data: { principal: 60_000_000n, aboveSince: 1_600_000_000n },
    });
    await indexer.syncAccounts();

    const row = await prisma.referral.findUniqueOrThrow({ where: { referee } });
    expect(row.principal).toBe(60_000_000n);
    expect(row.aboveSince).toBe(1_600_000_000n);
  });
});

// docs/plan/hexo-referrals ticket 08: computeBonuses' inputs and the
// ReferralGrant bookkeeping around it, against a real Postgres.
describe("referral bonus job (ticket 08)", () => {
  const EPOCH_ID = 9n;
  const REFERRER = Keypair.generate().publicKey.toBase58();
  const WELL_PAST = 0n; // 1970: far more than REFERRAL_QUALIFY_SECONDS ago.

  const referrerPlayer = (owner: string, overrides: object = {}) => ({
    poolAddress: active(),
    owner,
    principal: 1_000_000_000_000n, // ample, so the referrer's own 1x cap never binds
    entries: 0n,
    epochId: 0n,
    isHouse: false,
    pendingWithdraw: 0n,
    pendingEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    bonusEpoch: 0n,
    bonusGranted: 0n,
    ...overrides,
  });

  async function seedQualifiedReferral(overrides: object = {}): Promise<void> {
    await prisma.referral.create({
      data: {
        referee: Keypair.generate().publicKey.toBase58(),
        referrer: REFERRER,
        code: "ABCD9999",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 100_000_000n, // 100 USDC
        ...overrides,
      },
    });
  }

  beforeEach(async () => {
    // poolRecord's defaults (ample totalPrincipal, 100% bonusCapBps) keep the
    // pool cap from binding unless a test overrides them.
    await prisma.pool.create({ data: poolRecord({ currentEpochId: EPOCH_ID }) });
  });

  // ADR 0016: epoch ids restart on every pool. Keyed by epoch alone,
  // skipDuplicates would drop the Active pool's grant because a retired
  // pool already holds a row for the same (epoch, referrer), and that row's
  // amount would count against this epoch's pool cap.
  it("writes the Active pool's grant for an epoch and referrer a retired pool already has a grant for", async () => {
    await prisma.pool.create({ data: poolRecord({ address: RETIRED_POOL, poolId: 0n }) });
    const retiredGrant = {
      poolAddress: RETIRED_POOL,
      epochId: EPOCH_ID,
      referrer: REFERRER,
      amount: 7n,
      uncapped: 7n,
      qualifiedCount: 1,
      rateBps: 200,
      txSig: "sig-retired",
    };
    await prisma.referralGrant.create({ data: retiredGrant });
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    await seedQualifiedReferral();

    expect(await indexer.referralGrantsDue(EPOCH_ID)).toEqual([
      { referrer: REFERRER, amount: 2_000_000n },
    ]);
    await indexer.markReferralGrantsSent(EPOCH_ID, [REFERRER], "sig-active");

    expect(
      await prisma.referralGrant.findUniqueOrThrow({
        where: {
          poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER },
        },
      }),
    ).toMatchObject({ amount: 2_000_000n, txSig: "sig-active" });
    expect(
      await prisma.referralGrant.findUniqueOrThrow({
        where: {
          poolAddress_epochId_referrer: { poolAddress: RETIRED_POOL, epochId: EPOCH_ID, referrer: REFERRER },
        },
      }),
    ).toMatchObject(retiredGrant);
    expect(await prisma.referralGrantShare.findMany()).toMatchObject([
      { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER, amount: 2_000_000n },
    ]);
  });

  it("computes a qualifying referrer's bonus, records it, and hands it back unsent", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    await seedQualifiedReferral();

    const due = await indexer.referralGrantsDue(EPOCH_ID);
    expect(due).toEqual([{ referrer: REFERRER, amount: 2_000_000n }]); // 100 USDC * 2%

    const row = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    expect(row).toMatchObject({
      amount: 2_000_000n,
      // referral-page ticket 04: the own-Principal cap and pool cap are both
      // ample here (referrerPlayer's default Principal, poolRow's default
      // bonusCapBps), so uncapped equals amount.
      uncapped: 2_000_000n,
      qualifiedCount: 1,
      rateBps: 200,
      txSig: null,
    });
  });

  it("records uncapped as the raw grant when the referrer's own Principal caps amount, and it stays idempotent across restarts", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER, { principal: 10_000_000n }) }); // $10
    for (let i = 0; i < 11; i++) {
      await seedQualifiedReferral({ principal: 2_500_000_000n }); // $2,500 each, 11 -> 5% tier
    }

    const first = await indexer.referralGrantsDue(EPOCH_ID);
    expect(first).toEqual([{ referrer: REFERRER, amount: 10_000_000n }]); // capped at the $10 Principal

    const row = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    expect(row.uncapped).toBe(1_375_000_000n); // 5% of 11 * $2,500 raw, uncapped by the $10 cap

    // A later Principal move re-clamps `amount` (see the test above this
    // one) but must not touch the already-recorded `uncapped`: it stays
    // idempotent across restarts / repeated ticks the same way amount's own
    // recorded qualifiedCount and rateBps do.
    await prisma.player.update({ where: byOwner(REFERRER), data: { principal: 5_000_000n } });
    await indexer.referralGrantsDue(EPOCH_ID);

    const after = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    expect(after.uncapped).toBe(1_375_000_000n);
  });

  it("a referral not yet qualified earns its referrer nothing", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    await seedQualifiedReferral({ aboveSince: null });

    expect(await indexer.referralGrantsDue(EPOCH_ID)).toEqual([]);
    expect(await prisma.referralGrant.count()).toBe(0);
  });

  it("a referrer with no Player earns nothing", async () => {
    await seedQualifiedReferral();
    expect(await indexer.referralGrantsDue(EPOCH_ID)).toEqual([]);
  });

  it("is idempotent: the recorded amount does not change on a second call even if Principal moves", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    await seedQualifiedReferral();

    const first = await indexer.referralGrantsDue(EPOCH_ID);
    await prisma.referral.updateMany({
      where: { referrer: REFERRER },
      data: { principal: 900_000_000n }, // would compute a different bonus if reapplied
    });
    const second = await indexer.referralGrantsDue(EPOCH_ID);

    expect(second).toEqual(first);
    expect(await prisma.referralGrant.count()).toBe(1);
  });

  it("re-clamps an already-recorded amount, and persists the drop, when the referrer's own Principal falls before it is sent", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER, { principal: 1_000_000_000n }) }); // 1,000 USDC
    for (let i = 0; i < 11; i++) {
      await seedQualifiedReferral({ principal: 2_500_000_000n }); // $2,500 each, 11 qualified -> 5% tier
    }

    const first = await indexer.referralGrantsDue(EPOCH_ID);
    // Raw would be 5% of 11 * $2,500 = $1,375; capped at the referrer's own
    // $1,000 Principal, not the raw figure.
    expect(first).toEqual([{ referrer: REFERRER, amount: 1_000_000_000n }]);

    // The referrer withdraws before the operator actually gets to send it.
    await prisma.player.update({
      where: byOwner(REFERRER),
      data: { principal: 10_000_000n }, // 10 USDC
    });

    const second = await indexer.referralGrantsDue(EPOCH_ID);
    expect(second).toEqual([{ referrer: REFERRER, amount: 10_000_000n }]);

    const row = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    // The record itself reflects the re-clamp, not just what was returned:
    // ticket 11 reads this row as "today's bonus".
    expect(row.amount).toBe(10_000_000n);
  });

  it("clamping all the way to 0 drops the referrer from what is due and zeroes the recorded amount", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER, { principal: 100_000_000n }) });
    await seedQualifiedReferral();
    await indexer.referralGrantsDue(EPOCH_ID);

    await prisma.player.update({ where: byOwner(REFERRER), data: { principal: 0n } });

    expect(await indexer.referralGrantsDue(EPOCH_ID)).toEqual([]);
    const row = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    expect(row.amount).toBe(0n);
  });

  it("skips a referrer whose on-chain bonus_epoch already covers this epoch (a crash between send and markReferralGrantsSent)", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    await seedQualifiedReferral();
    await indexer.referralGrantsDue(EPOCH_ID); // records the row, txSig still null

    await prisma.player.update({
      where: byOwner(REFERRER),
      data: { bonusEpoch: EPOCH_ID }, // the grant already landed on chain
    });

    expect(await indexer.referralGrantsDue(EPOCH_ID)).toEqual([]);
  });

  it("markReferralGrantsSent fills in the signature for exactly the referrers given", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    await prisma.player.createMany({
      data: [referrerPlayer(REFERRER), referrerPlayer(other)],
    });
    await seedQualifiedReferral();
    await prisma.referral.create({
      data: {
        referee: Keypair.generate().publicKey.toBase58(),
        referrer: other,
        code: "ABCD8888",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 100_000_000n,
      },
    });
    await indexer.referralGrantsDue(EPOCH_ID);

    await indexer.markReferralGrantsSent(EPOCH_ID, [REFERRER], "sig-1");

    const sent = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    const unsent = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: other } },
    });
    expect(sent.txSig).toBe("sig-1");
    expect(unsent.txSig).toBeNull();
  });

  // referral-page ticket 05: ReferralGrantShare, written alongside
  // ReferralGrant with the same idempotency, and rescaled by the same
  // re-clamp loop.
  it("writes a share row per qualified referee, proportional to their own basis, summing to the grant", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    const big = Keypair.generate().publicKey.toBase58();
    const small = Keypair.generate().publicKey.toBase58();
    await prisma.referral.create({
      data: {
        referee: big,
        referrer: REFERRER,
        code: "ABCD9999",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 300_000_000n, // 300 USDC
      },
    });
    await prisma.referral.create({
      data: {
        referee: small,
        referrer: REFERRER,
        code: "ABCD9999",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 100_000_000n, // 100 USDC
      },
    });

    await indexer.referralGrantsDue(EPOCH_ID);

    const grant = await prisma.referralGrant.findUniqueOrThrow({
      where: { poolAddress_epochId_referrer: { poolAddress: active(), epochId: EPOCH_ID, referrer: REFERRER } },
    });
    const shares = await prisma.referralGrantShare.findMany({
      where: { epochId: EPOCH_ID, referrer: REFERRER },
    });
    expect(shares.reduce((sum, share) => sum + share.amount, 0n)).toBe(grant.amount);
    // 300:100 basis -> 3:1 split, evenly (400 USDC basis, no remainder).
    const bigShare = shares.find((share) => share.referee === big)!;
    const smallShare = shares.find((share) => share.referee === small)!;
    expect(bigShare.amount).toBe((grant.amount * 3n) / 4n);
    expect(smallShare.amount).toBe(grant.amount - bigShare.amount);
  });

  it("share rows stay idempotent: a referee that only qualifies after the grant was first recorded gets no row", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER) });
    const first = Keypair.generate().publicKey.toBase58();
    await prisma.referral.create({
      data: {
        referee: first,
        referrer: REFERRER,
        code: "ABCD9999",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 100_000_000n,
      },
    });
    await indexer.referralGrantsDue(EPOCH_ID);

    const second = Keypair.generate().publicKey.toBase58();
    await prisma.referral.create({
      data: {
        referee: second,
        referrer: REFERRER,
        code: "ABCD9999",
        boundAt: 0n,
        aboveSince: WELL_PAST,
        principal: 500_000_000n,
      },
    });
    await indexer.referralGrantsDue(EPOCH_ID);

    const shares = await prisma.referralGrantShare.findMany({
      where: { epochId: EPOCH_ID, referrer: REFERRER },
    });
    expect(shares).toHaveLength(1);
    expect(shares[0]!.referee).toBe(first);
  });

  it("re-clamp rescales share rows to the new amount, still summing exactly", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER, { principal: 1_000_000_000n }) }); // $1,000
    for (let i = 0; i < 11; i++) {
      await prisma.referral.create({
        data: {
          referee: Keypair.generate().publicKey.toBase58(),
          referrer: REFERRER,
          code: "ABCD9999",
          boundAt: 0n,
          aboveSince: WELL_PAST,
          principal: 2_500_000_000n, // $2,500 each, 11 -> 5% tier
        },
      });
    }

    await indexer.referralGrantsDue(EPOCH_ID); // capped at the $1,000 Principal

    const before = await prisma.referralGrantShare.findMany({
      where: { epochId: EPOCH_ID, referrer: REFERRER },
    });
    expect(before.reduce((sum, share) => sum + share.amount, 0n)).toBe(1_000_000_000n);

    await prisma.player.update({ where: byOwner(REFERRER), data: { principal: 10_000_000n } }); // $10
    await indexer.referralGrantsDue(EPOCH_ID);

    const after = await prisma.referralGrantShare.findMany({
      where: { epochId: EPOCH_ID, referrer: REFERRER },
    });
    // Still one row per referee: the re-clamp rescales, it doesn't drop rows.
    expect(after).toHaveLength(11);
    expect(after.reduce((sum, share) => sum + share.amount, 0n)).toBe(10_000_000n);
  });

  it("clamping all the way to 0 zeroes every share row too", async () => {
    await prisma.player.create({ data: referrerPlayer(REFERRER, { principal: 100_000_000n }) });
    await seedQualifiedReferral();
    await indexer.referralGrantsDue(EPOCH_ID);

    await prisma.player.update({ where: byOwner(REFERRER), data: { principal: 0n } });
    await indexer.referralGrantsDue(EPOCH_ID);

    const shares = await prisma.referralGrantShare.findMany({
      where: { epochId: EPOCH_ID, referrer: REFERRER },
    });
    expect(shares.length).toBeGreaterThan(0);
    expect(shares.every((share) => share.amount === 0n)).toBe(true);
  });

  // beta-launch-fixes ticket 11: the pool-wide cap is shared across the
  // whole epoch (computeBonuses' own alreadyGrantedThisEpoch parameter,
  // wired up here), so a referrer discovered on a later tick is scaled
  // against the remaining headroom instead of the full cap recomputed
  // fresh, which used to compute an amount the on-chain call then refused.
  it("scales a later-qualifying referrer against the headroom an earlier grant already used", async () => {
    await prisma.pool.update({
      where: { address: chain.poolAddress().toBase58() },
      data: { totalPrincipal: 3_000_000_000n, bonusCapBps: 500 }, // 5% of $3,000 = $150 pool cap
    });
    const other = Keypair.generate().publicKey.toBase58();
    await prisma.player.createMany({
      data: [referrerPlayer(REFERRER), referrerPlayer(other)],
    });
    for (let i = 0; i < 3; i++) {
      await seedQualifiedReferral({ principal: 1_000_000_000n }); // $1,000 each, 3 -> 3% tier
    }

    // First tick: only REFERRER qualifies yet. Raw 3% of $3,000 = $90,
    // well within the $150 pool cap.
    const first = await indexer.referralGrantsDue(EPOCH_ID);
    expect(first).toEqual([{ referrer: REFERRER, amount: 90_000_000n }]);

    // Later the same epoch, `other` also qualifies with the same shape of
    // referrals. Only $60 of the $150 pool cap is left ($150 - $90 already
    // recorded for REFERRER), so `other`'s raw $90 is scaled down to fit.
    for (let i = 0; i < 3; i++) {
      await prisma.referral.create({
        data: {
          referee: Keypair.generate().publicKey.toBase58(),
          referrer: other,
          code: `LATE${i}`.padEnd(8, "0"),
          boundAt: 0n,
          aboveSince: WELL_PAST,
          principal: 1_000_000_000n,
        },
      });
    }
    const second = await indexer.referralGrantsDue(EPOCH_ID);
    expect(second).toEqual(
      expect.arrayContaining([
        { referrer: REFERRER, amount: 90_000_000n }, // unchanged: frozen once recorded
        { referrer: other, amount: 60_000_000n }, // scaled to the remaining headroom
      ]),
    );
    expect(second).toHaveLength(2);
  });

  // ticket 11: the pending-grants query has a deterministic order.
  it("returns pending grants in a deterministic (referrer-ascending) order", async () => {
    const referrers = ["c", "a", "b"].map(() => Keypair.generate().publicKey.toBase58());
    await prisma.player.createMany({ data: referrers.map((owner) => referrerPlayer(owner)) });
    for (const referrer of referrers) {
      await prisma.referral.create({
        data: {
          referee: Keypair.generate().publicKey.toBase58(),
          referrer,
          code: referrer.slice(0, 8).padEnd(8, "0").toUpperCase(),
          boundAt: 0n,
          aboveSince: WELL_PAST,
          principal: 100_000_000n,
        },
      });
    }

    const due = await indexer.referralGrantsDue(EPOCH_ID);
    const sorted = [...due.map((d) => d.referrer)].sort();
    expect(due.map((d) => d.referrer)).toEqual(sorted);
  });
});
});
