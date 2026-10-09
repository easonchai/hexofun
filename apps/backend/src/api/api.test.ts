// A dedicated database so a rerun, or another agent's suite, cannot collide
// with these rows. Set before the Nest module is built, which is when
// PrismaService opens its connection.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_api";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import type { INestApplication } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Prisma, type Player, type TicketReason } from "@prisma/client";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ChainModule } from "../chain/chain.module";
import { ChainService } from "../chain/chain.service";
import { ConfigModule } from "../config/config.module";
import { HealthController } from "../health/health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { epochSeed, randomnessAddress } from "../operator/vrf";
import { PrismaService } from "../prisma/prisma.service";
import { buildSumTree, verifyPayout } from "../snapshot/sum-tree";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_PLAYER_DEFAULTS, LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { AlertsController } from "./alerts.controller";
import { ApiModule } from "./api.module";
import { FaucetController } from "./faucet.controller";
import {
  ApiService,
  BALANCES_TTL_MS,
  CHAIN_CLOCK_TTL_MS,
  JACKPOT_BALANCE_TTL_MS,
  oddsPercent,
  operatorErrorCode,
  playerTicketExtras,
} from "./api.service";

const NOW = BigInt(Math.floor(Date.now() / 1000));
const EPOCH_LENGTH = 86_400n;
const CURRENT_EPOCH = 7n;
const PREVIOUS_EPOCH = 6n;
const CURRENT_START = NOW - 100n;
const PREVIOUS_START = CURRENT_START - EPOCH_LENGTH;

// Deliberately far from wall-clock NOW, so a route that read Date.now()
// instead of the chain clock would return a different chainTime.
const CHAIN_NOW = NOW + 10_000n;

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const PROGRAM_ID = Keypair.generate().publicKey;
const ALICE = Keypair.generate().publicKey.toBase58();
const BOB = Keypair.generate().publicKey.toBase58();
const HOUSE = Keypair.generate().publicKey.toBase58();

/** A pool the database still holds after a Pool cutover (ADR 0016). The seed
 *  gives it rows that collide with the Active pool's ids (epoch 7, round
 *  100, Alice) or sort ahead of them, so every exact-match assertion in this
 *  file also proves the route ignores it. */
const RETIRED_POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
/** Only ever deposited in the retired pool. */
const CAROL = Keypair.generate().publicKey.toBase58();

/** Player's composite key in the Active pool, for `update` calls. */
const activePlayer = (owner: string) => ({
  poolAddress_owner: { poolAddress: POOL_ADDRESS, owner },
});

// Past 2^53, so a route that leaked a JSON number would round the value
// rather than return these digits.
const HUGE_U64 = "9007199254740993";

const FAKE_SIGNATURE = "FakeSignature1111111111111111111111111111111";
/** What the fake RPC says sits in the jackpot vault while epoch 7 is open. */
const VAULT_BALANCE = 5_000_000n;
/** GET /state's ticket 08 field: the fake `priorityFeeMicroLamports`'s
 *  canned answer. */
const FAKE_PRIORITY_FEE = 4_242;
/** The seeded Pool row's `minDeposit`, which the browser reads off `/state`
 *  rather than off the chain (ticket 07). */
const POOL_MIN_DEPOSIT = 1_000_000n;

/** Ticket 03's `/status` figures: what the pool owes, what the principal
 *  vault holds against it, and what the operator has left for fees. */
const POOL_PENDING_WITHDRAWALS = 3_000_000n;
const PRINCIPAL_VAULT_BALANCE = 9_000_000n;
const OPERATOR_LAMPORTS = 2 * LAMPORTS_PER_SOL;

/** Ticket 05's `/status`, `/pool` and `/players/:owner` figures: the ceiling
 *  rate and bought tickets. */
const POOL_BASE_RATE_BPS = 488;
const ALICE_BOUGHT_AMOUNT = 200_000n;

/** Ticket 14's live yield. The Pool's venue position is past 2^53 so the
 *  solvency margin proves its string path, and sized so the vault plus the
 *  venue cover principal by exactly SOLVENCY_MARGIN. Queued withdrawals are
 *  inside principal (ADR 0020), so they are not added to it. */
const POOL_VENUE_VALUE = BigInt(HUGE_U64) + 10_000_000n;
const SOLVENCY_MARGIN = PRINCIPAL_VAULT_BALANCE + POOL_VENUE_VALUE - BigInt(HUGE_U64);
const FREE_IDLE = PRINCIPAL_VAULT_BALANCE - POOL_PENDING_WITHDRAWALS;
/** `lastSyncAt`, and the index history behind the trailing rates: 5% over
 *  the 7 days to the last sync, 1% over the last 24 hours. */
const LAST_SYNC = NOW - 60n;
const E18 = 10n ** 18n;
const POOL_YIELD_INDEX = E18 + (E18 * 5n) / 100n;
const ALICE_YIELD_INDEX = E18;
/** klend's reserve: 500k USDC free of 5M, 90% utilised. */
const RESERVE_AVAILABLE = 500_000_000_000n;
const RESERVE_BORROWED = 4_500_000_000_000n;
/** Alice holds the whole draw: her 1,000,000 Tickets, one per Principal unit. */
const ALICE_WEIGHT = 1_000_000n;
const RESERVE = Keypair.generate().publicKey;

/** The operator key, which is also the authority of the mint the faucet
 *  mints from; the faucet resolves that at boot. */
const OPERATOR = Keypair.generate();
const ACCEPTED_MINT = new PublicKey(process.env.ACCEPTED_MINT as string);
const PRINCIPAL_VAULT = Keypair.generate().publicKey;

/** A Clock sysvar account's data, `unix_timestamp` at byte offset 32 (see
 *  operator/chain-state.ts `clockUnixTimestamp`). The other fields are unused. */
function clockSysvarData(unixTimestamp: bigint): Buffer {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(unixTimestamp, 32);
  return data;
}

/** An SPL mint account whose authority is `mintAuthority`, as the faucet's
 *  boot check reads it. */
function mintAccount(mintAuthority: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

/** An SPL token account holding `amount`, as `/status`'s liquidity read
 *  unpacks it. */
function tokenAccount(amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: ACCEPTED_MINT,
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

/** A klend reserve with the fields `decodeReserve` reads, at klend's offsets:
 *  curve 0% at 0, 5.51% at 95%, 36.34% beyond; klend keeps 10%. */
function reserveData(): Buffer {
  const data = Buffer.alloc(8_624);
  data.writeBigUInt64LE(RESERVE_AVAILABLE, 224);
  const borrowedSf = RESERVE_BORROWED << 60n;
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

const accountInfo = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({
  data,
  owner,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});

const sentInstructions: TransactionInstruction[][] = [];

/** Counts calls the caching tests assert against, so they check the chain
 *  seam rather than the response body. */
let clockReads = 0;
let jackpotReads = 0;
let balanceReads = 0;
/** When set, the next `getTokenAccountBalance` call throws once and resets it. */
let failNextJackpotRead = false;
/** What the fake jackpot vault holds; a test sets it and restores it. */
let vaultBalance = VAULT_BALANCE;
/** Same, for the paired vault/operator balance read behind /status. */
let failNextBalanceRead = false;
/** What the fake Clock sysvar reads. Mutable so a test can make the chain
 *  clock regress the way a real one does when it drifts behind wall time. */
let chainClockValue = CHAIN_NOW;

const fakeChain = {
  connection: {
    rpcEndpoint: "http://127.0.0.1:8899",
    getSlot: async (): Promise<number> => 1234,
    // The mint for the faucet's boot check, the Clock sysvar for everything
    // else: those are the only two accounts this suite reads one at a time.
    getAccountInfo: async (address: PublicKey): Promise<AccountInfo<Buffer>> => {
      if (address.equals(ACCEPTED_MINT)) return mintAccount(OPERATOR.publicKey);
      clockReads += 1;
      return accountInfo(clockSysvarData(chainClockValue), SystemProgram.programId);
    },
    getMultipleAccountsInfo: async (
      addresses: PublicKey[],
    ): Promise<(AccountInfo<Buffer> | null)[]> => {
      balanceReads += 1;
      if (failNextBalanceRead) {
        failNextBalanceRead = false;
        throw new Error("simulated balance read failure");
      }
      return addresses.map((address) =>
        address.equals(PRINCIPAL_VAULT)
          ? tokenAccount(PRINCIPAL_VAULT_BALANCE)
          : address.equals(RESERVE)
            ? accountInfo(reserveData(), SystemProgram.programId)
            : { ...accountInfo(Buffer.alloc(0), SystemProgram.programId), lamports: OPERATOR_LAMPORTS },
      );
    },
    getTokenAccountBalance: async (): Promise<{ value: { amount: string } }> => {
      jackpotReads += 1;
      if (failNextJackpotRead) {
        failNextJackpotRead = false;
        throw new Error("simulated jackpot vault balance read failure");
      }
      return { value: { amount: vaultBalance.toString() } };
    },
  },
  poolAddress: (): PublicKey => new PublicKey(POOL_ADDRESS),
  // `/epochs/:id/draw` names the randomness account, which depends on the build.
  programId: PROGRAM_ID,
  program: { idl: { instructions: [] as { name: string }[] } },
  jackpotVaultAddress: (): PublicKey => Keypair.generate().publicKey,
  principalVaultAddress: (): PublicKey => PRINCIPAL_VAULT,
  priorityFeeMicroLamports: async (): Promise<number> => FAKE_PRIORITY_FEE,
  keypair: OPERATOR,
  send: async (instructions: TransactionInstruction[]): Promise<string> => {
    sentInstructions.push(instructions);
    return FAKE_SIGNATURE;
  },
};

const emptyPlayer = (owner: string, poolAddress: string = POOL_ADDRESS): Player => ({
  poolAddress,
  owner,
  principal: 0n,
  epochId: CURRENT_EPOCH,
  isHouse: false,
  pendingWithdraw: 0n,
  pendingEpoch: 0n,
  boughtEpoch: 0n,
  boughtAmount: 0n,
  slot: 0n,
  ...LIVE_PLAYER_DEFAULTS,
});

const MAX_JSON_SAFE = 2 ** 53;

/** The whole point of the serialization interceptor: no lossy JSON numbers. */
function assertNoLargeNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    expect(Math.abs(value), `${path} came back as a JSON number`).toBeLessThanOrEqual(
      MAX_JSON_SAFE,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoLargeNumbers(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      assertNoLargeNumbers(inner, `${path}.${key}`);
    }
  }
}

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Pool", "Epoch", "Player", "Event", "Cursor", "FaucetClaim", "OperatorState", "YieldIndexPoint", "TicketBalance", "EpochSnapshot", "LedgerCheck" CASCADE',
  );
}

describe("oddsPercent", () => {
  it("truncates to two decimals", () => {
    expect(oddsPercent(1n, 3n)).toBe("33.33");
    expect(oddsPercent(1n, 8n)).toBe("12.50");
    expect(oddsPercent(5n, 5n)).toBe("100.00");
  });

  it("does not divide by zero when nobody holds weight", () => {
    expect(oddsPercent(0n, 0n)).toBe("0.00");
  });

  it("pads a sub-one-percent share", () => {
    expect(oddsPercent(1n, 1_000n)).toBe("0.10");
  });
});

describe("playerTicketExtras", () => {
  const ALICE_ADDRESS = Keypair.generate().publicKey.toBase58();
  const player = (over: Partial<Player>): Player => ({
    ...emptyPlayer(ALICE_ADDRESS),
    principal: 1_000_000n,
    ...over,
  });

  it("reads today's counters live when their epoch matches the current one", () => {
    const extras = playerTicketExtras(
      player({ boughtEpoch: 7n, boughtAmount: 300_000n }),
      7n,
    );
    expect(extras).toEqual({
      boughtToday: 300_000n,
      buyAllowanceLeft: 700_000n,
    });
  });

  it("reads a counter from a past epoch as already reset to 0", () => {
    // The on-chain reset only happens the next time buy_tickets actually
    // runs for the new epoch, so a leftover epoch=6 value must not
    // leak into epoch 7's figures.
    const extras = playerTicketExtras(
      player({ boughtEpoch: 6n, boughtAmount: 300_000n }),
      7n,
    );
    expect(extras).toEqual({ boughtToday: 0n, buyAllowanceLeft: 1_000_000n });
  });

  it("floors buyAllowanceLeft at zero once bought spend reaches or passes Principal", () => {
    expect(
      playerTicketExtras(player({ principal: 1_000n, boughtEpoch: 7n, boughtAmount: 1_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(0n);
    // Reads 0, not negative, even if a drifted row somehow has more spent
    // than the current Principal covers.
    expect(
      playerTicketExtras(player({ principal: 500n, boughtEpoch: 7n, boughtAmount: 1_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(0n);
  });

  it("leaves the Pending deposit out of the allowance", () => {
    const extras = playerTicketExtras(
      player({ pendingDeposit: 400_000n, pendingDepositEpoch: 7n }),
      7n,
    );
    expect(extras.buyAllowanceLeft).toBe(600_000n);
  });

  it("takes the Pending deposit and what was bought off Principal together, floored at zero", () => {
    const pending = { pendingDeposit: 400_000n, pendingDepositEpoch: 7n };
    expect(
      playerTicketExtras(player({ ...pending, boughtEpoch: 7n, boughtAmount: 100_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(500_000n);
    expect(
      playerTicketExtras(player({ ...pending, boughtEpoch: 7n, boughtAmount: 700_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(0n);
  });

  it("counts a Pending deposit from an earlier epoch as locked again", () => {
    const extras = playerTicketExtras(
      player({ pendingDeposit: 400_000n, pendingDepositEpoch: 6n }),
      7n,
    );
    expect(extras.buyAllowanceLeft).toBe(1_000_000n);
  });
});

describe("operatorErrorCode", () => {
  it("is null when there is no error", () => {
    expect(operatorErrorCode(null)).toBeNull();
  });

  it("passes a bare IDL/Anchor error name through unchanged", () => {
    expect(operatorErrorCode("InsufficientVaultLiquidity")).toBe("InsufficientVaultLiquidity");
  });

  it("collapses anything else to one generic code, so a hostname or path never reaches a client", () => {
    expect(operatorErrorCode("RPC getMultipleAccountsInfo timed out after 10000ms")).toBe(
      "OPERATOR_TICK_FAILED",
    );
    expect(
      operatorErrorCode("principal vault Ax1...9Z does not exist; run bootstrap first"),
    ).toBe("OPERATOR_TICK_FAILED");
  });
});

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

describe.skipIf(!DB_AVAILABLE)("API routes", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // HealthController rides along to prove the global throttler guard
      // leaves the container probe alone. It needs ChainModule imported
      // here too, same as AppModule does at the real root: ApiModule
      // importing ChainModule only makes ChainService visible inside
      // ApiModule's own controllers, not to a controller declared on this
      // root test module.
      imports: [ConfigModule, PrismaModule, ChainModule, ApiModule],
      controllers: [HealthController],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      // No validator in the loop: the faucet's only chain contact is send().
      .overrideProvider(ChainService)
      .useValue(fakeChain)
      .compile();

    // trustProxy (ticket 13): the API sits behind Traefik, so the throttler
    // must key on the forwarded client address, not Traefik's own.
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    prisma = app.get(PrismaService);
    await truncate(prisma);
    await seed(prisma);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  it("GET /pool returns the pool and the current epoch", async () => {
    const { body } = await http.get("/pool").expect(200);
    expect(body.pool).toMatchObject({
      address: POOL_ADDRESS,
      poolId: "1",
      currentEpochId: "7",
      totalPrincipal: HUGE_U64,
      paused: false,
      epochAnchor: String(CURRENT_START),
      currentEpochEndsAt: String(CURRENT_START + EPOCH_LENGTH),
      previousEpochEndsAt: String(CURRENT_START),
      // Ticket 05: the whole Pool row rides along, so these need no route
      // change to show up.
      baseRateBps: POOL_BASE_RATE_BPS,
    });
    expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
    // The game and the grant caps left the Pool row with the program's custody-only cut.
    for (const gone of ["roundSeconds", "closeBuffer", "houseCutBps", "ticketsPerUsdc", "bonusCapBps", "weightTree"]) {
      expect(body.pool).not.toHaveProperty(gone);
    }
    expect(body).not.toHaveProperty("openRound");
    // Registration and the Base yield budget left the Pool row.
    expect(body.pool).not.toHaveProperty("carryPot");
    expect(body.pool).not.toHaveProperty("yieldBudget");
    assertNoLargeNumbers(body, "/pool");
  });

  // Ticket 14: the live-yield figures under `live`.
  describe("GET /pool live yield", () => {
    it("returns the paid rates, the estimate, the ceiling, the fee and the Bought Tickets switch", async () => {
      const { body } = await http.get("/pool").expect(200);
      const week = 7 * 86_400;
      // 5% of index rise over exactly the 7 days to the last sync.
      expect(body.live.rates.trailing7d).toMatchObject({ windowSeconds: week, shortHistory: false });
      expect(body.live.rates.trailing7d.aprBps).toBeCloseTo((0.05 * 31_536_000 * 10_000) / week, 1);
      // 1% over exactly 24 hours is 365% a year.
      expect(body.live.rates.trailing24h).toMatchObject({
        aprBps: 36_500,
        windowSeconds: 86_400,
        shortHistory: false,
      });
      // klend at 90% utilisation: borrow 522 bps, supplier 522 x 0.9 x 0.9 =
      // 422.8, times a deployed share of about 1, less the 10% fee.
      expect(body.live.rates.estimatedBps).toBeGreaterThan(380);
      expect(body.live.rates.estimatedBps).toBeLessThan(381);
      expect(body.live.rates.ceilingBps).toBe(POOL_BASE_RATE_BPS);
      expect(body.live.yieldFeeBps).toBe(1_000);
      expect(body.live.buyTicketsPaused).toBe(false);
      expect(body.live.freeIdle).toBe(FREE_IDLE.toString());
      expect(body.live.haircutFactor).toBeNull();
      assertNoLargeNumbers(body, "/pool (live)");
    });

    it("returns the haircut factor while impaired and the Bought Tickets switch as set", async () => {
      // Claims of 20M of Principal, the 3M queued inside it, against 9M in the
      // vault and 10M in the venue's position.
      await prisma.pool.update({
        where: { address: POOL_ADDRESS },
        data: {
          impaired: true,
          buyTicketsPaused: true,
          totalPrincipal: 20_000_000n,
          venueValue: 10_000_000n,
        },
      });
      try {
        const { body } = await http.get("/pool").expect(200);
        // (9,000,000 + 10,000,000) / 20,000,000
        expect(body.live.haircutFactor).toBeCloseTo(19 / 20, 5);
        expect(body.live.buyTicketsPaused).toBe(true);
        expect(body.pool.impaired).toBe(true);
      } finally {
        await prisma.pool.update({
          where: { address: POOL_ADDRESS },
          data: {
            impaired: false,
            buyTicketsPaused: false,
            totalPrincipal: BigInt(HUGE_U64),
            venueValue: POOL_VENUE_VALUE,
          },
        });
      }
    });

    it("says the history is short and uses what exists", async () => {
      const kept = await prisma.yieldIndexPoint.findMany({ where: { poolAddress: POOL_ADDRESS } });
      // Nothing older than 12 hours before the last sync.
      await prisma.yieldIndexPoint.deleteMany({
        where: { poolAddress: POOL_ADDRESS, at: { lt: LAST_SYNC - 43_200n } },
      });
      await prisma.yieldIndexPoint.create({
        data: { poolAddress: POOL_ADDRESS, at: LAST_SYNC - 43_200n, yieldIndex: ((E18 * 1_045n) / 1_000n).toString() },
      });
      try {
        const { body } = await http.get("/pool").expect(200);
        expect(body.live.rates.trailing24h).toMatchObject({
          windowSeconds: 43_200,
          shortHistory: true,
        });
        // 0.5% over half a day is 365% a year.
        expect(body.live.rates.trailing24h.aprBps).toBeCloseTo(36_500, 0);
      } finally {
        await prisma.yieldIndexPoint.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.yieldIndexPoint.createMany({ data: kept });
      }
    });
  });

  describe("GET /rates/daily", () => {
    const TODAY = NOW / 86_400n;
    const at = (daysAgo: bigint, hour: bigint) => (TODAY - daysAgo) * 86_400n + hour * 3_600n;
    // 1% of rise per day is 36,500 bps a year.
    const index = (pct: bigint) => ((E18 * (100n + pct)) / 100n).toString();

    /** Swaps the history for `points`, runs `body`, then restores it. */
    const withHistory = async (
      points: { at: bigint; yieldIndex: string }[],
      body: () => Promise<void>,
    ) => {
      const kept = await prisma.yieldIndexPoint.findMany({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.yieldIndexPoint.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.yieldIndexPoint.createMany({
        data: points.map((p) => ({ ...p, poolAddress: POOL_ADDRESS })),
      });
      try {
        await body();
      } finally {
        await prisma.yieldIndexPoint.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.yieldIndexPoint.createMany({ data: kept });
      }
    };

    it("rates every day from the previous day's last point, using one close per day", async () => {
      await withHistory(
        [
          { at: at(3n, 23n), yieldIndex: index(0n) },
          // Two points on day 2: only the later one closes the day.
          { at: at(2n, 5n), yieldIndex: index(9n) },
          { at: at(2n, 23n), yieldIndex: index(1n) },
          { at: at(1n, 23n), yieldIndex: index(2n) },
          { at: at(0n, 0n), yieldIndex: index(3n) },
        ],
        async () => {
          const { body } = await http.get("/rates/daily?days=3").expect(200);
          expect(body).toHaveLength(3);
          expect(body.map((d: { aprBps: number | null }) => d.aprBps)).toEqual([
            36_500,
            36_500,
            // 1% in the single hour since the previous close.
            876_000,
          ]);
        },
      );
    });

    it("returns null for days without a point, then spans the gap", async () => {
      await withHistory(
        [
          { at: at(5n, 23n), yieldIndex: index(0n) },
          { at: at(1n, 23n), yieldIndex: index(4n) },
        ],
        async () => {
          const { body } = await http.get("/rates/daily?days=4").expect(200);
          const rates = body.map((d: { aprBps: number | null }) => d.aprBps);
          // Days 3, 2 and today: no point. Day 1 spans four days: 1% a day.
          expect(rates).toEqual([null, null, 36_500, null]);
          expect(body[0].day).toBe(new Date(Number(TODAY - 3n) * 86_400_000).toISOString().slice(0, 10));
        },
      );
    });

    it("is null everywhere with one point or an empty table", async () => {
      await withHistory([{ at: at(1n, 3n), yieldIndex: index(1n) }], async () => {
        const { body } = await http.get("/rates/daily?days=3").expect(200);
        expect(body.map((d: { aprBps: number | null }) => d.aprBps)).toEqual([null, null, null]);
      });
      await withHistory([], async () => {
        const { body } = await http.get("/rates/daily").expect(200);
        expect(body).toHaveLength(30);
        expect(body.every((d: { aprBps: number | null }) => d.aprBps === null)).toBe(true);
      });
    });

    it("caps days at 365 and rejects anything but a positive whole number", async () => {
      await withHistory([], async () => {
        const { body } = await http.get("/rates/daily?days=9999").expect(200);
        expect(body).toHaveLength(365);
      });
      for (const bad of ["0", "-1", "1.5", "abc", ""]) {
        await http.get(`/rates/daily?days=${bad}`).expect(400);
      }
    });
  });

  it("GET /epochs returns newest first and honours limit", async () => {
    const { body } = await http.get("/epochs?limit=1").expect(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("7");
    expect(body[0]).not.toHaveProperty("registeredWeight");
    expect(body[0]).not.toHaveProperty("registeredCount");
    assertNoLargeNumbers(body, "/epochs");
  });

  it("GET /epochs rejects a nonsense limit", async () => {
    await http.get("/epochs?limit=abc").expect(400);
    await http.get("/epochs?limit=0").expect(400);
  });

  it("GET /epochs/current reports draw progress for the epoch that just ended", async () => {
    const { body } = await http.get("/epochs/current").expect(200);
    expect(body.id).toBe("7");
    // Open epoch: the indexed snapshot is 0, the vault balance is what shows.
    expect(body.jackpotAmount).toBe(VAULT_BALANCE.toString());
    expect(body.drawing).toEqual({ epochId: "6", status: 1 });
    assertNoLargeNumbers(body, "/epochs/current");
  });

  it("has no /rounds or /positions/counts routes any more", async () => {
    // Rounds and Positions left the program; the backend's own game returns
    // them in wave 2 (off-chain-tickets ticket 10).
    await http.get("/rounds").expect(404);
    await http.get("/rounds/99").expect(404);
    await http.get(`/positions/counts?owners=${ALICE}`).expect(404);
  });

  it("GET /players/:owner returns Principal, unsettled yield as of the last sync, and the Tickets the ledger holds", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    expect(body.owner).toBe(ALICE);
    expect(body.principal).toBe("1000000");
    // Principal x (pool index 1.05e18 - her index 1e18) / 1e18.
    expect(body.unsettledYield).toBe("50000");
    // The seed's one Deposited is all of her Principal, so the position has
    // earned only the unsettled part.
    expect(body.positionYield).toBe("50000");
    expect(body.syncedAt).toBe(LAST_SYNC.toString());
    // She holds every Ticket in the mirror, so all of the odds.
    expect(body.weight).toBe(ALICE_WEIGHT.toString());
    expect(body.odds).toBe("100.00");
    expect(body.pendingTickets).toBe("0");
    expect(body.pendingActivatesEpoch).toBeNull();
    expect(body.tickets).toBe(ALICE_WEIGHT.toString());
    for (const gone of ["entries", "leafIndex", "bonusEpoch", "bonusGranted"]) {
      expect(body).not.toHaveProperty(gone);
    }
    // None of the registration or Base yield fields are left.
    for (const gone of ["weightAcc", "regStart", "frozenWeight", "yieldEpoch", "yieldToDate"]) {
      expect(body).not.toHaveProperty(gone);
    }
    assertNoLargeNumbers(body, "/players/:owner");
  });

  it("GET /players/:owner reports today's bought tickets", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    // boughtEpoch equals the current epoch (7) in the seed, so the counter
    // reads live rather than reset to 0.
    expect(body.boughtToday).toBe(ALICE_BOUGHT_AMOUNT.toString());
    expect(body.buyAllowanceLeft).toBe((1_000_000n - ALICE_BOUGHT_AMOUNT).toString());
    expect(body).not.toHaveProperty("grantedToday");
    assertNoLargeNumbers(body, "/players/:owner (tickets)");
  });

  it("GET /players/:owner floors buyAllowanceLeft at zero once bought spend reaches Principal", async () => {
    await prisma.player.update({
      where: activePlayer(BOB),
      data: { principal: 1_000n, boughtEpoch: CURRENT_EPOCH, boughtAmount: 1_000n },
    });
    try {
      const { body } = await http.get(`/players/${BOB}`).expect(200);
      expect(body.boughtToday).toBe("1000");
      expect(body.buyAllowanceLeft).toBe("0");
    } finally {
      await prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: 0n, boughtEpoch: 0n, boughtAmount: 0n },
      });
    }
  });

  // The Player row lands from the confirmed log path before the finalized
  // `Deposited` row does; counting the new Principal against a basis that lacks
  // it showed the whole deposit as earnings (fork run 2026-10-09).
  it("GET /players/:owner reports positionYield null while the Player row is newer than the newest stored event", async () => {
    const deposit = (slot: bigint, amount: string, principal: string) => ({
      slot,
      signature: `sigLag${slot}`,
      index: 0,
      poolAddress: POOL_ADDRESS,
      name: "Deposited",
      data: { owner: BOB, amount, principal },
      blockTime: NOW,
    });
    const setPlayer = (principal: bigint, slot: bigint) =>
      prisma.player.update({
        where: activePlayer(BOB),
        data: { principal, slot },
      });
    const positionYield = async () => (await http.get(`/players/${BOB}`).expect(200)).body.positionYield;
    try {
      // First deposit: the row is at slot 500, no event that new yet.
      await setPlayer(6_900n, 500n);
      expect(await positionYield()).toBeNull();
      await prisma.event.createMany({ data: [deposit(500n, "6900", "6900")] });
      expect(await positionYield()).toBe("0");

      // Top-up: 1,100 more at slot 600, not in Event yet.
      await setPlayer(8_000n, 600n);
      expect(await positionYield()).toBeNull();
      await prisma.event.createMany({ data: [deposit(600n, "1100", "8000")] });
      expect(await positionYield()).toBe("0");

      // The hourly sweep restamps the unchanged row near the tip, past every
      // event; the newest event's Principal still matches, so no dash.
      await setPlayer(8_000n, 900n);
      expect(await positionYield()).toBe("0");
    } finally {
      await prisma.event.deleteMany({ where: { signature: { in: ["sigLag500", "sigLag600"] } } });
      await prisma.player.update({ where: activePlayer(BOB), data: { principal: 0n, slot: 0n } });
    }
  });

  it("GET /players/:owner gives zero odds to a player with no Tickets", async () => {
    const { body } = await http.get(`/players/${BOB}`).expect(200);
    expect(body.weight).toBe("0");
    expect(body.odds).toBe("0.00");
    expect(body.unsettledYield).toBe("0");
  });

  // Ticket 20: a deposit made today is Principal with no Tickets until the
  // next epoch, and the read folds it the way `touch` does, row untouched.
  it("GET /players/:owner shows a pending deposit as pending Tickets, then none once the epoch has turned", async () => {
    const seed = (epochId: bigint, pendingDepositEpoch: bigint) =>
      prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: 500_000n, epochId, pendingDeposit: 500_000n, pendingDepositEpoch },
      });
    try {
      await seed(CURRENT_EPOCH, CURRENT_EPOCH);
      const today = (await http.get(`/players/${BOB}`).expect(200)).body;
      expect(today.weight).toBe("0");
      expect(today.pendingTickets).toBe("500000");
      expect(today.pendingActivatesEpoch).toBe((CURRENT_EPOCH + 1n).toString());
      expect(today.odds).toBe("0.00");

      // Deposited in epoch 6; the reset at the epoch 7 cutoff gave her Principal as Tickets.
      await seed(CURRENT_EPOCH - 1n, CURRENT_EPOCH - 1n);
      await prisma.ticketBalance.create({
        data: { poolAddress: POOL_ADDRESS, owner: BOB, tickets: 500_000n, principal: 500_000n, epochId: CURRENT_EPOCH },
      });
      const later = (await http.get(`/players/${BOB}`).expect(200)).body;
      expect(later.weight).toBe("500000");
      expect(later.tickets).toBe("500000");
      expect(later.pendingTickets).toBe("0");
      expect(later.pendingActivatesEpoch).toBeNull();
      // Her 500,000 over every Ticket the ledger holds (hers and Alice's 1,000,000).
      expect(later.odds).toBe("33.33");
    } finally {
      await prisma.ticketBalance.deleteMany({ where: { poolAddress: POOL_ADDRESS, owner: BOB } });
      await prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: 0n, epochId: CURRENT_EPOCH, pendingDeposit: 0n, pendingDepositEpoch: 0n },
      });
    }
  });

  // Ticket 23: a queued withdrawal comes with when it pays, the earlier of the
  // pending epoch's end and one epoch length after the request.
  it("GET /players/:owner gives the queued withdrawal's maturity", async () => {
    const queue = (pendingEpoch: bigint, requestedAt: bigint) =>
      prisma.player.update({
        where: activePlayer(BOB),
        data: { pendingWithdraw: 300_000n, pendingEpoch, requestedAt },
      });
    try {
      expect((await http.get(`/players/${BOB}`).expect(200)).body.pendingMaturesAt).toBeNull();

      // Requested a minute ago: the epoch ends 40s sooner than a day after that.
      await queue(CURRENT_EPOCH, NOW - 60n);
      const queued = (await http.get(`/players/${BOB}`).expect(200)).body;
      expect(queued.pendingWithdraw).toBe("300000");
      expect(queued.pendingMaturesAt).toBe((CURRENT_START + EPOCH_LENGTH).toString());

      // Requested 10s before the previous epoch ended: that end comes first.
      await queue(PREVIOUS_EPOCH, CURRENT_START - 10n);
      expect((await http.get(`/players/${BOB}`).expect(200)).body.pendingMaturesAt).toBe(
        CURRENT_START.toString(),
      );
    } finally {
      await prisma.player.update({
        where: activePlayer(BOB),
        data: { pendingWithdraw: 0n, pendingEpoch: 0n, requestedAt: 0n },
      });
    }
  });

  it("GET /players/:owner is 400 for a bad address and 404 for an unknown wallet", async () => {
    await http.get("/players/not-a-wallet").expect(400);
    await http.get(`/players/${Keypair.generate().publicKey.toBase58()}`).expect(404);
  });

  it("GET /leaderboard ranks players by their odds at the draw", async () => {
    const { body } = await http.get("/leaderboard").expect(200);
    expect(body.map((row: { owner: string }) => row.owner)).toEqual([
      ALICE,
      BOB,
      HOUSE,
    ]);
    expect(body[0].odds).toBe("100.00");
    // From the ledger's balance; the retired pool's wallet with 5 Tickets adds nothing.
    expect(body[0].tickets).toBe(ALICE_WEIGHT.toString());
    expect(body[2].isHouse).toBe(true);
    assertNoLargeNumbers(body, "/leaderboard");
  });

  describe("GET /epochs/:id/snapshot", () => {
    const wallets = [ALICE, BOB, HOUSE];
    it("is 404 until the next epoch has begun and the snapshot was taken", async () => {
      await http.get(`/epochs/${CURRENT_EPOCH}/snapshot`).expect(404);
      await http.get("/epochs/99/snapshot").expect(404);
    });

    it("pages the sorted leaves with the sum tree's outputs", async () => {
      await prisma.epoch.update({
        where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: PREVIOUS_EPOCH } },
        data: { snapshotRoot: "ab".repeat(32), snapshotDepth: 2, leafCount: 3, totalTickets: 60n },
      });
      await prisma.epochSnapshot.createMany({
        data: wallets.map((owner, index) => ({ poolAddress: POOL_ADDRESS, epochId: PREVIOUS_EPOCH, index, owner, tickets: BigInt(10 * (index + 1)) })),
      });
      try {
        const first = (await http.get(`/epochs/${PREVIOUS_EPOCH}/snapshot?limit=2`).expect(200)).body;
        expect(first).toMatchObject({
          epochId: PREVIOUS_EPOCH.toString(),
          root: "ab".repeat(32),
          depth: 2,
          leafCount: 3,
          totalTickets: "60",
          nextIndex: 2,
        });
        expect(first.leaves).toEqual([
          { index: 0, owner: ALICE, tickets: "10", reasons: {} },
          { index: 1, owner: BOB, tickets: "20", reasons: {} },
        ]);
        const last = (await http.get(`/epochs/${PREVIOUS_EPOCH}/snapshot?after=2&limit=2`).expect(200)).body;
        expect(last.leaves).toEqual([{ index: 2, owner: HOUSE, tickets: "30", reasons: {} }]);
        expect(last.nextIndex).toBeNull();
        assertNoLargeNumbers(first, "/epochs/:id/snapshot");
        await http.get(`/epochs/${PREVIOUS_EPOCH}/snapshot?limit=0`).expect(400);
        await http.get(`/epochs/${PREVIOUS_EPOCH}/snapshot?after=-1`).expect(400);
      } finally {
        await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.epoch.update({
          where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: PREVIOUS_EPOCH } },
          data: { snapshotRoot: null, snapshotDepth: null, leafCount: null, totalTickets: null },
        });
      }
    });

    it("shows each leaf's ledger sums by reason, adding up to its tickets, with the admin grant's signer", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      const row = (epochId: bigint, reason: TicketReason, delta: bigint, extra: { signer?: string; signature?: string } = {}) =>
        ({ poolAddress: POOL_ADDRESS, owner: wallet, epochId, reason, delta, ref: `${reason}-${epochId}`, ...extra });
      await prisma.ticketLedger.createMany({
        data: [
          // Carried in from epoch 5, before the cutoff reset set the starting balance.
          row(PREVIOUS_EPOCH - 1n, "prize", 40n),
          row(PREVIOUS_EPOCH - 1n, "grant_admin", 7n, { signer: "OLD", signature: "old-sig" }),
          row(PREVIOUS_EPOCH, "reset", 10n),
          row(PREVIOUS_EPOCH, "stake", -30n),
          row(PREVIOUS_EPOCH, "reward", 90n),
          row(PREVIOUS_EPOCH, "refund", 5n),
          row(PREVIOUS_EPOCH, "buy", 25n),
          row(PREVIOUS_EPOCH, "grant_referral", 15n),
          row(PREVIOUS_EPOCH, "grant_admin", 100n, { signer: "TEAM", signature: "team-sig" }),
          row(PREVIOUS_EPOCH, "prize", 200n),
          row(PREVIOUS_EPOCH, "withdraw", -10n),
          // Booked after the snapshot was taken.
          row(CURRENT_EPOCH, "stake", -5n),
        ],
      });
      await prisma.epoch.update({
        where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: PREVIOUS_EPOCH } },
        data: { snapshotRoot: "ab".repeat(32), snapshotDepth: 1, leafCount: 1, totalTickets: 452n },
      });
      await prisma.epochSnapshot.create({ data: { poolAddress: POOL_ADDRESS, epochId: PREVIOUS_EPOCH, index: 0, owner: wallet, tickets: 452n } });
      try {
        const body = (await http.get(`/epochs/${PREVIOUS_EPOCH}/snapshot`).expect(200)).body;
        expect(body).toMatchObject({ root: "ab".repeat(32), depth: 1, leafCount: 1, totalTickets: "452", nextIndex: null });
        const [leaf] = body.leaves;
        expect(leaf.reasons).toEqual({
          reset: "57", // 40 + 7 carried in, plus the reset's 10
          game: "65", // -30 + 90 + 5
          buy: "25",
          grant_referral: "15",
          grant_admin: "100",
          prize: "200",
          withdraw: "-10",
        });
        expect((Object.values(leaf.reasons) as string[]).reduce((sum, v) => sum + BigInt(v), 0n)).toBe(BigInt(leaf.tickets));
        expect(leaf.grants).toEqual([{ amount: "100", ref: `grant_admin-${PREVIOUS_EPOCH}`, signer: "TEAM", signature: "team-sig" }]);
      } finally {
        await prisma.ticketLedger.deleteMany({ where: { owner: wallet } });
        await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.epoch.update({
          where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: PREVIOUS_EPOCH } },
          data: { snapshotRoot: null, snapshotDepth: null, leafCount: null, totalTickets: null },
        });
      }
    });
  });

  describe("GET /players/:owner/ledger", () => {
    it("pages a wallet's 1,000 rows newest first, 100 at a time", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      await prisma.ticketLedger.createMany({
        data: Array.from({ length: 1_000 }, (_, i) => ({
          poolAddress: POOL_ADDRESS, owner: wallet, epochId: CURRENT_EPOCH, reason: "buy" as const, delta: BigInt(i + 1), ref: `r${i}`,
        })),
      });
      try {
        const seen: string[] = [];
        let before = "";
        for (let page = 0; page < 11; page += 1) {
          const body = (await http.get(`/players/${wallet}/ledger?limit=100${before}`).expect(200)).body;
          seen.push(...body.rows.map((r: { delta: string }) => r.delta));
          if (body.nextBefore === null) break;
          before = `&before=${body.nextBefore}`;
        }
        expect(seen).toEqual(Array.from({ length: 1_000 }, (_, i) => String(1_000 - i)));
        const [row] = (await http.get(`/players/${wallet}/ledger?limit=1`).expect(200)).body.rows;
        expect(row).toMatchObject({ epochId: CURRENT_EPOCH.toString(), reason: "buy", ref: "r999", signer: null, signature: null });
        await http.get(`/players/${wallet}/ledger?before=x`).expect(400);
      } finally {
        await prisma.ticketLedger.deleteMany({ where: { owner: wallet } });
      }
    });
  });

  describe("GET /epochs/:id/referral-grants", () => {
    it("lists the epoch's grants with their inputs, and nothing for an epoch without any", async () => {
      expect((await http.get(`/epochs/${PREVIOUS_EPOCH}/referral-grants`).expect(200)).body).toEqual({
        epochId: PREVIOUS_EPOCH.toString(),
        grants: [],
      });
      await prisma.referralGrant.create({
        data: {
          poolAddress: POOL_ADDRESS, epochId: PREVIOUS_EPOCH, referrer: ALICE, amount: 9n, uncapped: 9n, qualifiedCount: 3,
          rateBps: 300, referrerPrincipal: 1_000n, totalPrincipal: 5_000n, bonusCapBps: 500,
        },
      });
      await prisma.referralGrantShare.create({
        data: { poolAddress: POOL_ADDRESS, epochId: PREVIOUS_EPOCH, referrer: ALICE, referee: BOB, amount: 9n, principal: 300n },
      });
      try {
        const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/referral-grants`).expect(200);
        expect(body.grants).toEqual([
          {
            referrer: ALICE, amount: "9", uncapped: "9", tier: 2, rateBps: 300, qualifiedCount: 3, referrerPrincipal: "1000",
            totalPrincipal: "5000", bonusCapBps: 500, referrals: [{ referee: BOB, principal: "300", share: "9" }],
          },
        ]);
        await http.get("/epochs/abc/referral-grants").expect(400);
      } finally {
        await prisma.referralGrantShare.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.referralGrant.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
      }
    });
  });

  describe("GET /epochs/:id/draw", () => {
    const owners = [ALICE, BOB, HOUSE].sort((a, b) =>
      Buffer.compare(new PublicKey(a).toBuffer(), new PublicKey(b).toBuffer()),
    );
    const tree = buildSumTree(
      owners.map((owner, i) => ({ wallet: new PublicKey(owner).toBuffer(), tickets: BigInt(10 * (i + 1)) })),
    );
    const NONCE = "07".repeat(32);
    const epochKey = { poolAddress_id: { poolAddress: POOL_ADDRESS, id: PREVIOUS_EPOCH } };
    const seed = epochSeed(new PublicKey(POOL_ADDRESS), PREVIOUS_EPOCH, Buffer.from(NONCE, "hex"), tree.root, tree.total);
    /** Epoch 6 as the ledger leaves it at `EpochBegan`, then `data` on top. */
    const withSnapshot = async (data: Prisma.EpochUpdateInput, body: () => Promise<void>) => {
      await prisma.epoch.update({
        where: epochKey,
        data: {
          snapshotRoot: tree.root.toString("hex"),
          snapshotDepth: tree.depth,
          leafCount: tree.leafCount,
          totalTickets: tree.total,
          ...data,
        },
      });
      await prisma.epochSnapshot.createMany({
        data: owners.map((owner, index) => ({
          poolAddress: POOL_ADDRESS,
          epochId: PREVIOUS_EPOCH,
          index,
          owner,
          tickets: BigInt(10 * (index + 1)),
        })),
      });
      try {
        await body();
      } finally {
        await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
        await prisma.epoch.update({
          where: epochKey,
          data: {
            status: 1,
            target: "0",
            winner: null,
            nonce: null,
            snapshotRoot: null,
            snapshotDepth: null,
            leafCount: null,
            totalTickets: null,
          },
        });
      }
    };

    it("is 404 until the snapshot exists", async () => {
      await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(404);
      await http.get("/epochs/99/draw").expect(404);
      await http.get("/epochs/x/draw").expect(400);
    });

    it("serves the commitment but keeps the nonce back until request_draw has landed", async () => {
      await withSnapshot({ nonce: NONCE }, async () => {
        const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(200);
        expect(body).toMatchObject({
          epochId: PREVIOUS_EPOCH.toString(),
          status: 1,
          root: tree.root.toString("hex"),
          depth: tree.depth,
          leafCount: 3,
          totalTickets: "60",
          nonce: null,
          seed: null,
          randomness: null,
          target: null,
          winner: null,
          proof: null,
        });
      });
    });

    it("serves the nonce, seed and randomness account once the epoch is Drawing", async () => {
      await withSnapshot({ nonce: NONCE, status: 2 }, async () => {
        const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(200);
        expect(body.nonce).toBe(NONCE);
        expect(body.seed).toBe(seed.toString("hex"));
        expect(body.randomness).toBe(randomnessAddress(PROGRAM_ID, seed, false).toBase58());
        expect(body.winner).toBeNull();
        expect(body.proof).toBeNull();
      });
    });

    it("names no seed or randomness account for an epoch rolled over without a draw", async () => {
      await withSnapshot({ nonce: NONCE, status: 5 }, async () => {
        const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(200);
        expect(body).toMatchObject({ status: 5, nonce: null, seed: null, randomness: null, winner: null });
      });
    });

    it("serves the winner and a proof that reaches the root once the epoch is Drawn", async () => {
      // Tickets 10, 20, 30 in leaf order: the ranges are [0, 10), [10, 30) and [30, 60).
      for (const [target, index] of [[0n, 0], [9n, 0], [10n, 1], [29n, 1], [30n, 2], [59n, 2]] as const) {
        await withSnapshot({ nonce: NONCE, status: 3, target: target.toString() }, async () => {
          const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(200);
          expect(body).toMatchObject({ target: target.toString(), winner: owners[index], winnerIndex: index });
          assertNoLargeNumbers(body, "/epochs/:id/draw");
          const siblings = body.proof.map((s: { hash: string; sum: string }) => ({
            hash: Buffer.from(s.hash, "hex"),
            sum: BigInt(s.sum),
          }));
          expect(siblings).toHaveLength(tree.depth);
          expect(
            verifyPayout(
              tree,
              target,
              body.winnerIndex,
              new PublicKey(body.winner).toBuffer(),
              BigInt(body.winnerTickets),
              siblings,
            ),
          ).toBe(true);
        });
      }
    });

    it("reads the winner as null, not absent, when the stored rows cannot back the root", async () => {
      await withSnapshot({ nonce: NONCE, status: 3, target: "5" }, async () => {
        await prisma.epochSnapshot.deleteMany({ where: { poolAddress: POOL_ADDRESS, index: 2 } });
        const { body } = await http.get(`/epochs/${PREVIOUS_EPOCH}/draw`).expect(200);
        expect(body).toMatchObject({ target: "5", winner: null, proof: null });
      });
    });
  });

  // fork-run-fixes 01: launch week, the pool bootstrapped and `currentEpochId`
  // 0 with no Epoch row. The reads answer with zero odds instead of 404ing.
  describe("before Epoch 1", () => {
    const setEpoch = (currentEpochId: bigint) =>
      prisma.pool.update({ where: { address: POOL_ADDRESS }, data: { currentEpochId } });
    const seedBob = (pendingDeposit: bigint) =>
      prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: pendingDeposit, pendingDeposit, pendingDepositEpoch: 0n, epochId: 0n },
      });

    it("GET /players/:owner and /leaderboard answer for a depositor with a pending deposit", async () => {
      await setEpoch(0n);
      await seedBob(500_000n);
      try {
        const player = (await http.get(`/players/${BOB}`).expect(200)).body;
        expect(player).toMatchObject({ owner: BOB, pendingDeposit: "500000", odds: "0.00" });
        // The same figure as after epoch 1: principal x (pool index - player index) / 1e18.
        const alice = (await http.get(`/players/${ALICE}`).expect(200)).body;
        expect(alice.unsettledYield).toBe("50000");

        const board = (await http.get("/leaderboard").expect(200)).body;
        expect(board.map((row: { owner: string }) => row.owner).sort()).toEqual(
          [ALICE, BOB, HOUSE].sort(),
        );
        expect(board.every((row: { odds: string }) => row.odds === "0.00")).toBe(true);
      } finally {
        await setEpoch(CURRENT_EPOCH);
        await prisma.player.update({
          where: activePlayer(BOB),
          data: { principal: 0n, pendingDeposit: 0n, pendingDepositEpoch: 0n, epochId: CURRENT_EPOCH },
        });
      }
    });
  });

  it("GET /feed keeps user-facing events only, newest first", async () => {
    const { body } = await http.get("/feed").expect(200);
    expect(body.map((event: { name: string }) => event.name)).toEqual([
      // Ticket 14: a processed withdrawal is history too.
      "Withdrawn",
      "JackpotPaid",
      "Deposited",
    ]);
    expect(body[0].data).toMatchObject({ amount: "400000", principal: "1000000" });
    // Operator-only and game events are not news.
    expect(body.every((event: { name: string }) => event.name !== "RoundOpened")).toBe(true);
    assertNoLargeNumbers(body, "/feed");
  });

  it("GET /feed?owner filters to that wallet, keeping a JackpotPaid row by its winner field", async () => {
    // Alice owns every feed-eligible row here, including the JackpotPaid one
    // by its `winner` field: drop that disjunct and this list loses a row.
    const alice = await http.get(`/feed?owner=${ALICE}`).expect(200);
    expect(alice.body.map((event: { name: string }) => event.name)).toEqual([
      "Withdrawn",
      "JackpotPaid",
      "Deposited",
    ]);
    assertNoLargeNumbers(alice.body, "/feed?owner=alice");

    // Bob owns no feed-eligible row, and he is nobody's JackpotPaid winner.
    const bob = await http.get(`/feed?owner=${BOB}`).expect(200);
    expect(bob.body).toEqual([]);
  });

  it("GET /feed?owner adds withdraw requests and cancels, which the public feed leaves out", async () => {
    const signatures = ["sigWdReq", "sigWdCancel"];
    await prisma.event.createMany({
      data: [
        {
          slot: 40n,
          signature: signatures[0] as string,
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "WithdrawRequested",
          data: { owner: ALICE, amount: "6000000", refunded: "5301000", paid: "5301000", pending: "699000" },
          blockTime: NOW - 10n,
        },
        {
          slot: 41n,
          signature: signatures[1] as string,
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "WithdrawCancelled",
          data: { owner: ALICE, amount: "699000", pendingEpoch: "7" },
          blockTime: NOW - 5n,
        },
      ],
    });
    try {
      const mine = await http.get(`/feed?owner=${ALICE}`).expect(200);
      expect(mine.body.slice(0, 2).map((event: { name: string }) => event.name)).toEqual([
        "WithdrawCancelled",
        "WithdrawRequested",
      ]);
      const names = (await http.get("/feed").expect(200)).body.map(
        (event: { name: string }) => event.name,
      );
      expect(names).not.toContain("WithdrawRequested");
      expect(names).not.toContain("WithdrawCancelled");
    } finally {
      await prisma.event.deleteMany({ where: { signature: { in: signatures } } });
    }
  });

  it("GET /status reports the operator, the cursor age and rpc health", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.operator).toMatchObject({ lastAction: "begin_epoch" });
    expect(body.operator).not.toHaveProperty("registeredCount");
    expect(body.operator).not.toHaveProperty("registeredTotal");
    // ISO, not unix seconds: the frontend `Date.parse`s it.
    expect(Date.parse(body.operator.lastTickAt)).toBe(Number(NOW - 2n) * 1000);
    expect(body.cursor.lastSlot).toBe("15");
    expect(body.cursor.ageSeconds).toBeGreaterThanOrEqual(40);
    expect(body.cursor.ageSeconds).toBeLessThan(120);
    expect(body.rpcOk).toBe(true);
    expect(body.slot).toBe(1234);
    assertNoLargeNumbers(body, "/status");
  });

  it("GET /status reports the withdrawal queue, the vault's liquidity and the operator's SOL", async () => {
    const { body } = await http.get("/status").expect(200);
    // u64 amounts as decimal strings, same as every other money field.
    expect(body.pendingWithdrawals).toBe(POOL_PENDING_WITHDRAWALS.toString());
    expect(body.vaultLiquidity).toBe(PRINCIPAL_VAULT_BALANCE.toString());
    // Seeded on the OperatorState row, in atomic units like the rest.
    expect(body.withdrawShortfall).toBe("250000");
    // SOL, not lamports, so the warning threshold reads in the same unit.
    expect(body.operatorSol).toBe(2);
    expect(body.operatorSolLow).toBe(false);
    expect(body.shutdown).toBe(false);
    // Registration and the Base yield shortfall left the API.
    for (const gone of ["registrationIndexerStale", "principalOut", "yieldBudget", "yieldShortfall", "yieldBudgetLow"]) {
      expect(body).not.toHaveProperty(gone);
    }
  });

  // Ticket 05: `/status` carries the same launch time `/state` does, null
  // once the seeded Pool already has an Epoch (every other test in this file).
  it("GET /status carries a null launchAt once the pool has an epoch", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.launchAt).toBeNull();
  });

  it("GET /status carries the configured launch time before Epoch 1", async () => {
    await prisma.pool.update({ where: { address: POOL_ADDRESS }, data: { currentEpochId: 0n } });
    try {
      const { body } = await http.get("/status").expect(200);
      expect(body.launchAt).toBe(process.env.LAUNCH_AT);
    } finally {
      await prisma.pool.update({
        where: { address: POOL_ADDRESS },
        data: { currentEpochId: CURRENT_EPOCH },
      });
    }
  });

  it("GET /healthz reports the operator's SOL and its own status, separate from /status", async () => {
    const { body } = await http.get("/healthz").expect(200);
    expect(body.ok).toBe(true);
    expect(body.operatorSol).toBe(2);
    expect(body.status).toBe("ok");
  });

  // Ticket 14: the live-yield half of /status.
  describe("GET /status live yield", () => {
    it("reports the solvency margin, free idle against the band and the reserve", async () => {
      const { body } = await http.get("/status").expect(200);
      // Vault + venue less principal, past 2^53 like the inputs.
      expect(body.solvencyMargin).toBe(SOLVENCY_MARGIN.toString());
      expect(body.freeIdle).toBe(FREE_IDLE.toString());
      // 6 USDC of free idle against a Principal past 2^53: under one basis point.
      expect(body.freeIdleBps).toBe(0);
      expect(body.idleFloorBps).toBe(500);
      expect(body.idleTargetBps).toBe(1_000);
      // 500 bps of free idle plus a venue position that dwarfs it: under the floor.
      expect(body.freeIdleBelowFloor).toBe(true);
      expect(body.reserveUtilizationBps).toBe(9_000);
      expect(body.reserveFreeLiquidity).toBe(RESERVE_AVAILABLE.toString());
      expect(body.impaired).toBe(false);
      expect(body.deployPaused).toBe(false);
      for (const gone of ["treeNodeCount", "treeCapacity", "treeUsedBps", "bonusGrantedToday", "bonusCap"]) {
        expect(body).not.toHaveProperty(gone);
      }
      assertNoLargeNumbers(body, "/status (live yield)");
    });

    it("counts the Players whose deposit is still waiting for its first Ticket", async () => {
      expect((await http.get("/status").expect(200)).body.pendingDepositPlayers).toBe(0);
      const seed = (pendingDepositEpoch: bigint) =>
        prisma.player.update({
          where: activePlayer(BOB),
          data: { principal: 500_000n, pendingDeposit: 500_000n, pendingDepositEpoch },
        });
      try {
        await seed(CURRENT_EPOCH);
        expect((await http.get("/status").expect(200)).body.pendingDepositPlayers).toBe(1);
        // Deposited an epoch ago: folded into Tickets, nothing waiting.
        await seed(PREVIOUS_EPOCH);
        expect((await http.get("/status").expect(200)).body.pendingDepositPlayers).toBe(0);
      } finally {
        await prisma.player.update({
          where: activePlayer(BOB),
          data: { principal: 0n, pendingDeposit: 0n, pendingDepositEpoch: 0n },
        });
      }
    });

    it("reports a negative margin as a negative number when the pool is short", async () => {
      await prisma.pool.update({ where: { address: POOL_ADDRESS }, data: { venueValue: 0n } });
      try {
        const { body } = await http.get("/status").expect(200);
        expect(BigInt(body.solvencyMargin)).toBe(
          PRINCIPAL_VAULT_BALANCE - BigInt(HUGE_U64),
        );
        expect(body.solvencyMargin.startsWith("-")).toBe(true);
      } finally {
        await prisma.pool.update({
          where: { address: POOL_ADDRESS },
          data: { venueValue: POOL_VENUE_VALUE },
        });
      }
    });
  });

  // pool-cutover ticket 02: the seed also holds a retired pool's rows (see
  // `seedRetiredPool`). Every other test here already fails if a route reads
  // them; these name the ticket's routes outright.
  describe("with a retired pool in the database (ADR 0016)", () => {
    it("GET /epochs returns only the Active pool's rows", async () => {
      const epochs = await http.get("/epochs").expect(200);
      expect(epochs.body.map((epoch: { id: string }) => epoch.id)).toEqual(["7", "6"]);
    });

    it("GET /players/:owner reads the Active pool's Player only", async () => {
      const alice = await http.get(`/players/${ALICE}`).expect(200);
      expect(alice.body.principal).toBe("1000000");
      await http.get(`/players/${CAROL}`).expect(404);
    });

    it("GET /state reads the Active pool's Pool, Epoch and Player", async () => {
      const { body } = await http.get(`/state?owner=${CAROL}`).expect(200);
      expect(body.pool.address).toBe(POOL_ADDRESS);
      expect(body.currentEpoch.id).toBe("7");
      expect(body.player).toBeNull();
    });

    it("GET /status reports the Active pool's operator and cursor", async () => {
      const { body } = await http.get("/status").expect(200);
      expect(body.operator.lastAction).toBe("begin_epoch");
      expect(body.cursor.lastSlot).toBe("15");
      expect(body.pendingWithdrawals).toBe(POOL_PENDING_WITHDRAWALS.toString());
    });

    it("GET /status reads a null operator and cursor for an Active pool with no rows yet", async () => {
      // A fresh cutover: the retired pool's rows are there, the Active
      // pool's are not until the first tick and sync.
      const operator = await prisma.operatorState.findUniqueOrThrow({ where: { poolAddress: POOL_ADDRESS } });
      const cursor = await prisma.cursor.findUniqueOrThrow({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.operatorState.delete({ where: { poolAddress: POOL_ADDRESS } });
      await prisma.cursor.delete({ where: { poolAddress: POOL_ADDRESS } });
      try {
        const { body } = await http.get("/status").expect(200);
        expect(body.operator).toBeNull();
        expect(body.cursor).toEqual({ lastSlot: null, lastSignature: null, ageSeconds: null });
      } finally {
        await prisma.operatorState.create({ data: operator });
        await prisma.cursor.create({ data: cursor });
      }
    });
  });

  describe("GET /alerts", () => {
    // The default seed's OperatorState.withdrawShortfall is 250_000n (see
    // "GET /status reports the withdrawal queue..." above), and every other
    // condition reads healthy against it, so the untouched seed proves the
    // wiring for exactly that code without any setup of its own.
    it("is 503 with exactly WITHDRAW_SHORTFALL against the seeded rows", async () => {
      const { body } = await http.get("/alerts").expect(503);
      expect(body).toEqual({
        alerts: [{ code: "WITHDRAW_SHORTFALL", message: expect.any(String) }],
      });
    });

    it("is 503 with TICKET_LEDGER_MISMATCH once the nightly check finds a wallet out of step", async () => {
      await prisma.operatorState.update({ where: { poolAddress: POOL_ADDRESS }, data: { withdrawShortfall: 0n } });
      await prisma.ledgerCheck.create({ data: { poolAddress: POOL_ADDRESS, checkedAt: NOW, mismatches: 2 } });
      try {
        const { body } = await http.get("/alerts").expect(503);
        expect(body.alerts).toEqual([{ code: "TICKET_LEDGER_MISMATCH", message: expect.any(String) }]);
      } finally {
        await prisma.ledgerCheck.deleteMany();
        await prisma.operatorState.update({ where: { poolAddress: POOL_ADDRESS }, data: { withdrawShortfall: 250_000n } });
      }
    });

    it("is 200 with no alerts once the withdraw shortfall clears", async () => {
      await prisma.operatorState.update({
        where: { poolAddress: POOL_ADDRESS },
        data: { withdrawShortfall: 0n },
      });
      try {
        const { body } = await http.get("/alerts").expect(200);
        expect(body).toEqual({ alerts: [] });
      } finally {
        await prisma.operatorState.update({
          where: { poolAddress: POOL_ADDRESS },
          data: { withdrawShortfall: 250_000n },
        });
      }
    });

    it("is 503 with EPOCH_ROLLED_OVER_RECENTLY, from an Event row in the last hour", async () => {
      await prisma.operatorState.update({
        where: { poolAddress: POOL_ADDRESS },
        data: { withdrawShortfall: 0n },
      });
      await prisma.event.createMany({
        data: [
          {
            slot: 901n,
            signature: "sigAlertsRolledOver",
            index: 0,
            poolAddress: POOL_ADDRESS,
            name: "EpochRolledOver",
            data: { epochId: "7" },
            blockTime: NOW - 30n,
          },
        ],
      });
      try {
        const { body } = await http.get("/alerts").expect(503);
        expect(body.alerts).toEqual([
          { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
        ]);
      } finally {
        await prisma.event.deleteMany({
          where: { signature: "sigAlertsRolledOver" },
        });
        await prisma.operatorState.update({
          where: { poolAddress: POOL_ADDRESS },
          data: { withdrawShortfall: 250_000n },
        });
      }
    });

    // Ticket 14: each live-yield condition, driven by a Pool row change. The
    // shortfall is cleared so the list names only the condition under test.
    describe("live yield", () => {
      const quiet = () =>
        prisma.operatorState.update({
          where: { poolAddress: POOL_ADDRESS },
          data: { withdrawShortfall: 0n },
        });
      const restore = async (data: Prisma.PoolUpdateInput) => {
        await prisma.pool.update({ where: { address: POOL_ADDRESS }, data });
        await prisma.operatorState.update({
          where: { poolAddress: POOL_ADDRESS },
          data: { withdrawShortfall: 250_000n },
        });
      };

      it("fires POOL_IMPAIRED and DEPLOY_PAUSED while their switches are set", async () => {
        await quiet();
        await prisma.pool.update({
          where: { address: POOL_ADDRESS },
          data: { impaired: true, deployPaused: true },
        });
        try {
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts.map((alert: { code: string }) => alert.code)).toEqual([
            "POOL_IMPAIRED",
            "DEPLOY_PAUSED",
          ]);
        } finally {
          await restore({ impaired: false, deployPaused: false });
        }
      });

      it("fires SOLVENCY_NEGATIVE when the vault and venue no longer cover every balance", async () => {
        await quiet();
        await prisma.pool.update({ where: { address: POOL_ADDRESS }, data: { venueValue: 0n } });
        try {
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts.map((alert: { code: string }) => alert.code)).toEqual([
            "SOLVENCY_NEGATIVE",
          ]);
        } finally {
          await restore({ venueValue: POOL_VENUE_VALUE });
        }
      });

      it("fires FREE_IDLE_LOW once free idle has sat under the floor longer than the window", async () => {
        await quiet();
        const controller = app.get(AlertsController) as unknown as { idleLowSince: number | null };
        // The seed's free idle is under its floor, so the clock is running.
        // Backdate it past ALERT_IDLE_LOW_S instead of waiting an hour.
        await http.get("/alerts").expect(200);
        expect(controller.idleLowSince).not.toBeNull();
        controller.idleLowSince = Math.floor(Date.now() / 1000) - 7_200;
        try {
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts.map((alert: { code: string }) => alert.code)).toEqual(["FREE_IDLE_LOW"]);
          // Free idle recovers: the clock stops and the alert goes.
          await prisma.pool.update({ where: { address: POOL_ADDRESS }, data: { idleFloorBps: 0 } });
          await http.get("/alerts").expect(200);
          expect(controller.idleLowSince).toBeNull();
        } finally {
          controller.idleLowSince = null;
          await restore({ idleFloorBps: 500 });
        }
      });

      it("fires VENUE_PROPOSED while a proposal row exists, carrying its pins", async () => {
        await quiet();
        await prisma.venueProposal.create({
          data: {
            poolAddress: POOL_ADDRESS,
            venueKind: 0,
            klendProgram: "KlendProgramPin",
            klendMarket: "KlendMarketPin",
            klendReserve: "KlendReservePin",
            klendCtoken: "KlendCtokenPin",
            proposedAt: 1_800_000_000n,
            updatedSlot: 1n,
          },
        });
        try {
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts).toEqual([{ code: "VENUE_PROPOSED", message: expect.any(String) }]);
          expect(body.alerts[0].message).toContain("KlendProgramPin");
          // proposedAt plus the 48 hour lock.
          expect(body.alerts[0].message).toContain("1800172800");
        } finally {
          await prisma.venueProposal.deleteMany({ where: { poolAddress: POOL_ADDRESS } });
          await restore({});
        }
      });

      it("fires PARAMS_CHANGED for a ParamsSet in the last hour, not an older one", async () => {
        await quiet();
        const row = (signature: string, blockTime: bigint, epochSeconds: string) => ({
          slot: 950n,
          signature,
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "ParamsSet",
          data: { pool: POOL_ADDRESS, epochSeconds, baseRateBps: 488 },
          blockTime,
        });
        await prisma.event.createMany({ data: [row("sigParamsOld", NOW - 7_200n, "1")] });
        try {
          await http.get("/alerts").expect(200);
          await prisma.event.createMany({ data: [row("sigParamsNew", NOW - 60n, "604800")] });
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts).toEqual([{ code: "PARAMS_CHANGED", message: expect.any(String) }]);
          expect(body.alerts[0].message).toContain("epochSeconds=604800");
        } finally {
          await prisma.event.deleteMany({
            where: { signature: { in: ["sigParamsOld", "sigParamsNew"] } },
          });
          await restore({});
        }
      });
    });
  });

  describe("GET /state", () => {
    it("returns the pool, current epoch, status and chain time for a given owner", async () => {
      const { body } = await http.get(`/state?owner=${ALICE}`).expect(200);
      expect(body.pool).toMatchObject({ address: POOL_ADDRESS, currentEpochId: "7" });
      // The browser needs it and no longer reads the Pool account itself.
      expect(body.pool.minDeposit).toBe(POOL_MIN_DEPOSIT.toString());
      // game-jackpot-pause ticket 02: the web reads both switches off here.
      expect(body.pool.gamePaused).toBe(false);
      expect(body.pool.jackpotPaused).toBe(false);
      expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
      // Open epoch: same live-vault-balance rule as GET /epochs/current.
      expect(body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      // Epoch 6 (the one that just ended) is seeded Ended, so the mid-draw
      // case is exercised by the default seed, not extra setup.
      expect(body.currentEpoch.drawing).toEqual({ epochId: "6", status: 1 });
      expect(body.player).toMatchObject({
        owner: ALICE,
        odds: "100.00",
        weight: ALICE_WEIGHT.toString(),
        tickets: ALICE_WEIGHT.toString(),
      });
      // Rounds and Positions left the program (off-chain-tickets ticket 10).
      for (const gone of ["round", "position"]) {
        expect(body).not.toHaveProperty(gone);
      }
      // The off-chain game's Rounds ride along (ticket 16); an idle board has none.
      expect(body).toMatchObject({ nextRoundId: "1", openRound: null, lastRound: null, positions: [] });
      // Wall-clock seconds, the clock the Round countdown reads (ticket 18).
      expect(Math.abs(Number(body.serverTime) - Date.now() / 1000)).toBeLessThan(5);
      expect(body.status.operator).toMatchObject({ lastAction: "begin_epoch" });
      expect(body.status.cursor.lastSlot).toBe("15");
      expect(BigInt(body.chainTime)).toBeGreaterThanOrEqual(CHAIN_NOW);
      // Ticket 08: the cached estimate over the pool's hot writable accounts.
      expect(body.priorityFeeMicroLamports).toBe(FAKE_PRIORITY_FEE);
      assertNoLargeNumbers(body, "/state?owner");
    });

    it("shows the open Round, then the closed one beside the new nextRoundId, and never the seed", async () => {
      const closeAt = new Date(Date.now() + 60_000);
      const round = {
        poolAddress: POOL_ADDRESS,
        epochId: 7n,
        openAt: new Date(),
        closeAt,
        seedCommitment: "c".repeat(64),
        seedSecret: "5".repeat(64),
        tileTotals: Array<string>(36).fill("0"),
        configId: 1,
      };
      await prisma.round.create({ data: { ...round, id: 1n } });
      try {
        const open = (await http.get("/state").expect(200)).body;
        expect(open.nextRoundId).toBe("2");
        expect(open.openRound).toMatchObject({
          id: "1",
          status: "open",
          closeAt: closeAt.toISOString(),
          seedCommitment: "c".repeat(64),
        });
        expect(open.openRound.tileTotals).toHaveLength(36);
        expect(open.lastRound).toBeNull();

        await prisma.round.update({
          where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: 1n } },
          data: { status: "closed" },
        });
        const closed = (await http.get("/state").expect(200)).body;
        expect(closed).toMatchObject({
          nextRoundId: "2",
          openRound: null,
          lastRound: { id: "1", status: "closed", tile: null, seedCommitment: "c".repeat(64) },
        });
        expect(JSON.stringify(closed)).not.toContain("5".repeat(64));
        assertNoLargeNumbers(closed, "/state (rounds)");
      } finally {
        await prisma.round.deleteMany();
      }
    });

    it("omits the Player with no owner given, so a disconnected visitor gets a complete page", async () => {
      const { body } = await http.get("/state").expect(200);
      expect(body.player).toBeNull();
      expect(body.pool).toBeDefined();
      expect(body.currentEpoch).toBeDefined();
      expect(body.status).toBeDefined();
      assertNoLargeNumbers(body, "/state");
    });

    it("ignores the retired round query parameter", async () => {
      await http.get(`/state?owner=${ALICE}&round=99`).expect(200);
    });

    it("returns a null Player, not a 404, for a wallet with no Player account yet", async () => {
      const stranger = Keypair.generate().publicKey.toBase58();
      const { body } = await http.get(`/state?owner=${stranger}`).expect(200);
      expect(body.player).toBeNull();
    });

    // Ticket 05: the deposit-only launch week. currentEpochId 0 with no
    // Epoch row is not the indexer falling behind (that only applies once an
    // Epoch id exists to mirror); `/state` returns a null Epoch and the
    // configured launch time instead of 404ing.
    it("returns a null current epoch and the launch time before Epoch 1, instead of 404", async () => {
      // game-jackpot-pause ticket 02: a new pool sits here, both switches on,
      // for as long as the deposit-only week lasts.
      await prisma.pool.update({
        where: { address: POOL_ADDRESS },
        data: { currentEpochId: 0n, gamePaused: true, jackpotPaused: true },
      });
      try {
        const { body } = await http.get(`/state?owner=${ALICE}`).expect(200);
        expect(body.pool).toMatchObject({ gamePaused: true, jackpotPaused: true });
        expect(body.currentEpoch).toBeNull();
        expect(body.launchAt).toBe(process.env.LAUNCH_AT);
        // Deposits still show the depositor's real Principal even with no Epoch.
        expect(body.player).toMatchObject({ owner: ALICE, principal: "1000000" });
        assertNoLargeNumbers(body, "/state (no epoch)");
      } finally {
        await prisma.pool.update({
          where: { address: POOL_ADDRESS },
          data: { currentEpochId: CURRENT_EPOCH, gamePaused: false, jackpotPaused: false },
        });
      }
    });

    it("rejects a malformed owner", async () => {
      await http.get("/state?owner=not-a-wallet").expect(400);
    });
  });

  describe("chain read caching", () => {
    // Fakes only `Date`, leaving real timers and I/O alone, so `Date.now()`
    // inside the service's TTL caches is controlled without slowing the
    // suite down with real waits. Installed once for the whole block rather
    // than per test: each test only ever advances this clock forward from
    // wherever the previous one left it, so it can never land behind a
    // cache timestamp an earlier test already stamped (which resetting to
    // the real "now" between tests could do, reading a still-fresh cache as
    // stale-checked-clean by accident).
    beforeAll(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it("collapses a concurrent burst of chain-clock reads to one call, then reads again after the window", async () => {
      // Past the window from whatever an earlier test left cached, so the
      // burst below starts from a cold cache.
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const before = clockReads;

      const burst = await Promise.all([http.get("/state"), http.get("/state"), http.get("/state")]);
      burst.forEach((response) => expect(response.status).toBe(200));
      expect(clockReads).toBe(before + 1);

      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      await http.get("/state").expect(200);
      expect(clockReads).toBe(before + 2);
    });

    it("never serves a chainTime below one it already served, when the chain clock drifts behind wall time", async () => {
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const first = await http.get("/state").expect(200);
      const served = BigInt(first.body.chainTime);

      // The Clock sysvar advances slower than wall time, so the window's
      // wall-time extrapolation overshoots and the next fresh read lands
      // below what the previous response already carried.
      chainClockValue = CHAIN_NOW - 5n;
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      try {
        const second = await http.get("/state").expect(200);
        expect(BigInt(second.body.chainTime)).toBeGreaterThanOrEqual(served);
      } finally {
        chainClockValue = CHAIN_NOW;
      }
    });

    it("collapses a concurrent burst of jackpot balance reads to one call, then reads again after the window", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;

      const burst = await Promise.all([
        http.get("/epochs/current"),
        http.get("/epochs/current"),
        http.get("/epochs/current"),
      ]);
      burst.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.jackpotAmount).toBe(VAULT_BALANCE.toString());
      });
      expect(jackpotReads).toBe(before + 1);

      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      await http.get("/epochs/current").expect(200);
      expect(jackpotReads).toBe(before + 2);
    });

    it("falls back to the indexed snapshot on a failed jackpot read, without caching the fallback", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;
      failNextJackpotRead = true;

      const failed = await http.get("/epochs/current").expect(200);
      // Epoch 7's indexed jackpotAmount is seeded at 0, distinct from
      // VAULT_BALANCE, so this proves the fallback path ran rather than a
      // stale success.
      expect(failed.body.jackpotAmount).toBe("0");
      expect(jackpotReads).toBe(before + 1);

      // Still inside the window the failed read opened. A cache poisoned
      // with the "0" fallback would keep serving it here; the failed
      // attempt must instead have cleared the cache slot, so this retries
      // the chain and sees the vault balance again.
      const recovered = await http.get("/epochs/current").expect(200);
      expect(recovered.body.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 2);
    });

    it("reports the balances as unknown on a failed read, without caching that", async () => {
      vi.setSystemTime(Date.now() + BALANCES_TTL_MS + 1);
      const before = balanceReads;
      failNextBalanceRead = true;

      const { body } = await http.get("/status").expect(200);
      expect(body.vaultLiquidity).toBeNull();
      expect(body.operatorSol).toBeNull();
      // Null, not false: a failed read is not evidence of a funded key, and
      // false would keep the "operator is running dry" banner off for as
      // long as the RPC stayed down.
      expect(body.operatorSolLow).toBeNull();
      // The same read carries the reserve, so its figures are unknown too.
      expect(body.reserveFreeLiquidity).toBeNull();
      expect(body.solvencyMargin).toBeNull();
      expect(balanceReads).toBe(before + 1);

      // Still inside the window the failed read opened. A slot left holding
      // the failure would serve nulls for the whole TTL; it has to have
      // been cleared, so this retries the chain.
      const recovered = await http.get("/status").expect(200);
      expect(recovered.body.vaultLiquidity).toBe(PRINCIPAL_VAULT_BALANCE.toString());
      expect(recovered.body.operatorSolLow).toBe(false);
      expect(balanceReads).toBe(before + 2);
    });

    it("GET /state advances the cached chain time by the wall time elapsed since it was observed, with no extra clock read", async () => {
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const before = clockReads;
      // The no-backwards clamp outlives each test. An earlier real-time test
      // that ran a second past its clock read (a loaded machine, as on
      // pre-push) leaves it at CHAIN_NOW + 1, which this fresh read would
      // then serve instead of CHAIN_NOW.
      (app.get(ApiService) as unknown as { lastServedChainTime: bigint }).lastServedChainTime = 0n;

      const fresh = await http.get("/state").expect(200);
      expect(clockReads).toBe(before + 1);
      expect(fresh.body.chainTime).toBe(CHAIN_NOW.toString());

      // Still inside the TTL window: the same cached clock value, now
      // extrapolated forward by the whole second that elapsed, with no new
      // read of the chain.
      vi.setSystemTime(Date.now() + 1_500);
      const later = await http.get("/state").expect(200);
      expect(clockReads).toBe(before + 1);
      expect(later.body.chainTime).toBe((CHAIN_NOW + 1n).toString());
    });

    it("GET /state reuses the cached jackpot balance for the open epoch's live amount", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;

      const first = await http.get("/state").expect(200);
      expect(first.body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 1);

      const second = await http.get("/state").expect(200);
      expect(second.body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 1);
    });

    // fork-run-fixes 02 and 06: the open epoch's jackpot is the vault less
    // `jackpotReserved`, plus `prizeOwed` for the display routes only. Each
    // test steps the clock past the vault read's cache first.
    describe("open epoch jackpot", () => {
      const configure = async (
        vault: bigint,
        pool: { prizeOwed?: bigint; jackpotReserved?: bigint; minJackpot?: bigint },
      ): Promise<void> => {
        vaultBalance = vault;
        await prisma.pool.update({ where: { address: POOL_ADDRESS }, data: pool });
        vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      };
      const reset = async (): Promise<void> => {
        vaultBalance = VAULT_BALANCE;
        await prisma.pool.update({
          where: { address: POOL_ADDRESS },
          data: { prizeOwed: 0n, jackpotReserved: 0n, minJackpot: 1_000_000n },
        });
        vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      };
      const amounts = async () => ({
        current: (await http.get("/epochs/current").expect(200)).body.jackpotAmount,
        state: (await http.get("/state").expect(200)).body.currentEpoch.jackpotAmount,
        status: (await http.get("/status").expect(200)).body.jackpotAmount,
      });

      it("adds the booked prize share to the display figure, not to /status", async () => {
        await configure(5n, { prizeOwed: 7n });
        try {
          expect(await amounts()).toEqual({ current: "12", state: "12", status: "5" });
        } finally {
          await reset();
        }
      });

      it("reports 0 while the vault holds only a drawn, unpaid prize", async () => {
        await configure(50n, { jackpotReserved: 50n });
        try {
          expect(await amounts()).toEqual({ current: "0", state: "0", status: "0" });
        } finally {
          await reset();
        }
      });

      it("floors at 0 when the reserve outruns the vault", async () => {
        await configure(10n, { jackpotReserved: 50n, prizeOwed: 3n });
        try {
          expect(await amounts()).toEqual({ current: "3", state: "3", status: "0" });
        } finally {
          await reset();
        }
      });

      it("keeps the snapshot of an ended epoch and ignores prizeOwed", async () => {
        await configure(5n, { prizeOwed: 7n });
        await prisma.epoch.update({
          where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: CURRENT_EPOCH } },
          data: { status: 1, jackpotAmount: 9n },
        });
        try {
          const { body } = await http.get("/epochs/current").expect(200);
          expect(body.jackpotAmount).toBe("9");
        } finally {
          await prisma.epoch.update({
            where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: CURRENT_EPOCH } },
            data: { status: 0, jackpotAmount: 0n },
          });
          await reset();
        }
      });

      it("falls back to the indexed snapshot plus prizeOwed on a failed vault read", async () => {
        await configure(5n, { prizeOwed: 7n });
        failNextJackpotRead = true;
        try {
          const { body } = await http.get("/epochs/current").expect(200);
          // Epoch 7's snapshot is seeded at 0.
          expect(body.jackpotAmount).toBe("7");
        } finally {
          await reset();
        }
      });

      // `prizeOwed` 7 would lift the vault's 5 over `minJackpot` 6 if /status
      // counted it, and a failed harvest would hide behind it.
      it.each([
        ["prizeOwed does not count", 5n, { prizeOwed: 7n, minJackpot: 6n }],
        ["a reserved prize does not count", 50n, { jackpotReserved: 50n, minJackpot: 10n }],
      ])("fires JACKPOT_LOW_NEAR_CLOSE in the last hour when %s", async (_name, vault, pool) => {
        await configure(vault, pool);
        const endsAt = { poolAddress_id: { poolAddress: POOL_ADDRESS, id: CURRENT_EPOCH } };
        await prisma.epoch.update({
          where: endsAt,
          data: { endsAt: BigInt(Math.floor(Date.now() / 1000) + 600) },
        });
        try {
          const { body } = await http.get("/alerts");
          expect(body.alerts.map((alert: { code: string }) => alert.code)).toContain(
            "JACKPOT_LOW_NEAR_CLOSE",
          );
        } finally {
          await prisma.epoch.update({ where: endsAt, data: { endsAt: CURRENT_START + EPOCH_LENGTH } });
          await reset();
        }
      });
    });
  });

  // ticket 13: Fastify trusts Traefik's forwarded address, so the throttler
  // (which is otherwise IP-keyed) gives each real client its own bucket
  // instead of one shared bucket for every request Traefik forwards.
  describe("GET /access/:wallet throttling keys on the forwarded address", () => {
    it("throttles one forwarded address without touching another's budget", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      for (let i = 0; i < 10; i += 1) {
        await http
          .get(`/access/${wallet}`)
          .set("x-forwarded-for", "203.0.113.11")
          .expect(200);
      }
      const throttled = await http
        .get(`/access/${wallet}`)
        .set("x-forwarded-for", "203.0.113.11");
      expect(throttled.status).toBe(429);

      // A different forwarded client has its own, untouched budget.
      await http.get(`/access/${wallet}`).set("x-forwarded-for", "203.0.113.12").expect(200);
    });
  });

  // mainnet-readiness-fixes 10: anyone can post here and the rows land in the
  // Postgres the indexer and operator share, so it is throttled per IP.
  describe("POST /error-reports throttling", () => {
    it("answers 429 on the 6th post in a minute from one address, not another", async () => {
      const report = { code: "render_error", message: "boom" };
      for (let i = 0; i < 5; i += 1) {
        await http.post("/error-reports").set("x-forwarded-for", "203.0.113.21").send(report).expect(201);
      }
      await http.post("/error-reports").set("x-forwarded-for", "203.0.113.21").send(report).expect(429);
      await http.post("/error-reports").set("x-forwarded-for", "203.0.113.22").send(report).expect(201);
    });
  });

  describe("POST /faucet", () => {
    it("rejects a body without a usable owner", async () => {
      await http.post("/faucet").send({}).expect(400);
      await http.post("/faucet").send({ owner: "not-a-wallet" }).expect(400);
    });

    it("mints once, then answers 429 with retryAfterSeconds", async () => {
      const before = sentInstructions.length;
      const first = await http.post("/faucet").send({ owner: BOB }).expect(201);
      expect(first.body).toMatchObject({
        owner: BOB,
        amount: "1000000000",
        signature: FAKE_SIGNATURE,
      });
      // createAssociatedTokenAccountIdempotent + mintTo, one transaction.
      expect(sentInstructions).toHaveLength(before + 1);
      expect(sentInstructions[before]).toHaveLength(2);
      assertNoLargeNumbers(first.body, "/faucet");

      const second = await http.post("/faucet").send({ owner: BOB }).expect(429);
      expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.body.retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(sentInstructions).toHaveLength(before + 1);
    });

    it("is 404 when the operator is not the mint authority", async () => {
      // What mainnet looks like: the accepted mint is real USDC and nobody
      // here can mint it, so the route is not there at all.
      const faucet = app.get(FaucetController);
      const resolved = faucet.isMintAuthority;
      expect(resolved).toBe(true);
      faucet.isMintAuthority = false;
      try {
        const before = sentInstructions.length;
        await http.post("/faucet").send({ owner: ALICE }).expect(404);
        expect(sentInstructions).toHaveLength(before);
      } finally {
        faucet.isMintAuthority = resolved;
      }
    });

    // Last in the file: it deliberately burns the caller's per-IP budget.
    it("rate limits the caller by IP", async () => {
      let throttled = false;
      for (let attempt = 0; attempt < 20 && !throttled; attempt += 1) {
        const response = await http.post("/faucet").send({ owner: "nope" });
        // Only the throttler sets Retry-After; the per-owner 429 does not.
        throttled = response.headers["retry-after"] !== undefined;
      }
      expect(throttled).toBe(true);

      // The read routes the frontend polls every 2 s share no budget with it.
      for (let poll = 0; poll < 15; poll += 1) {
        await http.get("/pool").expect(200);
      }
      await http.get("/healthz").expect(200);
    });
  });
});

async function seed(prisma: PrismaService): Promise<void> {
  const activePool: Prisma.PoolUncheckedCreateInput = {
    address: POOL_ADDRESS,
    poolId: 1n,
    admin: HOUSE,
    operator: HOUSE,
    pendingAdmin: null,
    mint: Keypair.generate().publicKey.toBase58(),
    pendingWithdrawals: POOL_PENDING_WITHDRAWALS,
    minJackpot: 1_000_000n,
    epochSeconds: EPOCH_LENGTH,
    epochAnchor: CURRENT_START,
    minDeposit: POOL_MIN_DEPOSIT,
    paused: false,
    currentEpochId: CURRENT_EPOCH,
    currentEpochEndsAt: CURRENT_START + EPOCH_LENGTH,
    previousEpochEndsAt: CURRENT_START,
    totalPrincipal: BigInt(HUGE_U64),
    baseRateBps: POOL_BASE_RATE_BPS,
    version: 1,
    shutdown: false,
    // Ticket 14: the venue, the index and the band.
    ...LIVE_POOL_DEFAULTS,
    klendReserve: RESERVE.toBase58(),
    yieldIndex: POOL_YIELD_INDEX.toString(),
    venueValue: POOL_VENUE_VALUE,
    lastSyncAt: LAST_SYNC,
    yieldFeeBps: 1_000,
    idleFloorBps: 500,
    idleTargetBps: 1_000,
    updatedSlot: 15n,
  };
  // The retired pool first, so an unscoped `findFirst` would most likely
  // land on it rather than on the Active pool by luck of insertion order.
  await seedRetiredPool(prisma, activePool);
  await prisma.pool.create({ data: activePool });

  await prisma.epoch.createMany({
    data: [
      {
        poolAddress: POOL_ADDRESS,
        id: PREVIOUS_EPOCH,
        startsAt: PREVIOUS_START,
        endsAt: CURRENT_START,
        status: 1, // Ended
        jackpotAmount: 12_000_000n,
        target: "0",
        winner: null,
      },
      {
        poolAddress: POOL_ADDRESS,
        id: CURRENT_EPOCH,
        startsAt: CURRENT_START,
        endsAt: CURRENT_START + EPOCH_LENGTH,
        status: 0, // Open
        jackpotAmount: 0n,
        target: "0",
        winner: null,
      },
    ],
  });

  await prisma.player.createMany({
    data: [
      {
        ...emptyPlayer(ALICE),
        principal: 1_000_000n,
        yieldIndex: ALICE_YIELD_INDEX.toString(),
        boughtEpoch: CURRENT_EPOCH,
        boughtAmount: ALICE_BOUGHT_AMOUNT,
      },
      // Withdrew everything, so no Tickets this epoch.
      { ...emptyPlayer(BOB), yieldIndex: POOL_YIELD_INDEX.toString() },
      { ...emptyPlayer(HOUSE), isHouse: true },
    ],
  });
  // The ledger holds her Tickets; Bob has no balance row.
  await prisma.ticketBalance.create({
    data: { poolAddress: POOL_ADDRESS, owner: ALICE, tickets: ALICE_WEIGHT, principal: 1_000_000n, epochId: CURRENT_EPOCH },
  });

  await prisma.event.createMany({
    data: [
      { slot: 10n, signature: "sig10", index: 0, name: "Deposited", data: { owner: ALICE, amount: "1000000" }, blockTime: NOW - 300n },
      { slot: 14n, signature: "sig14", index: 0, name: "JackpotPaid", data: { winner: ALICE, amount: "12000000", isHouse: false }, blockTime: NOW - 100n },
      // Operator-only and game events stay out of the feed.
      { slot: 15n, signature: "sig15", index: 0, name: "RoundOpened", data: { roundId: "100" }, blockTime: NOW - 50n },
      // Ticket 14: a player's history also shows a processed withdrawal.
      { slot: 19n, signature: "sig19", index: 0, name: "Withdrawn", data: { owner: ALICE, amount: "400000", principal: "1000000", yieldIndex: "1000000000000000000" }, blockTime: NOW - 20n },
    ].map((row) => ({ ...row, poolAddress: POOL_ADDRESS })),
  });

  await prisma.cursor.create({
    data: { poolAddress: POOL_ADDRESS, lastSignature: "sig15", lastSlot: 15n, updatedAt: NOW - 42n },
  });

  await prisma.operatorState.create({
    data: {
      poolAddress: POOL_ADDRESS,
      lastTickAt: NOW - 2n,
      lastAction: "begin_epoch",
      lastError: null,
      withdrawShortfall: 250_000n,
    },
  });

  // Ticket 14: the index history behind the trailing rates (5% over the 7
  // days to LAST_SYNC, 1% over the last 24 hours) and the reserve address the
  // Pool row pins.
  await prisma.yieldIndexPoint.createMany({
    data: [
      { at: LAST_SYNC - 7n * EPOCH_LENGTH, yieldIndex: E18.toString() },
      { at: LAST_SYNC - EPOCH_LENGTH, yieldIndex: ((E18 * 104n) / 100n).toString() },
    ].map((row) => ({ ...row, poolAddress: POOL_ADDRESS })),
  });
}

/**
 * A retired pool's rows, left behind by a Pool cutover (ADR 0016). Each one
 * collides with an Active-pool key (epoch 7, Alice's Player) or sorts ahead of
 * the Active pool's rows (epoch 9, event slots 30+), so a route that forgot its `poolAddress` filter
 * returns something the exact-match assertions above do not expect.
 */
async function seedRetiredPool(
  prisma: PrismaService,
  activePool: Prisma.PoolUncheckedCreateInput,
): Promise<void> {
  const retiredEpoch = CURRENT_EPOCH + 2n;
  await prisma.pool.create({
    data: {
      ...activePool,
      address: RETIRED_POOL_ADDRESS,
      poolId: 0n,
      currentEpochId: retiredEpoch,
      totalPrincipal: 1n,
      pendingWithdrawals: 0n,
      updatedSlot: 1n,
    },
  });
  await prisma.epoch.createMany({
    data: [CURRENT_EPOCH, CURRENT_EPOCH + 1n, retiredEpoch].map((id) => ({
      poolAddress: RETIRED_POOL_ADDRESS,
      id,
      startsAt: 0n,
      endsAt: 1n,
      status: 3,
      jackpotAmount: 1n,
      target: "0",
      winner: null,
    })),
  });
  await prisma.player.createMany({
    data: [
      { ...emptyPlayer(ALICE, RETIRED_POOL_ADDRESS), principal: 777n },
      // Holds Tickets, so an unscoped scan would hand her a share of the odds.
      { ...emptyPlayer(CAROL, RETIRED_POOL_ADDRESS), principal: 5n },
    ],
  });
  await prisma.ticketBalance.create({
    data: { poolAddress: RETIRED_POOL_ADDRESS, owner: CAROL, tickets: 5n, principal: 5n, epochId: 9n },
  });
  await prisma.event.createMany({
    data: [
      { slot: 30n, signature: "retired30", index: 0, name: "Deposited", data: { owner: ALICE, amount: "777" }, blockTime: NOW - 20n },
      { slot: 31n, signature: "retired31", index: 0, name: "Withdrawn", data: { owner: ALICE, amount: "1", principal: "1", yieldIndex: "1000000000000000000" }, blockTime: NOW - 15n },
      { slot: 33n, signature: "retired33", index: 0, name: "EpochRolledOver", data: { epochId: "9" }, blockTime: NOW - 5n },
    ].map((row) => ({ ...row, poolAddress: RETIRED_POOL_ADDRESS })),
  });
  await prisma.cursor.create({
    data: { poolAddress: RETIRED_POOL_ADDRESS, lastSignature: "retired33", lastSlot: 999n, updatedAt: NOW - 5_000n },
  });
  await prisma.operatorState.create({
    data: {
      poolAddress: RETIRED_POOL_ADDRESS,
      lastTickAt: NOW - 9_000n,
      lastAction: "retired_tick",
      lastError: null,
      withdrawShortfall: 0n,
    },
  });
}
