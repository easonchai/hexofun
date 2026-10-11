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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bindReferral } from "../api/referral-code";
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "../api/invite-code";
import { ChainService } from "../chain/chain.service";
import { withRpcFallback } from "../chain/rpc-fallback";
import type { HexVaultEnv } from "../config/env";
import { loadIdl } from "../chain/idl";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { settleRows } from "../api/round-settle";
import { VENUE_KIND } from "../chain/venue-kind";
import { OperatorInstructions } from "../operator/instructions";
import type { PoolState } from "../operator/chain-state";
import { winnerProof } from "../snapshot/epoch-draw";
import { checkLedgerIfDue, countLedgerMismatches, LEDGER_CHECK_INTERVAL_S, principalDrift } from "../ledger/ledger-store";
import { buildSumTree } from "../snapshot/sum-tree";
import { decodeEventLogs } from "./decode";
import { IndexerService, type LogBatch } from "./indexer.service";
import type { SubgraphSource, SubgraphTransaction } from "./subgraph";

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
  };
  // SAFETY: ChainService reads the four keys above through `get`.
  const config = {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
  // SAFETY: the fake stands in for the RPC calls the indexer makes; this
  // suite drives no code path that reaches any other Connection method.
  chain = new ChainService(connection as unknown as Connection, config);
  indexer = new IndexerService(prisma, chain);
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
  indexer["housePin"] = undefined;
  await wipe();
});

async function wipe(): Promise<void> {
  // Pool goes last: every pool-scoped table references it, onDelete Restrict.
  await prisma.$transaction([
    prisma.event.deleteMany(),
    prisma.ticketLedger.deleteMany(),
    prisma.ticketBalance.deleteMany(),
    prisma.epochSnapshot.deleteMany(),
    prisma.ledgerCheck.deleteMany(),
    prisma.truncatedLog.deleteMany(),
    prisma.gameConfig.deleteMany(),
    prisma.cursor.deleteMany(),
    prisma.venueProposal.deleteMany(),
    prisma.player.deleteMany(),
    prisma.epoch.deleteMany(),
    prisma.yieldIndexPoint.deleteMany(),
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
  minDeposit: 1_000_000n,
  paused: false,
  currentEpochId: 1n,
  currentEpochEndsAt: 0n,
  previousEpochEndsAt: 0n,
  totalPrincipal: 100_000_000_000n, // 100,000 USDC: ample, no pool cap bind
  pendingWithdrawals: 0n,
  minJackpot: 1_000_000n,
  baseRateBps: 0,
  version: 1,
  shutdown: false,
  updatedSlot: 1n,
  ...overrides,
});

const seedActivePool = async (): Promise<void> => {
  await prisma.pool.create({ data: poolRecord() });
};

/** The Epoch row the account sync mirrors; a cutoff stores its snapshot on it. */
const seedEpoch = (id: bigint) =>
  prisma.epoch.create({
    data: { poolAddress: active(), id, startsAt: 1_000n, endsAt: 2_000n, status: 0, jackpotAmount: 0n, target: "0" },
  });

/** A Game config row; the ledger prices a `TicketsBought` from the row in force at its block time. */
const seedGameConfig = (ticketsPerUsdc: number, createdAt: bigint) =>
  prisma.gameConfig.create({
    data: {
      poolAddress: active(),
      roundSeconds: 60,
      houseCutBps: 600,
      ticketsPerUsdc,
      bonusCapBps: 500,
      referralTiers: [],
      maxTilesPerBet: 36,
      createdAt: new Date(Number(createdAt) * 1000),
    },
  });

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
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(1_000),
  currentEpochEndsAt: bn(2_000),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  totalPrincipal: bn(3_000_000),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  pendingWithdrawals: bn(0),
  minJackpot: bn(1_000_000),
  payoutTimeout: bn(86_400),
  // Ticket 14: the venue.
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

const playerAccount = (owner: PublicKey, overrides: object = {}) => ({
  owner,
  principal: bn(3_000_000),
  epochId: bn(1),
  isHouse: false,
  bump: 255,
  pendingWithdraw: bn(0),
  pendingEpoch: bn(0),
  ...overrides,
});

describe("account sync", () => {
  it("mirrors one of each account into Postgres", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));

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

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ principal: 3_000_000n, isHouse: false });
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

  // venue-switch ticket 05
  it("a migration's log read moves the mirrored pins and kind and drops the proposal row", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const old = Keypair.generate().publicKey;
    const next = Keypair.generate().publicKey;
    await put("pool", chain.poolAddress(), poolAccount({ venueKind: 0, klendReserve: old }));
    await indexer.syncAccounts();
    await prisma.venueProposal.create({
      data: {
        poolAddress: active(),
        venueKind: 1,
        klendProgram: next.toBase58(),
        klendMarket: next.toBase58(),
        klendReserve: next.toBase58(),
        klendCtoken: next.toBase58(),
        proposedAt: 1n,
        updatedSlot: 1n,
      },
    });
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: active() } })).toMatchObject({
      venueKind: 0,
      klendReserve: old.toBase58(),
    });

    // The program repinned the Pool and closed the proposal account.
    await put("pool", chain.poolAddress(), poolAccount({ venueKind: 1, klendReserve: next }));
    connection.deleteAccount(chain.venueProposalAddress());
    await indexer["refreshFromLogs"]([], 300n);

    expect(await prisma.pool.findUniqueOrThrow({ where: { address: active() } })).toMatchObject({
      venueKind: 1,
      klendReserve: next.toBase58(),
    });
    expect(await prisma.venueProposal.count()).toBe(0);
  });

  it("leaves the ledger's balance alone when a sweep re-mirrors a Player", async () => {
    // The program holds no Tickets, so the mirror must not touch what the
    // Ticket ledger keeps in TicketBalance.
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await indexer.syncAccounts();
    const owner = OWNER.toBase58();
    await prisma.ticketBalance.create({ data: { poolAddress: active(), owner, tickets: 777n, epochId: 1n } });

    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER, { principal: bn(4_000_000) }));
    await indexer.syncAccounts();

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(owner) })).toMatchObject({ principal: 4_000_000n });
    expect(await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: active(), owner } } }))
      .toMatchObject({ tickets: 777n });
  });

  it("does not delete the venue proposal by its absence from an incremental sweep", async () => {
    // A closed account and an unchanged one both look like "not returned" to
    // an incremental walk; only a log read or a full walk may remove the row.
    indexer["lastSyncedSlot"] = undefined;
    const proposal = chain.venueProposalAddress();
    await put("pool", chain.poolAddress(), poolAccount());
    await put("venueProposal", proposal, {
      pool: chain.poolAddress(),
      venueKind: 2,
      klendProgram: STRANGER,
      klendMarket: STRANGER,
      klendReserve: STRANGER,
      klendCtoken: STRANGER,
      proposedAt: bn(1_800_000_000),
      bump: 255,
    });
    await indexer.syncAccounts();
    expect(await prisma.venueProposal.count()).toBe(1);

    connection.deleteAccount(proposal);
    await indexer.syncAccounts();
    expect(await prisma.venueProposal.count()).toBe(1);
  });

  it("walks every page of a multi-page result into the same rows a single page would", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await put("player", chain.playerAddress(STRANGER), playerAccount(STRANGER));
    // One walk per account type (four), one account per page: the two
    // Players span two pages, so five calls.
    connection.pageSize = 1;

    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(5);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({ poolId: POOL_ID });
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).toMatchObject({ id: 1n });
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ owner: OWNER.toBase58() });
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(STRANGER.toBase58()) }))
      .toMatchObject({ owner: STRANGER.toBase58() });
  });

  it("an incremental sweep asks for changedSinceSlot and only touches the rows the RPC reports", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await indexer.syncAccounts(); // full walk, establishes lastSyncedSlot
    const syncedSlot = indexer["lastSyncedSlot"];
    if (typeof syncedSlot !== "bigint") throw new Error("expected lastSyncedSlot to be set by the full walk above");
    expect(syncedSlot).toBe(100n);

    connection.resetCalls();
    // Simulate the RPC reporting only the Pool as changed; the Epoch and the
    // Player are unchanged and so absent from this result.
    connection.clearAccounts();
    await put("pool", chain.poolAddress(), poolAccount({ totalPrincipal: bn(999) }));
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(4); // one walk per account type
    // SAFETY: the fake only ever receives [programId, config] from the indexer.
    const [, config] = connection.lastParams("getProgramAccountsV2") as [string, { changedSinceSlot?: number }];
    // The V2 index runs up to 60 slots behind its context slot (audit-2026-10-09 05).
    expect(config.changedSinceSlot).toBe(Number(syncedSlot) - 60);

    expect((await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } })).totalPrincipal)
      .toBe(999n);
    // An absence-based delete would have wiped these; they must survive.
    expect(await prisma.epoch.count()).toBe(1);
    expect(await prisma.player.count()).toBe(1);
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

  it("the counting connection: four calls (one per account type) for a full walk and for a quiet incremental sweep", async () => {
    indexer["lastSyncedSlot"] = undefined;
    indexer["lastFullWalkAt"] = 0;
    await put("pool", chain.poolAddress(), poolAccount());
    // Accounts from an abandoned program build never match a discriminator
    // filter, so the RPC never serves them and they cost no page.
    for (let i = 0; i < 6; i++) {
      connection.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));
    }
    connection.pageSize = 1;
    connection.resetCalls();

    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(4);

    connection.resetCalls();
    connection.clearAccounts();
    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(4);
  });

  it("falls back to the plain call on an RPC without getProgramAccountsV2, and stops asking for it", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const proposal = chain.venueProposalAddress();
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("venueProposal", proposal, {
      pool: chain.poolAddress(),
      venueKind: 2,
      klendProgram: STRANGER,
      klendMarket: STRANGER,
      klendReserve: STRANGER,
      klendCtoken: STRANGER,
      proposedAt: bn(1_800_000_000),
      bump: 255,
    });
    connection.noProgramAccountsV2 = true;
    connection.resetCalls();

    await indexer.syncAccounts();

    // One V2 attempt, then the plain call answers with the same rows.
    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.epoch.count()).toBe(1);
    expect(await prisma.venueProposal.count()).toBe(1);

    // A second sweep does not retry V2, and without changedSinceSlot it walks
    // everything again, so a closed proposal is still caught by its absence.
    connection.resetCalls();
    connection.deleteAccount(proposal);
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(0);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.venueProposal.count()).toBe(0);
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
    };
    // SAFETY: same shape as the suite's own beforeAll config stub.
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    const localChain = new ChainService(wrapped, config);
    const localIndexer = new IndexerService(prisma, localChain);

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
    };
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    const localChain = new ChainService(wrapped, config);
    const localIndexer = new IndexerService(prisma, localChain);

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
  yieldIndex: bn(0),
});
const epochBegan = dataLine("EpochBegan", {
  epochId: bn(2),
  startsAt: bn(1_000),
  endsAt: bn(2_000),
  yieldIndex: bn(0),
});
const epochRolledOver = dataLine("EpochRolledOver", {
  epochId: bn(1),
  jackpotAmount: bn(0),
});

// Parameterized, not fixed consts like `deposited`: ticket 07's tests build a
// different event sequence (cross up, dip, restore) per case.
const depositedFor = (owner: PublicKey, amount: number, principal: number) =>
  dataLine("Deposited", { owner, amount: bn(amount), principal: bn(principal), yieldIndex: bn(0) });
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
    principal: bn(0),
    yieldIndex: bn(0),
  });
// Live yield settles inside the money instructions and emits no event of its
// own; a processed withdrawal carries the Principal left, which is what the
// referral tracker needs.
const withdrawnFor = (owner: PublicKey, paid: number, principal: number) =>
  dataLine("Withdrawn", {
    owner,
    amount: bn(paid),
    principal: bn(principal),
    yieldIndex: bn(0),
  });
const jackpotPaidFor = (
  winner: PublicKey,
  amount: number,
  compounded: boolean,
  epochId = 1,
  isHouse = false,
) => dataLine("JackpotPaid", {
    epochId: bn(epochId),
    winner,
    amount: bn(amount),
    isHouse,
    compounded,
    principal: bn(0),
    yieldIndex: bn(0),
    index: 0,
    tickets: bn(0),
  });

describe("event ingest", () => {
  // Event, Cursor and every other row below references the Pool row, which
  // in production the first sweep writes before any event lands (see tick).
  beforeEach(seedActivePool);

  it("stores an event once when the live path reports it at a later slot", async () => {
    // Surfpool's finalized log notification carries a slot ~31 past the
    // transaction's own, which the catch-up poll reports.
    expect(await indexer.ingestLogs(batch("sig1", 10n, [deposited]))).toBe(1);
    expect(await indexer.ingestLogs(batch("sig1", 41n, [deposited]))).toBe(0);
    expect(await prisma.event.count()).toBe(1);
  });

  it("stores each event once and leaves the cursor on the newest batch", async () => {
    const first = batch("sig1", 10n, [deposited, epochBegan]);
    const second = batch("sig2", 11n, [epochRolledOver]);
    const third = batch("sig3", 12n, [deposited]);

    await seedEpoch(1n); // EpochBegan(2) snapshots epoch 1
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
      ["sig2", 0, "EpochRolledOver"],
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
      batch("sig-second-deposit", 41n, [depositedFor(OWNER, 500_000, 1_500_000)]),
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

  // solami-index 09: the webhook and the socket share `ingestPushed`, so a
  // signature both deliver is stored once and neither moves the cursor.
  it("stores a signature the webhook and onLogs both deliver once, without moving the cursor", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["lastSyncedSlot"] = 100n; // the first sweep has landed
    indexer["subscribeToLogs"]();
    const logs = batch("sig-both", 0n, [deposited]).logs;

    await indexer.ingestPushed({ signature: "sig-both", slot: 60n, logs, err: null });
    connection.fireLogs(chain.poolAddress(), "finalized", { err: null, signature: "sig-both", logs }, 60);
    await indexer["queue"];

    expect(await prisma.event.count({ where: { signature: "sig-both" } })).toBe(1);
    expect(await prisma.cursor.findUnique({ where: { poolAddress: active() } })).toBeNull();
  });

  // A simulateTransaction's logs reach logsSubscribe under the all-ones
  // signature; the web app simulates every send, so storing it double-counted
  // the player's action (mainnet 2026-10-11, +$1.00 earnings after a withdraw).
  it("stores nothing from a simulated transaction's logs", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["lastSyncedSlot"] = 100n;
    indexer["subscribeToLogs"]();
    const simulated = "1".repeat(64);
    const logs = batch(simulated, 0n, [deposited]).logs;

    connection.fireLogs(chain.poolAddress(), "finalized", { err: null, signature: simulated, logs }, 62);
    await indexer["queue"];

    expect(await prisma.event.count({ where: { signature: simulated } })).toBe(0);
  });

  it("stores nothing from a pushed transaction that failed", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    indexer["lastSyncedSlot"] = 100n;
    const logs = batch("sig-failed", 0n, [deposited]).logs;

    await indexer.ingestPushed({ signature: "sig-failed", slot: 61n, logs, err: { InstructionError: [0, { Custom: 1 }] } });

    expect(await prisma.event.count({ where: { signature: "sig-failed" } })).toBe(0);
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
      batch("sig-gap", 10n, [depositedFor(STRANGER, 1, 1)]).logs,
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
        connection.setTransaction(`sig-${id}`, batch(`sig-${id}`, 1n, [epochRolledOver]).logs);
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
        connection.setTransaction(`sig-${id}`, batch(`sig-${id}`, 1n, [epochRolledOver]).logs);
      }
      await indexer["catchUpEvents"]();
      expect(await prisma.event.count()).toBe(total);

      // A fresh signature lands on top of the existing backlog.
      connection.signaturesForAddress = [
        { signature: "sig-new", slot: total + 1, err: null, blockTime: 1_700_000_000 + total + 1 },
        ...connection.signaturesForAddress,
      ];
      connection.setTransaction("sig-new", batch("sig-new", 1n, [epochRolledOver]).logs);
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

/** Solami ticket 05: answers from `rows` and `synced`, or throws `failure`. */
class FakeSubgraph implements SubgraphSource {
  synced = { slot: 1_000, live: true };
  rows: SubgraphTransaction[] = [];
  failure: Error | undefined;
  asked: { slot: bigint; pool: string }[] = [];

  syncedSlot(): Promise<{ slot: number; live: boolean }> {
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.synced);
  }

  transactionsSince(slot: bigint, pool: string): Promise<SubgraphTransaction[]> {
    this.asked.push({ slot, pool });
    return Promise.resolve(this.rows.filter((row) => row.slot >= slot));
  }
}

const subgraphRow = (signature: string, slot: bigint, lines: string[], flags: Partial<SubgraphTransaction> = {}) => ({
  signature,
  slot,
  logs: batch(signature, slot, lines).logs,
  truncated: false,
  failed: false,
  ...flags,
});

describe("subgraph catch-up (solami 05)", () => {
  const HEAD = 1_000n;
  let fake: FakeSubgraph;
  let viaSubgraph: IndexerService;

  beforeEach(async () => {
    await seedActivePool();
    fake = new FakeSubgraph();
    viaSubgraph = new IndexerService(prisma, chain, fake);
    viaSubgraph["lastSyncedSlot"] = HEAD;
  });
  afterEach(() => {
    connection.signaturesForAddress = [];
  });

  it("ingests a fresh subgraph's rows and advances the cursor with no getTransaction", async () => {
    fake.synced = { slot: Number(HEAD) - 300, live: true }; // the edge still counts as fresh
    fake.rows = [
      subgraphRow("sg-1", 10n, [epochRolledOver]),
      subgraphRow("sg-2", 11n, [deposited], { failed: true }),
    ];

    await viaSubgraph["catchUpEvents"]();

    expect(fake.asked).toEqual([{ slot: 0n, pool: active() }]);
    expect(connection.callsTo("getTransaction")).toBe(0);
    expect(connection.callsTo("getSignaturesForAddress")).toBe(0);
    // The failed row stores nothing but still moves the cursor past it.
    expect(await prisma.event.findMany()).toMatchObject([{ signature: "sg-1", name: "EpochRolledOver", ledgered: true, blockTime: null }]);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({
      lastSignature: "sg-2",
      lastSlot: 11n,
    });
  });

  it("falls back to the RPC walk when the subgraph is 301 slots behind, not Live, or throws", async () => {
    connection.signaturesForAddress = [{ signature: "rpc-1", slot: 20, err: null, blockTime: 1_700_000_020 }];
    connection.setTransaction("rpc-1", batch("rpc-1", 20n, [epochRolledOver]).logs);

    for (const setUp of [
      () => (fake.synced = { slot: Number(HEAD) - 301, live: true }),
      () => (fake.synced = { slot: Number(HEAD), live: false }),
      () => (fake.failure = new Error("subgraph query: boom")),
    ]) {
      await wipe();
      await seedActivePool();
      connection.resetCalls();
      fake = new FakeSubgraph();
      fake.rows = [subgraphRow("sg-1", 10n, [epochRolledOver])];
      setUp();
      viaSubgraph = new IndexerService(prisma, chain, fake);
      viaSubgraph["lastSyncedSlot"] = HEAD;

      await viaSubgraph["catchUpEvents"]();

      expect(fake.asked).toEqual([]);
      expect(connection.callsTo("getSignaturesForAddress")).toBe(1);
      expect((await prisma.event.findMany()).map((event) => event.signature)).toEqual(["rpc-1"]);
    }
  });

  it("skips rows at the cursor's slot a catch-up already consumed, and books one only the live feed stored", async () => {
    // a: consumed by an earlier catch-up. c: the cursor's own signature. b: the live feed's only.
    await viaSubgraph.ingestLogs(batch("a", 10n, [epochRolledOver]));
    await viaSubgraph.ingestLogs(batch("c", 10n, []));
    await viaSubgraph.ingestPushed({ signature: "b", slot: 10n, logs: batch("b", 10n, [epochRolledOver]).logs, err: null });
    fake.rows = ["a", "b", "c"].map((signature) => subgraphRow(signature, 10n, [epochRolledOver]));
    fake.rows.push(subgraphRow("d", 11n, [epochRolledOver]));
    const persisted: string[] = [];
    const persist = viaSubgraph["persist"].bind(viaSubgraph);
    viaSubgraph["persist"] = (batch, ...rest) => {
      persisted.push(batch.signature);
      return persist(batch, ...rest);
    };

    await viaSubgraph["catchUpEvents"]();

    expect(fake.asked).toEqual([{ slot: 10n, pool: active() }]);
    expect(persisted).toEqual(["b", "d"]);
    expect(await prisma.event.findMany({ where: { signature: "b" } })).toMatchObject([{ ledgered: true }]);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ lastSignature: "d" });
  });

  it("logs a source change once, not once per tick", async () => {
    const lines: string[] = [];
    viaSubgraph["logger"].log = (message: unknown) => void lines.push(String(message));

    await viaSubgraph["catchUpEvents"]();
    await viaSubgraph["catchUpEvents"]();
    fake.synced = { slot: Number(HEAD) - 301, live: true };
    await viaSubgraph["catchUpEvents"]();
    await viaSubgraph["catchUpEvents"]();
    fake.synced = { slot: Number(HEAD), live: true };
    await viaSubgraph["catchUpEvents"]();

    expect(lines).toEqual([
      "catch-up source: subgraph",
      "catch-up source: rpc (subgraph 301 slots behind)",
      "catch-up source: subgraph",
    ]);
  });
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
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(2n), epochAccount({ epochId: bn(2) }));
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    connection.resetCalls();

    await fire([epochBegan, deposited], 300);

    expect(connection.callsTo("getMultipleAccountsInfo")).toBe(1);
    // The walk is the safety net now, not the live path: no page of it here.
    expect(connection.callsTo("_rpcRequest")).toBe(0);
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(2n) })).toMatchObject({
      id: 2n,
      status: 1,
    });
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }))
      .toMatchObject({ principal: 3_000_000n });
  });

  it("keeps a sweep's older snapshot from overwriting what the log path wrote", async () => {
    const epoch = chain.epochAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", epoch, epochAccount({ status: 0 }));
    // The current epoch is asked for by position rather than by event, so it
    // has to be one the mirror already knows about.
    await indexer.syncAccounts();

    // The live read sees the epoch drawn…
    await put("epoch", epoch, epochAccount({ status: 3, target: bn(17) }));
    await fire([], 500);
    expect((await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).target.toString()).toBe("17");

    // …and a sweep whose snapshot predates it still reports it Open. The
    // fake answers every walk from slot 100, well behind the log's 500.
    await put("epoch", epoch, epochAccount({ status: 0, target: bn(0) }));
    await indexer.syncAccounts();

    const stored = await prisma.epoch.findUniqueOrThrow({ where: byId(1n) });
    expect(stored.status).toBe(3);
    expect(stored.target.toString()).toBe("17");
  });

  it("keeps a log-path write inside the index lag window from being overwritten by a sweep", async () => {
    const epoch = chain.epochAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", epoch, epochAccount({ status: 0 }));
    await indexer.syncAccounts();

    await put("epoch", epoch, epochAccount({ status: 3, target: bn(17) }));
    await fire([], 70); // the fake's sweeps run at slot 100: 30 slots behind, inside the 60 slot lag

    await put("epoch", epoch, epochAccount({ status: 0, target: bn(0) }));
    await indexer.syncAccounts();

    expect((await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).status).toBe(3);
  });

  it("lets a sweep that has caught up write again", async () => {
    const epoch = chain.epochAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", epoch, epochAccount({ status: 0 }));
    await indexer.syncAccounts();

    await put("epoch", epoch, epochAccount({ status: 3, target: bn(17) }));
    await fire([], 30); // behind the fake's own sweep slot of 100 less the 60 slot lag

    await put("epoch", epoch, epochAccount({ status: 0, target: bn(0) }));
    await indexer.syncAccounts();

    expect((await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).status).toBe(0);
    expect(indexer["freshWrites"].size).toBe(0);
  });
});

// ------------------------------------------------ live yield (ticket 14)

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

  it("mirrors the new Pool fields and the Player's yield index", async () => {
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
        jackpotReserved: bn(15),
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
      playerAccount(OWNER, { yieldIndex: bn(E18) }),
    );

    await indexer.syncAccounts();

    expect(await prisma.pool.findUniqueOrThrow({ where: { address: active() } })).toMatchObject({
      klendReserve: STRANGER.toBase58(),
      venueValue: 40_000_000n,
      lastSyncAt: 1_700_000_000n,
      yieldOwed: 11n,
      feeOwed: 12n,
      prizeOwed: 13n,
      jackpotReserved: 15n,
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
        yieldIndex: bn(E18),
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
      dataLine("TicketsBought", {
        owner: OWNER,
        epochId: bn(1),
        usdc: bn(250),
        principal: bn(2_500),
        yieldIndex: bn(E18),
      }),
    ];
    await seedActivePool();
    await seedGameConfig(10, 1_000n);

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
        "TicketsBought",
      ].map((name) => [active(), name]),
    );
    expect(events[0]?.data).toMatchObject({ yieldIndex: (E18 * 4n).toString(), depositorShare: "700" });
    expect(events[1]?.data).toMatchObject({ amount: "480", principal: "2500" });
    expect(events[1]?.data).toMatchObject({ yieldIndex: E18.toString() });
    expect(events[7]?.data).toMatchObject({ usdc: "250", principal: "2500" });
  });

  it("clears the pending amount when a WithdrawCancelled names the Player, and stores the event", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await put(
      "player",
      chain.playerAddress(OWNER),
      playerAccount(OWNER, { pendingWithdraw: bn(500), pendingEpoch: bn(3) }),
    );
    await fire([dataLine("WithdrawRequested", { owner: OWNER, amount: bn(500), pending: bn(500), pendingEpoch: bn(3), refunded: bn(0), paid: bn(0), redeemed: bn(0), principal: bn(3_000_000), yieldIndex: bn(0) })], 419);
    expect(
      await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) }),
    ).toMatchObject({ pendingWithdraw: 500n });

    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await fire(
      [dataLine("WithdrawCancelled", { owner: OWNER, amount: bn(500), pendingEpoch: bn(3), principal: bn(3_000_000), yieldIndex: bn(0) })],
      420,
    );

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) })).toMatchObject({
      principal: 3_000_000n,
      pendingWithdraw: 0n,
    });

    const cancelled = dataLine("WithdrawCancelled", { owner: OWNER, amount: bn(500), pendingEpoch: bn(3), principal: bn(3_000_000), yieldIndex: bn(0) });
    expect(await indexer.ingestLogs(batch("sig-cancel", 41n, [cancelled]))).toBe(1);
    expect(await prisma.event.findMany({ where: { name: "WithdrawCancelled" } })).toHaveLength(1);
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
          yieldIndex: bn(0),
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

describe("pool-scoped reads", () => {
  const ALICE = Keypair.generate().publicKey.toBase58();
  const BOB = Keypair.generate().publicKey.toBase58();
  const CAROL = Keypair.generate().publicKey.toBase58();
  const DAVE = Keypair.generate().publicKey.toBase58();

  const player = (owner: string, overrides: object = {}) => ({
    poolAddress: active(),
    owner,
    principal: 0n,
    epochId: 5n,
    isHouse: false,
    pendingWithdraw: 0n,
    pendingEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
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
        player(ALICE),
        player(BOB),
        player(CAROL),
        player(DAVE, { epochId: 3n, principal: 2n }),
      ],
    });
  });

  it("reads a single epoch and every player", async () => {
    expect(await indexer.getEpoch(5n)).toMatchObject({ id: 5n, status: 1 });
    expect(await indexer.getEpoch(6n)).toBeNull();
    expect((await indexer.getPlayers()).length).toBe(4);
  });

  // ADR 0016: a retired pool's rows share the tables but never reach the
  // operator.
  it("never hands the operator a retired pool's epoch or player", async () => {
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
      data: player(Keypair.generate().publicKey.toBase58(), { poolAddress: RETIRED_POOL }),
    });

    expect(await indexer.getEpoch(6n)).toBeNull();
    expect((await indexer.getPlayers()).length).toBe(4);
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
    expect(await indexer.ingestLogs(batch("sig-noref", 1n, [depositedFor(OWNER, 60_000_000, 60_000_000)]))).toBe(1);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("a bind seeds from a mirror ahead of the finalized events and skips the events the seed holds (mainnet-readiness-fixes 11)", async () => {
    // Mirror at slot 5 already shows the refund (60 -> 40 USDC); the refund's
    // event finalizes after the bind.
    await prisma.player.create({
      data: {
        poolAddress: active(),
        owner: referee,
        principal: 40_000_000n,
        epochId: 1n,
        isHouse: false,
        pendingWithdraw: 0n,
        pendingEpoch: 0n,
        boughtEpoch: 0n,
        boughtAmount: 0n,
        slot: 5n,
      },
    });
    await prisma.$transaction((tx) =>
      bindReferral(tx, active(), referee, STRANGER.toBase58(), "ABCD2345"),
    );
    await indexer.ingestLogs(
      batch("sig-seeded", 5n, [withdrawRequestedFor(OWNER, 20_000_000, 20_000_000)]),
    );
    expect((await prisma.referral.findUniqueOrThrow({ where: { referee } })).principal).toBe(40_000_000n);
    // An event after the seed slot still applies.
    await indexer.ingestLogs(
      batch("sig-after-seed", 6n, [withdrawRequestedFor(OWNER, 10_000_000, 10_000_000)]),
    );
    expect((await prisma.referral.findUniqueOrThrow({ where: { referee } })).principal).toBe(30_000_000n);
  });

  it("a sweep stamps the Player row behind its slot, so an event in the index lag is applied (mainnet-readiness-fixes 17)", async () => {
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    connection.slot = 120;
    try {
      await indexer.syncAccounts();
    } finally {
      connection.slot = 100;
    }
    const player = await prisma.player.findUniqueOrThrow({ where: byOwner(referee) });
    expect(player.slot).toBeLessThanOrEqual(60n);
    await prisma.$transaction((tx) =>
      bindReferral(tx, active(), referee, STRANGER.toBase58(), "ABCD2345"),
    );
    await indexer.ingestLogs(
      batch("sig-lagged", 100n, [depositedFor(OWNER, 60_000_000, 63_000_000)]),
    );
    expect((await prisma.referral.findUniqueOrThrow({ where: { referee } })).principal).toBe(63_000_000n);
  });

  it("crosses up through 50 USDC on a deposit and stamps aboveSince", async () => {
    await seedReferral();
    await indexer.ingestLogs(
      batch("sig-cross", 1n, [depositedFor(OWNER, 60_000_000, 60_000_000)]),
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
        depositedFor(OWNER, 25_000_000, 55_000_000),
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
      batch("sig-old", 10n, [depositedFor(OWNER, 60_000_000, 60_000_000)]).logs,
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
        logs: batch("sig-live", 30n, [depositedFor(OWNER, 80_000_000, 80_000_000)]).logs,
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

// audit-2026-10-09 06: Solana cuts a transaction's log at 10 KB. Its events are
// never decoded; the accounts it names are re-read and the signature recorded.
describe("truncated transaction logs", () => {
  const TRUNCATED = "Log truncated";
  const truncatedLogs = (signature: string) => [...batch(signature, 50n, [deposited]).logs, TRUNCATED];
  const ownerKeys = () => [chain.poolAddress(), chain.playerAddress(OWNER), STRANGER];
  const fireLive = async (signature: string) => {
    indexer["subscribeToLogs"]();
    connection.fireLogs(chain.poolAddress(), "finalized", { err: null, signature, logs: truncatedLogs(signature) }, 50);
    await indexer["queue"];
  };

  beforeEach(async () => {
    await seedActivePool();
    connection.accountOwner = PROGRAM_ID;
    indexer["lastSyncedSlot"] = 100n;
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER, { principal: bn(7_000_000) }));
  });
  afterEach(() => {
    connection.accountOwner = PublicKey.default;
    connection.signaturesForAddress = [];
  });

  it("the finalized catch-up refreshes the accounts, records the signature and still reads its neighbours", async () => {
    connection.signaturesForAddress = [
      { signature: "ok-1", slot: 51, err: null, blockTime: 1_700_000_051 },
      { signature: "cut-1", slot: 50, err: null, blockTime: 1_700_000_050 },
    ];
    connection.setTransaction("cut-1", truncatedLogs("cut-1"), ownerKeys());
    connection.setTransaction("ok-1", batch("ok-1", 51n, [epochRolledOver]).logs);

    await indexer["catchUpEvents"]();

    // The Player in the key list is re-read from chain.
    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) })).toMatchObject({ principal: 7_000_000n });
    expect(await prisma.truncatedLog.findMany()).toMatchObject([{ poolAddress: active(), signature: "cut-1", slot: 50n }]);
    // The Deposited before the cut is not read: no ledger row. The intact neighbour is stored.
    expect(await prisma.ticketBalance.count()).toBe(0);
    expect(await prisma.ticketLedger.count()).toBe(0);
    expect(await prisma.event.findMany()).toMatchObject([{ signature: "ok-1", name: "EpochRolledOver" }]);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ lastSignature: "ok-1" });
    // A replay records nothing new.
    await indexer["catchUpEvents"]();
    expect(await prisma.truncatedLog.count()).toBe(1);
  });

  it("a truncated subgraph row refreshes the accounts and moves the cursor (solami 05)", async () => {
    const fake = new FakeSubgraph();
    fake.synced = { slot: 100, live: true };
    fake.rows = [{ signature: "cut-5", slot: 50n, logs: truncatedLogs("cut-5"), truncated: true, failed: false }];
    connection.setTransaction("cut-5", truncatedLogs("cut-5"), ownerKeys());
    const viaSubgraph = new IndexerService(prisma, chain, fake);
    viaSubgraph["lastSyncedSlot"] = 100n;

    await viaSubgraph["catchUpEvents"]();

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) })).toMatchObject({ principal: 7_000_000n });
    expect(await prisma.truncatedLog.findMany()).toMatchObject([{ signature: "cut-5", slot: 50n }]);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ lastSignature: "cut-5" });
  });

  it("the live log path does the same without moving the cursor", async () => {
    connection.setTransaction("cut-2", truncatedLogs("cut-2"), ownerKeys());
    await fireLive("cut-2");

    expect(await prisma.player.findUniqueOrThrow({ where: byOwner(OWNER.toBase58()) })).toMatchObject({ principal: 7_000_000n });
    expect(await prisma.truncatedLog.findMany()).toMatchObject([{ signature: "cut-2", slot: 50n }]);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.ticketLedger.count()).toBe(0);
    expect(await prisma.cursor.findUnique({ where: { poolAddress: active() } })).toBeNull();
  });

  it("skips a program account that is not the PDA of its own owner", async () => {
    const stray = Keypair.generate().publicKey;
    await put("player", stray, playerAccount(OWNER)); // right layout, wrong address
    connection.setTransaction("cut-3", truncatedLogs("cut-3"), [...ownerKeys(), stray]);
    await fireLive("cut-3");
    expect(await prisma.player.count()).toBe(1);
  });

  // audit-2026-10-10 02
  it("accepts the rotated House at the Pool's pin", async () => {
    const house = Keypair.generate().publicKey;
    await put("pool", chain.poolAddress(), poolAccount({ house }));
    await put("player", house, playerAccount(STRANGER, { isHouse: true }));
    connection.setTransaction("cut-4", truncatedLogs("cut-4"), [chain.poolAddress(), house]);
    await fireLive("cut-4");
    expect(await prisma.player.findMany()).toMatchObject([{ owner: STRANGER.toBase58(), isHouse: true }]);
  });
});

// audit-2026-10-10 02: set_operator rewrites the House's owner and keeps its
// address, so it no longer sits at its owner's seed address. The Pool's `house`
// pin is the only thing that names it.
describe("rotated House", () => {
  const NEW_OPERATOR = Keypair.generate().publicKey;
  const HOUSE = Keypair.generate().publicKey;
  const mirrored = (owner: PublicKey) => ({
    poolAddress: active(), owner: owner.toBase58(), principal: 0n, epochId: 1n, isHouse: true,
    pendingWithdraw: 0n, pendingEpoch: 0n, boughtEpoch: 0n, boughtAmount: 0n,
  });

  beforeEach(async () => {
    await seedActivePool();
    await put("pool", chain.poolAddress(), poolAccount({ operator: NEW_OPERATOR, house: HOUSE }));
    await put("player", HOUSE, playerAccount(NEW_OPERATOR, { isHouse: true, principal: bn(0) }));
    // The row the mirror wrote before the rotation, under the first Operator.
    await prisma.player.create({ data: mirrored(OWNER) });
  });

  it("the sweep moves the House row to the new owner and still drops a stranger's Player at a non-seed address", async () => {
    await put("player", Keypair.generate().publicKey, playerAccount(STRANGER));
    indexer["lastSyncedSlot"] = undefined;
    await indexer.syncAccounts();
    expect(await prisma.player.findMany()).toMatchObject([{ owner: NEW_OPERATOR.toBase58(), isHouse: true }]);
  });

  it("an OperatorChanged log refreshes the Pool and then the House", async () => {
    const logs = batch("op-1", 200n, [
      dataLine("OperatorChanged", { pool: chain.poolAddress(), previous: OWNER, operator: NEW_OPERATOR }),
    ]).logs;
    await indexer["refreshFromLogs"](logs, 200n);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: active() } })).toMatchObject({
      operator: NEW_OPERATOR.toBase58(),
    });
    expect(await prisma.player.findMany()).toMatchObject([{ owner: NEW_OPERATOR.toBase58(), isHouse: true }]);
  });
});

// off-chain-tickets 11: the Ticket ledger applies events in the finalized
// catch-up's order, snapshots at EpochBegan, and resets every wallet to its
// Ticket basis in the same transaction.
describe("ticket ledger", () => {
  const A = Keypair.generate().publicKey;
  const B = Keypair.generate().publicKey;
  const C = Keypair.generate().publicKey;
  const D = Keypair.generate().publicKey;
  const ONE = 10n ** 18n;
  const POINT_ONE = ONE + ONE / 10n; // the pool index after 10% yield

  const money = (name: string, owner: PublicKey, amount: number, principal: number, index = ONE) =>
    dataLine(name, { owner, amount: bn(amount), principal: bn(principal), yieldIndex: bn(index) });
  const began = (epochId: number, index = ONE) =>
    dataLine("EpochBegan", { epochId: bn(epochId), startsAt: bn(1_000), endsAt: bn(2_000), yieldIndex: bn(index) });
  const key = (owner: PublicKey) => ({ poolAddress_owner: { poolAddress: active(), owner: owner.toBase58() } });
  const balance = async (owner: PublicKey) => prisma.ticketBalance.findUniqueOrThrow({ where: key(owner) });
  const rowsOf = async (owner: PublicKey) =>
    (await prisma.ticketLedger.findMany({ where: { owner: owner.toBase58() }, orderBy: { id: "asc" } })).map(
      (row) => [row.reason, row.delta, row.epochId] as const,
    );

  beforeEach(async () => {
    await seedActivePool();
    await seedEpoch(1n);
    await seedEpoch(2n);
  });

  it("books two epoch boundaries into balances, snapshots and a root the builder reproduces", async () => {
    await indexer.ingestLogs(batch("s1", 10n, [began(1)]));
    await indexer.ingestLogs(batch("s2", 11n, [money("Deposited", A, 1_000, 1_000)]));
    await indexer.ingestLogs(batch("s3", 12n, [money("Deposited", B, 500, 500)]));
    // The cutoff: nobody held a Ticket in epoch 1, and 10% yield is unsettled.
    await indexer.ingestLogs(batch("s4", 20n, [began(2, POINT_ONE)]));
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).toMatchObject({
      snapshotRoot: null,
      snapshotDepth: 0,
      leafCount: 0,
      totalTickets: 0n,
    });
    expect([(await balance(A)).tickets, (await balance(B)).tickets]).toEqual([1_100n, 550n]);

    // B is paid out in full; A deposits again and the settle lifts her Principal.
    await indexer.ingestLogs(batch("s5", 21n, [money("Withdrawn", B, 600, 0, POINT_ONE)]));
    await indexer.ingestLogs(batch("s6", 22n, [money("Deposited", A, 100, 1_200, POINT_ONE)]));
    await indexer.ingestLogs(batch("s7", 30n, [began(3, POINT_ONE)]));

    const leaves = [{ wallet: Buffer.from(A.toBytes()), tickets: 1_100n }];
    const tree = buildSumTree(leaves);
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(2n) })).toMatchObject({
      snapshotRoot: tree.root.toString("hex"),
      snapshotDepth: tree.depth,
      leafCount: 1,
      totalTickets: 1_100n,
    });
    expect(await prisma.epochSnapshot.findMany({ where: { epochId: 2n } })).toMatchObject([
      { index: 0, owner: A.toBase58(), tickets: 1_100n },
    ]);
    expect(await rowsOf(A)).toEqual([["reset", 1_100n, 2n], ["reset", 100n, 3n]]);
    expect(await rowsOf(B)).toEqual([["reset", 550n, 2n], ["withdraw", -550n, 2n]]);
    expect(await balance(A)).toMatchObject({ tickets: 1_200n, principal: 1_200n, epochId: 3n });
    expect(await balance(B)).toMatchObject({ tickets: 0n, principal: 0n });
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ ledgerEpochId: 3n });

    // The nightly check passes, and fails with the count once a balance is edited by hand.
    expect(await countLedgerMismatches(prisma, active())).toBe(0);
    await prisma.ticketBalance.update({ where: key(A), data: { tickets: 9_999n } });
    expect(await countLedgerMismatches(prisma, active())).toBe(1);
  });

  it("sorts a snapshot by wallet bytes, not by the order the wallets deposited", async () => {
    const wallets = [A, B, C].sort((x, y) => Buffer.compare(x.toBuffer(), y.toBuffer()));
    await indexer.ingestLogs(batch("t1", 10n, [began(1)]));
    // Deposit in reverse byte order.
    for (const [i, wallet] of [...wallets].reverse().entries()) {
      await indexer.ingestLogs(batch(`t-dep-${i}`, 11n + BigInt(i), [money("Deposited", wallet, 10, 10)]));
    }
    await indexer.ingestLogs(batch("t2", 20n, [began(2)]));
    await indexer.ingestLogs(batch("t3", 30n, [began(3)]));
    const rows = await prisma.epochSnapshot.findMany({ where: { epochId: 2n }, orderBy: { index: "asc" } });
    expect(rows.map((row) => row.owner)).toEqual(wallets.map((wallet) => wallet.toBase58()));
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(2n) })).toMatchObject({ leafCount: 3, totalTickets: 30n, snapshotDepth: 2 });
  });

  it("holds a same-slot deposit out of the ended epoch's snapshot, before or after EpochBegan", async () => {
    await indexer.ingestLogs(batch("u0", 5n, [began(1)]));
    await indexer.ingestLogs(batch("u1", 10n, [money("Deposited", C, 100, 100)])); // before the cutoff
    await indexer.ingestLogs(batch("u2", 10n, [began(2)]));
    await indexer.ingestLogs(batch("u3", 10n, [money("Deposited", D, 200, 200)])); // after it
    expect(await prisma.epoch.findUniqueOrThrow({ where: byId(1n) })).toMatchObject({ leafCount: 0, totalTickets: 0n });
    // The earlier one folds into the reset; the later one waits for the next.
    expect([(await balance(C)).tickets, (await balance(D)).tickets]).toEqual([100n, 0n]);
    await indexer.ingestLogs(batch("u4", 20n, [began(3)]));
    expect(await prisma.epochSnapshot.findMany({ where: { epochId: 2n } })).toMatchObject([
      { owner: C.toBase58(), tickets: 100n },
    ]);
    expect((await balance(D)).tickets).toBe(200n);
  });

  it("a settle after the reset leaves the basis unchanged, so the next reset adds nothing", async () => {
    await indexer.ingestLogs(batch("v0", 5n, [began(1)]));
    await indexer.ingestLogs(batch("v1", 10n, [money("Deposited", A, 1_000, 1_000)]));
    await indexer.ingestLogs(batch("v2", 20n, [began(2, POINT_ONE)]));
    expect((await balance(A)).tickets).toBe(1_100n); // 1,000 + 10% unsettled
    // Her next action settles: Principal rises by exactly the owed 100 and her index catches up.
    await indexer.ingestLogs(batch("v3", 21n, [money("Deposited", A, 0, 1_100, POINT_ONE)]));
    await indexer.ingestLogs(batch("v4", 30n, [began(3, POINT_ONE)]));
    expect(await rowsOf(A)).toEqual([["reset", 1_100n, 2n]]);
    expect((await balance(A)).tickets).toBe(1_100n);
  });

  it("resets the House to zero and floors a withdrawal at zero Tickets", async () => {
    const house = Keypair.generate().publicKey;
    await prisma.ticketBalance.create({
      data: { poolAddress: active(), owner: house.toBase58(), tickets: 50n, principal: 0n, epochId: 1n },
    });
    await prisma.ticketLedger.create({
      data: { poolAddress: active(), owner: house.toBase58(), epochId: 1n, delta: 50n, reason: "house_credit", ref: "seed" },
    });
    await indexer.ingestLogs(batch("w1", 10n, [money("Deposited", A, 100, 100)]));
    // 100 Principal and no Tickets yet, a payout of 100 takes nothing below zero.
    await indexer.ingestLogs(batch("w2", 11n, [money("Withdrawn", A, 100, 0)]));
    await indexer.ingestLogs(batch("w3", 20n, [began(2)]));
    expect((await balance(house)).tickets).toBe(0n);
    expect(await rowsOf(house)).toEqual([["house_credit", 50n, 1n], ["reset", -50n, 2n]]);
    expect(await rowsOf(A)).toEqual([]);
    expect(await countLedgerMismatches(prisma, active())).toBe(0);
  });

  // audit-2026-10-10 02: the House Leaf is under the Operator the House has now.
  it("a rotated House's Leaf is under the new Operator, and its payout passes the House account", async () => {
    const house = Keypair.generate().publicKey;
    await put("pool", chain.poolAddress(), poolAccount({ operator: A, house }));
    await put("player", house, playerAccount(A, { isHouse: true, principal: bn(0) }));
    await prisma.player.create({
      data: {
        poolAddress: active(), owner: B.toBase58(), principal: 0n, epochId: 1n, isHouse: true,
        pendingWithdraw: 0n, pendingEpoch: 0n, boughtEpoch: 0n, boughtAmount: 0n,
      },
    });
    indexer["lastSyncedSlot"] = undefined;
    await indexer.syncAccounts();
    const mirror = await prisma.player.findFirstOrThrow({ where: { isHouse: true } });
    expect(mirror.owner).toBe(A.toBase58());

    // A Round nobody covered forfeits its pot to the House, booked as the settle books it.
    await indexer.ingestLogs(batch("h1", 10n, [began(1)]));
    const { rows } = settleRows([{ owner: C.toBase58(), tiles: 2n, stakePerTile: 10n, restored: false }], 20, 600, mirror.owner);
    for (const { owner, reason, delta } of rows) {
      await prisma.ticketLedger.create({ data: { poolAddress: active(), owner, epochId: 1n, delta, reason, ref: "1" } });
      await prisma.ticketBalance.upsert({
        where: key(new PublicKey(owner)),
        create: { poolAddress: active(), owner, tickets: delta, epochId: 1n },
        update: { tickets: { increment: delta } },
      });
    }
    await indexer.ingestLogs(batch("h2", 20n, [began(2)]));

    const proof = await winnerProof(prisma, active(), 1n, 0n);
    expect(proof).toMatchObject({ owner: A.toBase58(), tickets: 10n });
    // SAFETY: only the fields `payout` reads are set, and a stub venue needs no remaining accounts.
    const state = {
      address: chain.poolAddress(), operator: A, house, acceptedMint: STRANGER, treasury: STRANGER,
      buybackReserve: STRANGER, klendProgram: STRANGER, klendMarket: STRANGER, klendReserve: STRANGER,
      klendCtoken: STRANGER, venueKind: VENUE_KIND.stub,
    } as unknown as PoolState;
    const ix = await new OperatorInstructions(chain.program, PROGRAM_ID, STRANGER, true).payout(state, 1n, proof!);
    const keys = (ix[0]?.keys ?? []).map((meta) => meta.pubkey.toBase58());
    expect(keys).toContain(house.toBase58());
    expect(keys).not.toContain(chain.playerAddress(A).toBase58());
  });

  it("books a prize to a non-House winner and nothing for the House", async () => {
    const prize = (winner: PublicKey, isHouse: boolean, principal: number) =>
      dataLine("JackpotPaid", {
        epochId: bn(1), winner, amount: bn(700), isHouse, compounded: !isHouse,
        principal: bn(principal), yieldIndex: bn(ONE), index: 0, tickets: bn(0),
      });
    await indexer.ingestLogs(batch("x1", 10n, [prize(A, false, 700)]));
    await indexer.ingestLogs(batch("x2", 11n, [prize(B, true, 0)]));
    expect(await rowsOf(A)).toEqual([["prize", 700n, 0n]]);
    expect(await balance(A)).toMatchObject({ tickets: 700n, principal: 700n });
    expect(await rowsOf(B)).toEqual([]);
  });

  it("applies a transaction once: a replay, a live copy and a restart mid-slot add no rows", async () => {
    const dep = batch("y1", 10n, [money("Deposited", A, 100, 100)]);
    const pay = batch("y2", 10n, [money("Withdrawn", A, 40, 60)]);
    // The live path stores y1 first and books nothing.
    await indexer["persist"](dep, decodeEventLogs(indexer["parser"], dep.logs), { advanceCursor: false });
    expect(await prisma.ticketBalance.count()).toBe(0);

    await indexer.ingestLogs(dep);
    await indexer.ingestLogs(dep); // the same slot twice
    await prisma.ticketBalance.update({ where: key(A), data: { tickets: 100n } });
    await prisma.ticketLedger.create({
      data: { poolAddress: active(), owner: A.toBase58(), epochId: 0n, delta: 100n, reason: "grant_admin", ref: "seed" },
    });
    await indexer.ingestLogs(pay);
    await indexer.ingestLogs(pay);
    expect(await rowsOf(A)).toEqual([["grant_admin", 100n, 0n], ["withdraw", -40n, 0n]]);
    expect(await balance(A)).toMatchObject({ tickets: 60n, principal: 60n });

    // A restart between two transactions of one slot resumes after the cursor's signature.
    connection.signaturesForAddress = [
      { signature: "y3", slot: 10, err: null, blockTime: 1_700_000_010 },
      { signature: "y2", slot: 10, err: null, blockTime: 1_700_000_010 },
      { signature: "y1", slot: 10, err: null, blockTime: 1_700_000_010 },
    ];
    connection.setTransaction("y3", batch("y3", 10n, [money("Withdrawn", A, 10, 50)]).logs);
    await indexer["catchUpEvents"]();
    await indexer["catchUpEvents"]();
    expect((await balance(A)).tickets).toBe(50n);
    expect(await rowsOf(A)).toHaveLength(3);
  });

  // off-chain-tickets 24: a bought Ticket is booked at the Game config rate in
  // force at the event's block time, once, in the epoch the chain order says.
  describe("bought Tickets", () => {
    const buy = (owner: PublicKey, usdc: number, principal: number) =>
      dataLine("TicketsBought", { owner, epochId: bn(1), usdc: bn(usdc), principal: bn(principal), yieldIndex: bn(ONE) });
    const at = (signature: string, slot: bigint, blockTime: bigint, lines: string[]) => ({
      ...batch(signature, slot, lines),
      blockTime,
    });
    const config = seedGameConfig;

    it("prices a buy at the row in force at its block time, and a later change leaves it alone", async () => {
      await config(10, 1_000n);
      await config(20, 2_000n);
      await indexer.ingestLogs(at("b1", 10n, 1_500n, [buy(A, 100, 1_000)]));
      await config(99, 3_000n); // a change after the fact
      await indexer.ingestLogs(at("b2", 11n, 2_500n, [buy(A, 100, 1_000)]));
      await indexer.ingestLogs(at("b3", 12n, 500n, [buy(B, 1, 10)])); // older than every row: the first one
      expect(await rowsOf(A)).toEqual([["buy", 1_000n, 0n], ["buy", 2_000n, 0n]]);
      expect(await rowsOf(B)).toEqual([["buy", 10n, 0n]]);
      expect(await balance(A)).toMatchObject({ tickets: 3_000n, principal: 1_000n });
      expect(await countLedgerMismatches(prisma, active())).toBe(0);
    });

    it("books a replayed buy once and lands a same-slot buy in the epoch the chain order says", async () => {
      await config(10, 1_000n);
      const before = at("c1", 10n, 1_500n, [buy(A, 100, 5_000)]);
      const cutoff = at("c2", 10n, 1_500n, [began(2)]);
      const after = at("c3", 10n, 1_500n, [buy(C, 50, 100)]);
      await indexer.ingestLogs(at("c0", 5n, 1_500n, [began(1)]));
      for (const replayed of [before, cutoff, after, before, cutoff, after]) await indexer.ingestLogs(replayed);
      expect(await rowsOf(A)).toEqual([["buy", 1_000n, 1n], ["reset", 4_000n, 2n]]);
      expect(await rowsOf(C)).toEqual([["buy", 500n, 2n]]);
      // The buy before EpochBegan is in epoch 1's snapshot, the one after waits for epoch 2's.
      expect(await prisma.epochSnapshot.findMany({ where: { epochId: 1n } })).toMatchObject([
        { owner: A.toBase58(), tickets: 1_000n },
      ]);
      await indexer.ingestLogs(at("c4", 20n, 1_600n, [began(3)]));
      expect(await prisma.epochSnapshot.findMany({ where: { epochId: 2n }, orderBy: { owner: "asc" } })).toHaveLength(2);
      expect(await countLedgerMismatches(prisma, active())).toBe(0);
    });
  });

  it("holds the cutoff back when the ended epoch is not mirrored yet, then applies it whole", async () => {
    await prisma.epoch.delete({ where: byId(1n) });
    await expect(indexer.ingestLogs(batch("z1", 10n, [money("Deposited", A, 100, 100), began(2)]))).rejects.toThrow(/not mirrored/);
    // The whole transaction rolled back: no event, no balance, no cursor move.
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.ticketBalance.count()).toBe(0);
    await seedEpoch(1n);
    await indexer.ingestLogs(batch("z1", 10n, [money("Deposited", A, 100, 100), began(2)]));
    expect((await balance(A)).tickets).toBe(100n);
  });

  // audit-2026-10-09 05: a skipped EpochBegan would mean no snapshot and no reset, silently.
  it("refuses an EpochBegan that skips an epoch, writes nothing, and leaves the cursor where it was", async () => {
    await seedEpoch(3n);
    for (const [i, id] of [1, 2, 3].entries()) await indexer.ingestLogs(batch(`q${i}`, 10n + BigInt(i), [began(id)]));
    const events = await prisma.event.count();
    await expect(indexer.ingestLogs(batch("q-skip", 20n, [began(5)]))).rejects.toThrow(/EpochBegan 5.*epoch 3/);
    expect(await prisma.event.count()).toBe(events);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ ledgerEpochId: 3n });
    await indexer.ingestLogs(batch("q-next", 21n, [began(4)]));
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ ledgerEpochId: 4n });
  });

  it("books the first EpochBegan on an empty ledger whatever its id", async () => {
    await seedEpoch(6n);
    await indexer.ingestLogs(batch("r1", 10n, [began(7)]));
    expect(await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ ledgerEpochId: 7n });
  });

  // audit-2026-10-09 07: the ledger's Principal is checked against the mirrored Player's.
  it("counts a wallet whose ledger Principal differs from its Player's, and ignores the House and a wallet with no Player", async () => {
    const mirror = (owner: PublicKey, principal: bigint, isHouse = false) =>
      prisma.player.create({
        data: {
          poolAddress: active(), owner: owner.toBase58(), principal, epochId: 1n, isHouse,
          pendingWithdraw: 0n, pendingEpoch: 0n, boughtEpoch: 0n, boughtAmount: 0n,
        },
      });
    const house = Keypair.generate().publicKey;
    await indexer.ingestLogs(batch("p1", 10n, [money("Deposited", A, 100, 100)]));
    await indexer.ingestLogs(batch("p2", 11n, [money("Deposited", B, 50, 50)]));
    await indexer.ingestLogs(batch("p3", 12n, [money("Deposited", C, 70, 70)])); // C never gets a Player
    await mirror(A, 100n);
    await mirror(B, 50n);
    await mirror(house, 9n, true);
    expect(await countLedgerMismatches(prisma, active())).toBe(0);

    await prisma.player.update({ where: key(A), data: { principal: 180n } });
    expect(await countLedgerMismatches(prisma, active())).toBe(1);
    // Only the new term: the balance still sums to its ledger rows, so the nightly check stores 1.
    await checkLedgerIfDue(prisma, active(), 5_000n);
    expect(await prisma.ledgerCheck.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ mismatches: 1 });
    expect(await principalDrift(prisma, active(), 5)).toEqual({
      count: 1,
      wallets: [{ owner: A.toBase58(), ledgerPrincipal: 100n, chainPrincipal: 180n }],
    });

    // A Player the ledger has never seen is a lost event, not a skip.
    await mirror(D, 25n);
    expect((await principalDrift(prisma, active(), 5)).count).toBe(2);
  });

  it("runs the nightly check once a day and stores the count for /alerts", async () => {
    await indexer.ingestLogs(batch("c1", 10n, [money("Deposited", A, 100, 100)]));
    await checkLedgerIfDue(prisma, active(), 1_000n);
    expect(await prisma.ledgerCheck.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ checkedAt: 1_000n, mismatches: 0 });
    await prisma.ticketBalance.update({ where: key(A), data: { tickets: 5n } });
    await checkLedgerIfDue(prisma, active(), 1_000n + LEDGER_CHECK_INTERVAL_S - 1n); // too soon
    expect((await prisma.ledgerCheck.findUniqueOrThrow({ where: { poolAddress: active() } })).mismatches).toBe(0);
    await checkLedgerIfDue(prisma, active(), 1_000n + LEDGER_CHECK_INTERVAL_S);
    expect(await prisma.ledgerCheck.findUniqueOrThrow({ where: { poolAddress: active() } })).toMatchObject({ mismatches: 1 });
  });
});
});
