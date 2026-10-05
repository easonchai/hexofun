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
import { Prisma, type Player } from "@prisma/client";
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
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { LIVE_PLAYER_DEFAULTS, LIVE_POOL_DEFAULTS } from "../test-utils/live-yield-defaults";
import { AlertsController } from "./alerts.controller";
import { ApiModule } from "./api.module";
import { FaucetController } from "./faucet.controller";
import {
  BALANCES_TTL_MS,
  CHAIN_CLOCK_TTL_MS,
  JACKPOT_BALANCE_TTL_MS,
  oddsPercent,
  operatorErrorCode,
  playerTicketExtras,
  poolBonusCap,
  TREE_TTL_MS,
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

// Both sit past 2^53, so a route that leaked a JSON number would round the
// value rather than return these digits. u64 columns cannot take the u128 one.
const HUGE_U64 = "9007199254740993";
const HUGE_U128 = "123456789012345678901234567890";

const FAKE_SIGNATURE = "FakeSignature1111111111111111111111111111111";
/** What the fake RPC says sits in the jackpot vault while epoch 7 is open. */
const VAULT_BALANCE = 5_000_000n;
/** GET /state's ticket 08 field: the fake `priorityFeeMicroLamports`'s
 *  canned answer. */
const FAKE_PRIORITY_FEE = 4_242;
/** The seeded Pool row's `closeBuffer`/`minDeposit`, which the browser reads
 *  off `/state` rather than off the chain (ticket 07). */
const POOL_CLOSE_BUFFER = 15n;
const POOL_MIN_DEPOSIT = 1_000_000n;

/** Ticket 03's `/status` figures: what the pool owes, what the principal
 *  vault holds against it, and what the operator has left for fees. */
const POOL_PENDING_WITHDRAWALS = 3_000_000n;
const PRINCIPAL_VAULT_BALANCE = 9_000_000n;
const OPERATOR_LAMPORTS = 2 * LAMPORTS_PER_SOL;

/** Ticket 05's `/status`, `/pool` and `/players/:owner` figures: the ceiling
 *  rate, bought tickets and granted tickets. */
const POOL_BASE_RATE_BPS = 488;
const POOL_TICKETS_PER_USDC = 10;
const POOL_BONUS_CAP_BPS = 500;
const POOL_BONUS_GRANTED = 250_000n;
const ALICE_BOUGHT_AMOUNT = 200_000n;
const ALICE_BONUS_GRANTED = 50_000n;

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
const WEIGHT_TREE = Keypair.generate().publicKey;
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

/**
 * The Weight tree with Alice on leaf 1 holding the whole epoch-7 draw, Bob on
 * leaf 2 and the House on leaf 3 holding nothing. Epoch 7 is odd, so it lives
 * in the second slot of a node. Fenwick node 2 sums leaves 1 and 2.
 */
function weightTreeData(): Buffer {
  const header = 56;
  const nodeSize = 56;
  const data = Buffer.alloc(header + 3 * nodeSize);
  data.writeUInt8(1, 8);
  data.writeBigUInt64LE(3n, 16);
  const node = (index: number, principalSum: bigint, weight: bigint | null) => {
    const at = header + index * nodeSize;
    data.writeBigUInt64LE(principalSum, at);
    if (weight === null) return;
    const slot = at + 8 + 24;
    data.writeBigUInt64LE(CURRENT_EPOCH, slot);
    data.writeBigUInt64LE(principalSum, slot + 8);
    data.writeBigUInt64LE(weight, slot + 16);
  };
  node(0, 1_000_000n, ALICE_WEIGHT);
  node(1, 0n, ALICE_WEIGHT);
  node(2, 0n, null);
  return data;
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
let treeReads = 0;
/** When set, the next `getTokenAccountBalance` call throws once and resets it. */
let failNextJackpotRead = false;
/** Same, for the paired vault/operator balance read behind /status. */
let failNextBalanceRead = false;
/** Same, for the Weight tree account read behind a Player's Weight. */
let failNextTreeRead = false;
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
      if (address.equals(WEIGHT_TREE)) {
        treeReads += 1;
        if (failNextTreeRead) {
          failNextTreeRead = false;
          throw new Error("simulated weight tree read failure");
        }
        return accountInfo(weightTreeData(), SystemProgram.programId);
      }
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
      return { value: { amount: VAULT_BALANCE.toString() } };
    },
  },
  poolAddress: (): PublicKey => new PublicKey(POOL_ADDRESS),
  jackpotVaultAddress: (): PublicKey => Keypair.generate().publicKey,
  principalVaultAddress: (): PublicKey => PRINCIPAL_VAULT,
  roundAddress: (): PublicKey => Keypair.generate().publicKey,
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
  entries: 0n,
  epochId: CURRENT_EPOCH,
  isHouse: false,
  pendingWithdraw: 0n,
  pendingEpoch: 0n,
  boughtEpoch: 0n,
  boughtAmount: 0n,
  bonusEpoch: 0n,
  bonusGranted: 0n,
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
    'TRUNCATE "Pool", "Epoch", "Round", "Player", "Position", "Event", "Cursor", "FaucetClaim", "OperatorState", "YieldIndexPoint", "WeightTreeState" CASCADE',
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

describe("poolBonusCap", () => {
  it("mirrors the on-chain pool_bonus_cap", () => {
    expect(poolBonusCap(1_000_000_000n, 500)).toBe(50_000_000n);
  });

  it("is zero at a zero cap", () => {
    expect(poolBonusCap(1_000_000_000n, 0)).toBe(0n);
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
      player({ boughtEpoch: 7n, boughtAmount: 300_000n, bonusEpoch: 7n, bonusGranted: 40_000n }),
      7n,
    );
    expect(extras).toEqual({
      boughtToday: 300_000n,
      buyAllowanceLeft: 700_000n,
      grantedToday: 40_000n,
    });
  });

  it("reads a counter from a past epoch as already reset to 0", () => {
    // The on-chain reset only happens the next time buy_tickets/grant_tickets
    // actually runs for the new epoch, so a leftover epoch=6 value must not
    // leak into epoch 7's figures.
    const extras = playerTicketExtras(
      player({ boughtEpoch: 6n, boughtAmount: 300_000n, bonusEpoch: 6n, bonusGranted: 40_000n }),
      7n,
    );
    expect(extras).toEqual({ boughtToday: 0n, buyAllowanceLeft: 1_000_000n, grantedToday: 0n });
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

  it("GET /pool returns the pool, the current epoch and the open round", async () => {
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
      ticketsPerUsdc: POOL_TICKETS_PER_USDC,
      bonusCapBps: POOL_BONUS_CAP_BPS,
    });
    expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
    expect(body.openRound).toEqual({
      id: "100",
      epochId: "7",
      startsAt: String(CURRENT_START),
      endsAt: String(CURRENT_START + 60n),
      status: 0,
      pot: "5000",
      houseCut: "0",
    });
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

  it("GET /rounds returns newest first with the winning tile and the pot", async () => {
    const { body } = await http.get("/rounds").expect(200);
    expect(body.map((round: { id: string }) => round.id)).toEqual(["100", "99"]);
    expect(body[1]).toMatchObject({ winningTile: 17, pot: "4000", status: 2 });
    assertNoLargeNumbers(body, "/rounds");
  });

  it("GET /rounds/:id returns one round with its tile totals", async () => {
    const { body } = await http.get("/rounds/99").expect(200);
    expect(body.id).toBe("99");
    expect(body.tileTotals).toEqual({ "17": "4000" });
    assertNoLargeNumbers(body, "/rounds/99");
  });

  it("GET /rounds/:id is 404 for an unknown round and 400 for a non-numeric id", async () => {
    await http.get("/rounds/4242").expect(404);
    await http.get("/rounds/abc").expect(400);
  });

  it("GET /players/:owner returns Principal, unsettled yield as of the last sync, and the Weight the tree holds", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    expect(body.owner).toBe(ALICE);
    expect(body.principal).toBe("1000000");
    // Principal x (pool index 1.05e18 - her index 1e18) / 1e18.
    expect(body.unsettledYield).toBe("50000");
    expect(body.syncedAt).toBe(LAST_SYNC.toString());
    // Read from the tree: she holds the whole epoch, so all of the odds.
    expect(body.weight).toBe(ALICE_WEIGHT.toString());
    expect(body.odds).toBe("100.00");
    expect(body.pendingTickets).toBe("0");
    expect(body.pendingActivatesEpoch).toBeNull();
    expect(body.leafIndex).toBe(1);
    // None of the registration or Base yield fields are left.
    for (const gone of ["weightAcc", "regStart", "frozenWeight", "yieldEpoch", "yieldToDate"]) {
      expect(body).not.toHaveProperty(gone);
    }
    assertNoLargeNumbers(body, "/players/:owner");
  });

  it("GET /players/:owner reports today's bought and granted tickets", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    // bonusEpoch/boughtEpoch both equal the current epoch (7) in the seed,
    // so both counters read live rather than reset to 0.
    expect(body.boughtToday).toBe(ALICE_BOUGHT_AMOUNT.toString());
    expect(body.buyAllowanceLeft).toBe((1_000_000n - ALICE_BOUGHT_AMOUNT).toString());
    expect(body.grantedToday).toBe(ALICE_BONUS_GRANTED.toString());
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

  it("GET /players/:owner gives zero odds to a player with no Weight in the tree", async () => {
    const { body } = await http.get(`/players/${BOB}`).expect(200);
    expect(body.weight).toBe("0");
    expect(body.odds).toBe("0.00");
    expect(body.unsettledYield).toBe("0");
  });

  // Ticket 20: a deposit made today is Principal with no Tickets until the
  // next epoch, and the read folds it the way `touch` does, row untouched.
  it("GET /players/:owner shows a pending deposit as pending Tickets, then folds it from the next epoch", async () => {
    const seed = (epochId: bigint, entries: bigint, pendingDepositEpoch: bigint) =>
      prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: 500_000n, entries, epochId, pendingDeposit: 500_000n, pendingDepositEpoch },
      });
    try {
      await seed(CURRENT_EPOCH, 0n, CURRENT_EPOCH);
      const today = (await http.get(`/players/${BOB}`).expect(200)).body;
      expect(today.weight).toBe("0");
      expect(today.pendingTickets).toBe("500000");
      expect(today.pendingActivatesEpoch).toBe((CURRENT_EPOCH + 1n).toString());
      expect(today.odds).toBe("0.00");

      // Deposited in epoch 6 and never touched since: Principal is the Tickets.
      await seed(CURRENT_EPOCH - 1n, 0n, CURRENT_EPOCH - 1n);
      const later = (await http.get(`/players/${BOB}`).expect(200)).body;
      expect(later.weight).toBe("500000");
      expect(later.pendingTickets).toBe("0");
      expect(later.pendingActivatesEpoch).toBeNull();
      expect(later.odds).toBe("50.00");
    } finally {
      await prisma.player.update({
        where: activePlayer(BOB),
        data: { principal: 0n, entries: 0n, epochId: CURRENT_EPOCH, pendingDeposit: 0n, pendingDepositEpoch: 0n },
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
    expect(body[2].isHouse).toBe(true);
    assertNoLargeNumbers(body, "/leaderboard");
  });

  it("GET /feed keeps user-facing events only, newest first", async () => {
    const { body } = await http.get("/feed").expect(200);
    expect(body.map((event: { name: string }) => event.name)).toEqual([
      // Ticket 14: a void refund and a processed withdrawal are history too.
      "PositionSettled",
      "Withdrawn",
      "PositionSettled",
      "JackpotPaid",
      "PositionSettled",
      "Deposited",
    ]);
    expect(body[0].data).toMatchObject({ refund: "250", reward: "0" });
    expect(body[1].data).toMatchObject({ amount: "400000", principal: "1000000" });
    // The zero-reward PositionSettled and the operator-only RoundOpened are gone.
    expect(body.every((event: { slot: string }) => event.slot !== "11")).toBe(true);
    expect(body.every((event: { slot: string }) => event.slot !== "13")).toBe(true);
    assertNoLargeNumbers(body, "/feed");
  });

  it("GET /feed?owner filters to that wallet, keeping a JackpotPaid row by its winner field", async () => {
    // Alice owns every feed-eligible row here, including the JackpotPaid one
    // by its `winner` field: drop that disjunct and this list loses a row.
    const alice = await http.get(`/feed?owner=${ALICE}`).expect(200);
    expect(alice.body.map((event: { name: string }) => event.name)).toEqual([
      "PositionSettled",
      "Withdrawn",
      "PositionSettled",
      "JackpotPaid",
      "PositionSettled",
      "Deposited",
    ]);
    assertNoLargeNumbers(alice.body, "/feed?owner=alice");

    // Bob's only owned row (slot 11) is a zero-reward PositionSettled, which
    // the reward filter already drops, and he is nobody's JackpotPaid winner.
    const bob = await http.get(`/feed?owner=${BOB}`).expect(200);
    expect(bob.body).toEqual([]);
  });

  it("GET /positions/counts counts from the PositionBought event log, including rounds Position has already dropped", async () => {
    // Runs after the /feed tests above on purpose: PositionBought is a
    // FEED_NAMES event, so seeding it earlier would perturb their exact
    // match on the shared Event table.
    //
    // Carl has no Position row at all (his round settled and the indexer
    // deleted it, same as any settled position), yet his PositionBought
    // event is still in the log. That is the whole point of reading Event
    // instead of Position: this case reads 0 against the old
    // Position.groupBy implementation and must not here.
    const CARL = Keypair.generate().publicKey.toBase58();
    await prisma.event.createMany({
      data: [
        {
          slot: 20n,
          signature: "sig20",
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "PositionBought",
          data: { roundId: "99", owner: ALICE, tiles: "1", stakePerTile: "100", total: "100" },
          blockTime: NOW - 20n,
        },
        {
          slot: 21n,
          signature: "sig21",
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "PositionBought",
          data: { roundId: "100", owner: ALICE, tiles: "1", stakePerTile: "100", total: "100" },
          blockTime: NOW - 10n,
        },
        {
          slot: 22n,
          signature: "sig22",
          index: 0,
          poolAddress: POOL_ADDRESS,
          name: "PositionBought",
          data: { roundId: "99", owner: CARL, tiles: "1", stakePerTile: "50", total: "50" },
          blockTime: NOW - 5n,
        },
      ],
    });

    const { body } = await http
      .get(`/positions/counts?owners=${ALICE},${BOB},${CARL}`)
      .expect(200);
    expect(body).toEqual({ counts: { [ALICE]: 2, [BOB]: 0, [CARL]: 1 } });
    assertNoLargeNumbers(body, "/positions/counts");
  });

  it("GET /status reports the operator, the cursor age and rpc health", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.operator).toMatchObject({ lastAction: "settle_round" });
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

  it("GET /status reports the bonus grants", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.bonusGrantedToday).toBe(POOL_BONUS_GRANTED.toString());
    expect(body.bonusCap).toBe(
      poolBonusCap(BigInt(HUGE_U64), POOL_BONUS_CAP_BPS).toString(),
    );
    assertNoLargeNumbers(body, "/status (bonus)");
  });

  // Ticket 14: the live-yield half of /status.
  describe("GET /status live yield", () => {
    it("reports the solvency margin, free idle against the band, the reserve and the tree", async () => {
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
      // Three leaves out of the 187,244 a tree holds.
      expect(body.treeNodeCount).toBe("3");
      expect(body.treeCapacity).toBe(187_244);
      expect(body.treeUsedBps).toBe(0);
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
    it("GET /epochs and /rounds return only the Active pool's rows", async () => {
      const epochs = await http.get("/epochs").expect(200);
      expect(epochs.body.map((epoch: { id: string }) => epoch.id)).toEqual(["7", "6"]);
      const rounds = await http.get("/rounds").expect(200);
      expect(rounds.body.map((round: { id: string }) => round.id)).toEqual(["100", "99"]);
      const round = await http.get("/rounds/100").expect(200);
      expect(round.body.pot).toBe("5000");
      await http.get("/rounds/101").expect(404);
    });

    it("GET /players/:owner reads the Active pool's Player only", async () => {
      const alice = await http.get(`/players/${ALICE}`).expect(200);
      expect(alice.body.principal).toBe("1000000");
      await http.get(`/players/${CAROL}`).expect(404);
    });

    it("GET /state reads the Active pool's Pool, Epoch, Round and Player", async () => {
      const { body } = await http.get(`/state?owner=${CAROL}`).expect(200);
      expect(body.pool.address).toBe(POOL_ADDRESS);
      expect(body.currentEpoch.id).toBe("7");
      expect(body.openRound.id).toBe("100");
      expect(body.player).toBeNull();
    });

    it("GET /status reports the Active pool's operator and cursor", async () => {
      const { body } = await http.get("/status").expect(200);
      expect(body.operator.lastAction).toBe("settle_round");
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

    it("is 503 with ROUND_VOIDED_RECENTLY and EPOCH_ROLLED_OVER_RECENTLY, from Event rows in the last hour", async () => {
      await prisma.operatorState.update({
        where: { poolAddress: POOL_ADDRESS },
        data: { withdrawShortfall: 0n },
      });
      await prisma.event.createMany({
        data: [
          {
            slot: 900n,
            signature: "sigAlertsVoided",
            index: 0,
            poolAddress: POOL_ADDRESS,
            name: "RoundVoided",
            data: { roundId: "101" },
            blockTime: NOW - 60n,
          },
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
          { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
          { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
        ]);
      } finally {
        await prisma.event.deleteMany({
          where: { signature: { in: ["sigAlertsVoided", "sigAlertsRolledOver"] } },
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

      it("fires WEIGHT_TREE_NEARLY_FULL over 90% of the tree's capacity", async () => {
        await quiet();
        await prisma.weightTreeState.update({
          where: { poolAddress: POOL_ADDRESS },
          data: { nodeCount: 168_600n },
        });
        try {
          const { body } = await http.get("/alerts").expect(503);
          expect(body.alerts.map((alert: { code: string }) => alert.code)).toEqual([
            "WEIGHT_TREE_NEARLY_FULL",
          ]);
        } finally {
          await prisma.weightTreeState.update({
            where: { poolAddress: POOL_ADDRESS },
            data: { nodeCount: 3n },
          });
          await restore({});
        }
      });
    });
  });

  describe("GET /state", () => {
    it("returns the pool, current epoch, open round, status and chain time for a given owner", async () => {
      const { body } = await http.get(`/state?owner=${ALICE}`).expect(200);
      expect(body.pool).toMatchObject({ address: POOL_ADDRESS, currentEpochId: "7" });
      // The browser needs both and no longer reads the Pool account itself.
      expect(body.pool.closeBuffer).toBe(POOL_CLOSE_BUFFER.toString());
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
      expect(body.openRound).toEqual({
        id: "100",
        epochId: "7",
        startsAt: String(CURRENT_START),
        endsAt: String(CURRENT_START + 60n),
        status: 0,
        pot: "5000",
        houseCut: "0",
      });
      expect(body.player).toMatchObject({
        owner: ALICE,
        odds: "100.00",
        weight: ALICE_WEIGHT.toString(),
      });
      // round: the open Round's full state, no `round=` needed — it falls
      // back to `openRound`'s id.
      expect(body.round).toMatchObject({ id: "100", status: 0, winningTile: null });
      // position: Alice's Position in that same Round, found the same way.
      expect(body.position).toEqual({ tiles: "7", stakePerTile: "1000000" });
      expect(body.status.operator).toMatchObject({ lastAction: "settle_round" });
      expect(body.status.cursor.lastSlot).toBe("15");
      expect(BigInt(body.chainTime)).toBeGreaterThanOrEqual(CHAIN_NOW);
      // Ticket 08: the cached estimate over the pool's hot writable accounts.
      expect(body.priorityFeeMicroLamports).toBe(FAKE_PRIORITY_FEE);
      assertNoLargeNumbers(body, "/state?owner");
    });

    it("omits the Player with no owner given, so a disconnected visitor gets a complete page", async () => {
      const { body } = await http.get("/state").expect(200);
      expect(body.player).toBeNull();
      expect(body.pool).toBeDefined();
      expect(body.currentEpoch).toBeDefined();
      expect(body.openRound).toBeDefined();
      expect(body.status).toBeDefined();
      // No owner: still resolves the open Round as `round`, but no Position.
      expect(body.round).toMatchObject({ id: "100" });
      expect(body.position).toBeNull();
      assertNoLargeNumbers(body, "/state");
    });

    it("keeps returning a settled Round's full state — winning tile and tile totals included — once it is no longer the open Round", async () => {
      // Round 99 settled before this session ever polled: `openRound` never
      // shows it, but naming it with `round=` still returns everything the
      // reveal needs, and Bob's Position in it follows the same param.
      const { body } = await http.get(`/state?owner=${BOB}&round=99`).expect(200);
      expect(body.openRound).toMatchObject({ id: "100" });
      expect(body.round).toMatchObject({
        id: "99",
        epochId: "7",
        status: 2,
        winningTile: 17,
        pot: "4000",
        houseCut: "240",
      });
      expect(body.position).toEqual({ tiles: "3", stakePerTile: "500000" });
      assertNoLargeNumbers(body, "/state?round=99");
    });

    it("returns a null round and Position for a round id nothing was seeded under", async () => {
      const { body } = await http.get(`/state?owner=${ALICE}&round=404`).expect(200);
      expect(body.round).toBeNull();
      expect(body.position).toBeNull();
    });

    it("rejects a malformed round id", async () => {
      await http.get("/state?round=not-a-number").expect(400);
    });

    it("returns a null Player, not a 404, for a wallet with no Player account yet", async () => {
      const stranger = Keypair.generate().publicKey.toBase58();
      const { body } = await http.get(`/state?owner=${stranger}`).expect(200);
      expect(body.player).toBeNull();
    });

    it("returns a null open Round once the epoch has none open", async () => {
      await prisma.round.update({ where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: 100n } }, data: { status: 2 } });
      try {
        const { body } = await http.get("/state").expect(200);
        expect(body.openRound).toBeNull();
      } finally {
        await prisma.round.update({ where: { poolAddress_id: { poolAddress: POOL_ADDRESS, id: 100n } }, data: { status: 0 } });
      }
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

    it("collapses a concurrent burst of Weight tree reads to one call, then reads again after the window", async () => {
      vi.setSystemTime(Date.now() + TREE_TTL_MS + 1);
      const before = treeReads;

      const burst = await Promise.all([
        http.get(`/players/${ALICE}`),
        http.get("/leaderboard"),
        http.get(`/players/${ALICE}`),
      ]);
      burst.forEach((response) => expect(response.status).toBe(200));
      expect(treeReads).toBe(before + 1);

      vi.setSystemTime(Date.now() + TREE_TTL_MS + 1);
      await http.get(`/players/${ALICE}`).expect(200);
      expect(treeReads).toBe(before + 2);
    });

    it("reports odds as unknown when the tree cannot be read, without caching that", async () => {
      vi.setSystemTime(Date.now() + TREE_TTL_MS + 1);
      const before = treeReads;
      failNextTreeRead = true;

      const failed = await http.get(`/players/${ALICE}`).expect(200);
      // Her Tickets come from her row and stay. The odds need the root, and
      // null is not "0": a failed read is not evidence the draw is empty.
      expect(failed.body.weight).toBe(ALICE_WEIGHT.toString());
      expect(failed.body.odds).toBeNull();
      // Principal and the settle figures come from Postgres and stay.
      expect(failed.body.principal).toBe("1000000");
      expect(treeReads).toBe(before + 1);

      // Still inside the window the failed read opened: the slot was cleared,
      // so this retries the chain.
      const recovered = await http.get(`/players/${ALICE}`).expect(200);
      expect(recovered.body.odds).toBe("100.00");
      expect(treeReads).toBe(before + 2);
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
    roundSeconds: 60n,
    closeBuffer: POOL_CLOSE_BUFFER,
    minDeposit: POOL_MIN_DEPOSIT,
    houseCutBps: 600,
    paused: false,
    currentEpochId: CURRENT_EPOCH,
    currentEpochEndsAt: CURRENT_START + EPOCH_LENGTH,
    previousEpochEndsAt: CURRENT_START,
    totalPrincipal: BigInt(HUGE_U64),
    baseRateBps: POOL_BASE_RATE_BPS,
    ticketsPerUsdc: POOL_TICKETS_PER_USDC,
    bonusCapBps: POOL_BONUS_CAP_BPS,
    bonusEpoch: CURRENT_EPOCH,
    bonusGranted: POOL_BONUS_GRANTED,
    version: 1,
    shutdown: false,
    // Ticket 14: the venue, the index and the band.
    ...LIVE_POOL_DEFAULTS,
    weightTree: WEIGHT_TREE.toBase58(),
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

  await prisma.round.createMany({
    data: [
      {
        poolAddress: POOL_ADDRESS,
        id: 99n,
        epochId: CURRENT_EPOCH,
        startsAt: CURRENT_START - 60n,
        endsAt: CURRENT_START,
        status: 2, // Settled
        pot: 4_000n,
        houseCut: 240n,
        winningTile: 17,
        tileTotals: { "17": "4000" },
      },
      {
        poolAddress: POOL_ADDRESS,
        id: 100n,
        epochId: CURRENT_EPOCH,
        startsAt: CURRENT_START,
        endsAt: CURRENT_START + 60n,
        status: 0, // Open
        pot: 5_000n,
        houseCut: 0n,
        winningTile: null,
        tileTotals: {},
      },
    ],
  });

  await prisma.player.createMany({
    data: [
      {
        ...emptyPlayer(ALICE),
        principal: 1_000_000n,
        entries: 1_000_000n,
        yieldIndex: ALICE_YIELD_INDEX.toString(),
        leafIndex: 1,
        boughtEpoch: CURRENT_EPOCH,
        boughtAmount: ALICE_BOUGHT_AMOUNT,
        bonusEpoch: CURRENT_EPOCH,
        bonusGranted: ALICE_BONUS_GRANTED,
      },
      // Withdrew everything, so no entries and no weight this epoch.
      { ...emptyPlayer(BOB), leafIndex: 2, yieldIndex: POOL_YIELD_INDEX.toString() },
      { ...emptyPlayer(HOUSE), isHouse: true, leafIndex: 3 },
    ],
  });

  await prisma.position.createMany({
    data: [
      // Alice's Position in the open round (100): the default case, no
      // `round` query param needed to find it.
      {
        address: Keypair.generate().publicKey.toBase58(),
        poolAddress: POOL_ADDRESS,
        owner: ALICE,
        roundId: 100n,
        tiles: 7n,
        stakePerTile: 1_000_000n,
      },
      // Bob's Position in round 99, already Settled: only reachable by
      // naming it explicitly with `round=99`, since it is not `openRound`.
      {
        address: Keypair.generate().publicKey.toBase58(),
        poolAddress: POOL_ADDRESS,
        owner: BOB,
        roundId: 99n,
        tiles: 3n,
        stakePerTile: 500_000n,
      },
    ],
  });

  await prisma.event.createMany({
    data: [
      { slot: 10n, signature: "sig10", index: 0, name: "Deposited", data: { owner: ALICE, amount: "1000000" }, blockTime: NOW - 300n },
      { slot: 11n, signature: "sig11", index: 0, name: "PositionSettled", data: { owner: BOB, reward: "0" }, blockTime: NOW - 250n },
      { slot: 12n, signature: "sig12", index: 0, name: "PositionSettled", data: { owner: ALICE, reward: "500" }, blockTime: NOW - 200n },
      { slot: 13n, signature: "sig13", index: 0, name: "RoundOpened", data: { roundId: "100" }, blockTime: NOW - 150n },
      { slot: 14n, signature: "sig14", index: 0, name: "JackpotPaid", data: { winner: ALICE, amount: "12000000", isHouse: false }, blockTime: NOW - 100n },
      // Reward stored as a JSON number rather than a string, which the feed
      // filter has to accept just the same.
      { slot: 15n, signature: "sig15", index: 0, name: "PositionSettled", data: { owner: ALICE, reward: 7 }, blockTime: NOW - 50n },
      // Ticket 14: a player's history also shows a processed withdrawal and a
      // void refund (a zero reward with a refund on PositionSettled).
      { slot: 19n, signature: "sig19", index: 0, name: "Withdrawn", data: { owner: ALICE, amount: "400000", principal: "1000000", entries: "1000000" }, blockTime: NOW - 20n },
      { slot: 19n, signature: "sig19", index: 1, name: "PositionSettled", data: { owner: ALICE, roundId: "98", reward: "0", refund: "250" }, blockTime: NOW - 20n },
    ].map((row) => ({ ...row, poolAddress: POOL_ADDRESS })),
  });

  await prisma.cursor.create({
    data: { poolAddress: POOL_ADDRESS, lastSignature: "sig15", lastSlot: 15n, updatedAt: NOW - 42n },
  });

  await prisma.operatorState.create({
    data: {
      poolAddress: POOL_ADDRESS,
      lastTickAt: NOW - 2n,
      lastAction: "settle_round",
      lastError: null,
      withdrawShortfall: 250_000n,
    },
  });

  // Ticket 14: the index history behind the trailing rates (5% over the 7
  // days to LAST_SYNC, 1% over the last 24 hours), the Weight tree's header
  // and root, and the reserve and tree addresses the Pool row pins.
  await prisma.yieldIndexPoint.createMany({
    data: [
      { at: LAST_SYNC - 7n * EPOCH_LENGTH, yieldIndex: E18.toString() },
      { at: LAST_SYNC - EPOCH_LENGTH, yieldIndex: ((E18 * 104n) / 100n).toString() },
    ].map((row) => ({ ...row, poolAddress: POOL_ADDRESS })),
  });
  await prisma.weightTreeState.create({
    data: {
      poolAddress: POOL_ADDRESS,
      nodeCount: 3n,
      epochId: CURRENT_EPOCH,
      rootWeight: ALICE_WEIGHT.toString(),
    },
  });
}

/**
 * A retired pool's rows, left behind by a Pool cutover (ADR 0016). Each one
 * collides with an Active-pool key (epoch 7, round 100, Alice's Player and
 * Position) or sorts ahead of the Active pool's rows (epoch 9, open round
 * 101, event slots 30+), so a route that forgot its `poolAddress` filter
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
  await prisma.round.createMany({
    data: [
      {
        poolAddress: RETIRED_POOL_ADDRESS,
        id: 100n,
        epochId: CURRENT_EPOCH,
        startsAt: 0n,
        endsAt: 1n,
        status: 2,
        pot: 1n,
        houseCut: 0n,
        winningTile: 3,
        tileTotals: { "3": "1" },
      },
      {
        poolAddress: RETIRED_POOL_ADDRESS,
        id: 101n,
        epochId: retiredEpoch,
        startsAt: 0n,
        endsAt: 1n,
        status: 0, // Open, and newer than the Active pool's open round
        pot: 1n,
        houseCut: 0n,
        winningTile: null,
        tileTotals: {},
      },
    ],
  });
  await prisma.player.createMany({
    data: [
      { ...emptyPlayer(ALICE, RETIRED_POOL_ADDRESS), principal: 777n },
      // Holds entries, so an unscoped scan would hand her a share of the odds.
      { ...emptyPlayer(CAROL, RETIRED_POOL_ADDRESS), principal: 5n, entries: 5n },
    ],
  });
  await prisma.position.create({
    data: {
      address: Keypair.generate().publicKey.toBase58(),
      poolAddress: RETIRED_POOL_ADDRESS,
      owner: ALICE,
      roundId: 100n,
      tiles: 99n,
      stakePerTile: 1n,
    },
  });
  await prisma.event.createMany({
    data: [
      { slot: 30n, signature: "retired30", index: 0, name: "Deposited", data: { owner: ALICE, amount: "777" }, blockTime: NOW - 20n },
      { slot: 31n, signature: "retired31", index: 0, name: "Withdrawn", data: { owner: ALICE, amount: "1", principal: "1", entries: "1" }, blockTime: NOW - 15n },
      { slot: 32n, signature: "retired32", index: 0, name: "PositionBought", data: { roundId: "555", owner: ALICE, tiles: "1", stakePerTile: "1", total: "1" }, blockTime: NOW - 10n },
      { slot: 33n, signature: "retired33", index: 0, name: "RoundVoided", data: { roundId: "101" }, blockTime: NOW - 5n },
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
