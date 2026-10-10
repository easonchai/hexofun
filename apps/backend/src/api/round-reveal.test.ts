// Against a real Postgres (off-chain-tickets ticket 17): a Round from its first
// bet through reveal and settle or void, with stub relays serving recorded
// quicknet beacons. The module is compiled but never `init`ed, so the engine's
// own sweep timer does not run and every pass here is driven with a test clock.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_reveal";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { ChainClient } from "drand-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChainService } from "../chain/chain.service";
import { countLedgerMismatches } from "../ledger/ledger-store";
import { ensurePoolRow } from "../operator/pool-row.fixture";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { betMessage, type BetFields } from "./bet";
import { beaconRoundFor, beaconTime, QUICKNET, VOID_AFTER_MS } from "./drand";
import { DEFAULT_GAME_CONFIG } from "./game-config";
import { deriveTile } from "./round-settle";
import { RoundsService } from "./rounds.service";
import { SessionsService } from "./sessions.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const POOL = Keypair.generate().publicKey.toBase58();
const HOUSE = Keypair.generate().publicKey.toBase58();
const EPOCH = 3n;
const FAR_EPOCH_END = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

// Recorded from api.drand.sh on 2026-10-08, keyed by the round the clocks below ask for.
const BEACONS: Record<number, { round: number; randomness: string; signature: string }> = {
  32883574: {
    round: 32883574,
    randomness: "6495b2994b01e83d2dd91bf0161a7af462f1cb4dbd4b45d863d0eb3d33d24046",
    signature:
      "af6f10b205b36992236d019792d58af67ddf06ecc90f23c41d639afa492e90b18135c3a9333bd26782dc584a3b297223",
  },
  32883614: {
    round: 32883614,
    randomness: "a027f3dcaef1d5437e29052c6970f80f67dae86d6b173c07c3051fecf7d9410d",
    signature:
      "ab37130da7e78d14632710d22a4d0bcfd47a9a402920b65fe9c29b94b3d9ce0e0d0fe3126132fb29c399cd35dad69757",
  },
  32883654: {
    round: 32883654,
    randomness: "a70da3d15406b7edd1d45f0050bb2bb7311284e5604c917c9d2c795e51703e2c",
    signature:
      "8b52db9ebf597b5a9a61e4fc0e5aa1a52cdf445931841323240d42b8f171ca96dc349a3f4591b84033770041de7a0c2e",
  },
};

// Round 1 opens at 10:06:30 UTC and closes on the 10:08:00 mark; Rounds 2 and 3
// open just after the previous one closes and close 120 s apart.
const BASE_S = 1791453990;
const at = (seconds: number): Date => new Date((BASE_S + seconds) * 1000);
const CLOSE1 = at(90);
const SEED = Buffer.alloc(32, 7);

function signWith(keypair: Keypair, message: string): Uint8Array {
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), key));
}

interface Player {
  wallet: string;
  sessionKey: Keypair;
}

/** A relay serving `answer(round)`; a throw is a relay that does not answer. */
function relay(name: string, answer: (round: number) => unknown, calls: number[] = []): ChainClient {
  const chain = { baseUrl: name, info: async () => QUICKNET };
  return {
    options: { disableBeaconVerification: false, noCache: false },
    chain: () => chain,
    get: async (round: number) => {
      calls.push(round);
      return answer(round) as never;
    },
    latest: async () => {
      throw new Error("unused");
    },
  };
}
const goodRelay = (calls?: number[]): ChainClient =>
  relay("good", (round) => {
    const beacon = BEACONS[round];
    if (beacon === undefined) throw new Error(`relay answered 404 for round ${round}`);
    return beacon;
  }, calls);
const deadRelay = (): ChainClient =>
  relay("dead", () => {
    throw new Error("relay timed out");
  });

describe.skipIf(!DB_AVAILABLE)("reveal and settle", () => {
  let prisma: PrismaService;
  let rounds: RoundsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RoundsService,
        SessionsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ CORS_ORIGIN: "https://hexvault.xyz", CLUSTER: "devnet", PROGRAM_ID }),
        },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();
    prisma = moduleRef.get(PrismaService);
    rounds = moduleRef.get(RoundsService);
    await ensurePoolRow(prisma, POOL, 1n);
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  const wipe = async (): Promise<void> => {
    await prisma.position.deleteMany();
    await prisma.round.deleteMany();
    await prisma.ticketLedger.deleteMany();
    await prisma.ticketBalance.deleteMany();
    await prisma.session.deleteMany();
    await prisma.gameConfig.deleteMany();
    await prisma.player.deleteMany();
    await prisma.cursor.deleteMany();
  };

  beforeEach(async () => {
    await wipe();
    await prisma.pool.update({
      where: { address: POOL },
      data: { currentEpochId: EPOCH, currentEpochEndsAt: FAR_EPOCH_END, paused: false, gamePaused: false, shutdown: false },
    });
    await prisma.gameConfig.create({ data: { poolAddress: POOL, ...DEFAULT_GAME_CONFIG } });
    await prisma.player.create({
      data: {
        poolAddress: POOL,
        owner: HOUSE,
        principal: 0n,
        epochId: EPOCH,
        isHouse: true,
        pendingWithdraw: 0n,
        pendingEpoch: 0n,
        boughtEpoch: 0n,
        boughtAmount: 0n,
      },
    });
    rounds.relays = [goodRelay()];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function player(tickets: bigint): Promise<Player> {
    const wallet = Keypair.generate().publicKey.toBase58();
    const sessionKey = Keypair.generate();
    await prisma.ticketBalance.create({ data: { poolAddress: POOL, owner: wallet, tickets, epochId: EPOCH } });
    await prisma.ticketLedger.create({
      data: { poolAddress: POOL, owner: wallet, epochId: EPOCH, delta: tickets, reason: "reset", ref: "test" },
    });
    await prisma.session.create({
      data: {
        poolAddress: POOL,
        wallet,
        sessionPubkey: sessionKey.publicKey.toBase58(),
        message: "delegation",
        signature: "sig",
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { wallet, sessionKey };
  }

  /** Places `tiles` at `stake` Tickets each into Round `round` at test second `seconds`. */
  async function bet(p: Player, tiles: number[], stake: bigint, seconds: number, round = 1n, seq = 0) {
    const fields: BetFields = {
      cluster: "devnet",
      program: PROGRAM_ID,
      pool: POOL,
      round,
      session: p.sessionKey.publicKey.toBase58(),
      seq,
      tiles,
      stake,
    };
    const message = betMessage(fields);
    const result = await rounds.placeBet(message, signWith(p.sessionKey, message), at(seconds));
    expect(result.ok).toBe(true);
  }

  /** Swaps in a known seed so the winning tile is known before anyone bets. */
  async function fixSeed(roundId: bigint): Promise<void> {
    await prisma.round.update({
      where: { poolAddress_id: { poolAddress: POOL, id: roundId } },
      data: { seedSecret: SEED.toString("hex") },
    });
  }

  const tickets = async (owner: string): Promise<bigint> =>
    (await prisma.ticketBalance.findUniqueOrThrow({ where: { poolAddress_owner: { poolAddress: POOL, owner } } })).tickets;
  const roundOf = (id: bigint) => prisma.round.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: POOL, id } } });
  const rowsOf = (reason: "reward" | "refund" | "house_credit") =>
    prisma.ticketLedger.findMany({ where: { poolAddress: POOL, reason }, orderBy: { id: "asc" } });

  /** Bets for Round 1 so tile T has two winners: alice {T, T+1} at 10, bob {T} at 30, carol {T+2} at 50. */
  async function playRound1(): Promise<{ alice: Player; bob: Player; carol: Player; T: number }> {
    const T = deriveTile(SEED, Buffer.from(BEACONS[32883574]!.signature, "hex"), 1n).tile;
    const [alice, bob, carol] = [await player(1_000n), await player(1_000n), await player(1_000n)];
    await bet(alice, [T, (T + 1) % 36].sort((a, b) => a - b), 10n, 0);
    await fixSeed(1n);
    await bet(bob, [T], 30n, 5);
    await bet(carol, [(T + 2) % 36], 50n, 10);
    return { alice, bob, carol, T };
  }

  it("reveals the tile from the beacon and settles in one transaction", async () => {
    const { alice, bob, carol, T } = await playRound1();
    await rounds.closeDue(CLOSE1);
    expect((await roundOf(1n)).status).toBe("closed");
    expect(beaconRoundFor((await roundOf(1n)).closeAt)).toBe(32883574);

    await rounds.revealDue(beaconTime(32883574));

    const round = await roundOf(1n);
    expect(round).toMatchObject({
      status: "settled",
      seed: SEED.toString("hex"),
      drandRound: 32883574n,
      drandSignature: BEACONS[32883574]!.signature,
      ctr: 0,
      tile: T,
      pot: 100n,
      houseCut: 3n,
    });
    // Tile T holds 40; the losers' pot 60 less the 3 cut is shared 10:30 (14 and 42), and the rounding Ticket goes to the House.
    expect((await rowsOf("reward")).map((r) => [r.owner, r.delta, r.ref])).toEqual([
      [alice.wallet, 24n, "1"],
      [bob.wallet, 72n, "1"],
    ]);
    expect((await rowsOf("house_credit")).map((r) => [r.owner, r.delta])).toEqual([[HOUSE, 4n]]);
    expect(await tickets(alice.wallet)).toBe(1_000n - 20n + 24n);
    expect(await tickets(bob.wallet)).toBe(1_000n - 30n + 72n);
    expect(await tickets(carol.wallet)).toBe(1_000n - 50n);
    expect(await tickets(HOUSE)).toBe(4n);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("closes and reveals an empty Round with no ledger rows", async () => {
    await rounds.openDue(at(40));
    expect((await roundOf(1n)).closeAt).toEqual(CLOSE1);
    await rounds.closeDue(CLOSE1);
    await rounds.revealDue(beaconTime(32883574));

    expect(await roundOf(1n)).toMatchObject({ status: "settled", pot: 0n, houseCut: 0n });
    expect(await prisma.ticketLedger.count({ where: { poolAddress: POOL, reason: { in: ["reward", "refund", "house_credit"] } } })).toBe(0);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("is idempotent: a second pass over a settled Round books nothing", async () => {
    await playRound1();
    await rounds.closeDue(CLOSE1);
    await rounds.revealDue(beaconTime(32883574));
    const before = await prisma.ticketLedger.count();
    await rounds.revealDue(beaconTime(32883574));
    expect(await prisma.ticketLedger.count()).toBe(before);
  });

  it("forfeits the pot to the House when nobody covered the tile", async () => {
    const T = deriveTile(SEED, Buffer.from(BEACONS[32883574]!.signature, "hex"), 1n).tile;
    const alice = await player(1_000n);
    await bet(alice, [(T + 1) % 36], 10n, 0);
    await fixSeed(1n);
    await rounds.closeDue(CLOSE1);
    await rounds.revealDue(beaconTime(32883574));

    expect(await roundOf(1n)).toMatchObject({ status: "settled", tile: T, houseCut: 0n });
    expect(await rowsOf("reward")).toEqual([]);
    expect((await rowsOf("house_credit")).map((r) => r.delta)).toEqual([10n]);
    expect(await tickets(alice.wallet)).toBe(990n);
    expect(await tickets(HOUSE)).toBe(10n);
  });

  /**
   * Alice (150 Tickets, Principal 100) and bob (1,000) each stake 50 in Round 1, alice on the winning tile.
   * EpochBegan then resets both to their basis, 100 and 1,000. Alice's reset changes nothing (150 - 50 = 100)
   * and so writes no ledger row; bob's writes one. The ledger cursor moves to the new epoch.
   */
  async function stakeThenReset(): Promise<{ alice: Player; bob: Player }> {
    const T = deriveTile(SEED, Buffer.from(BEACONS[32883574]!.signature, "hex"), 1n).tile;
    const [alice, bob] = [await player(150n), await player(1_000n)];
    await bet(alice, [T], 50n, 0);
    await fixSeed(1n);
    await bet(bob, [(T + 1) % 36], 50n, 5);
    await rounds.closeDue(CLOSE1);
    await prisma.ticketLedger.create({
      data: { poolAddress: POOL, owner: bob.wallet, epochId: EPOCH + 1n, delta: 50n, reason: "reset", ref: "sig:0" },
    });
    await prisma.ticketBalance.updateMany({ where: { poolAddress: POOL }, data: { epochId: EPOCH + 1n } });
    await prisma.ticketBalance.update({
      where: { poolAddress_owner: { poolAddress: POOL, owner: bob.wallet } },
      data: { tickets: 1_000n },
    });
    await prisma.cursor.create({ data: { poolAddress: POOL, ledgerEpochId: EPOCH + 1n } });
    return { alice, bob };
  }

  it("books only the share for a winner whose stake an EpochBegan reset returned, even with no reset row", async () => {
    const { alice } = await stakeThenReset();

    await rounds.revealDue(beaconTime(32883574));

    // Pot 100, cut 3, so alice's 50 on the winning tile earns 47 and no stake comes back on top.
    expect((await rowsOf("reward")).map((r) => [r.owner, r.delta, r.epochId])).toEqual([[alice.wallet, 47n, EPOCH + 1n]]);
    expect(await tickets(alice.wallet)).toBe(147n);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("refunds nothing for a Round voided after the reset returned every stake", async () => {
    const { alice, bob } = await stakeThenReset();
    rounds.relays = [deadRelay()];

    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + VOID_AFTER_MS));

    expect((await roundOf(1n)).status).toBe("voided");
    expect(await rowsOf("refund")).toEqual([]);
    expect(await tickets(alice.wallet)).toBe(100n);
    expect(await tickets(bob.wallet)).toBe(1_000n);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("voids a Round whose beacon never comes after the wait and refunds every stake", async () => {
    const { alice, bob, carol } = await playRound1();
    await rounds.closeDue(CLOSE1);
    rounds.relays = [deadRelay()];
    const emitted = beaconTime(32883574).getTime();

    await rounds.revealDue(new Date(emitted + VOID_AFTER_MS - 1_000));
    expect((await roundOf(1n)).status).toBe("closed");
    expect(await rowsOf("refund")).toEqual([]);

    await rounds.revealDue(new Date(emitted + VOID_AFTER_MS));
    expect(await roundOf(1n)).toMatchObject({ status: "voided", tile: null, seed: null, houseCut: null });
    expect((await rowsOf("refund")).map((r) => [r.owner, r.delta])).toEqual([
      [alice.wallet, 20n],
      [bob.wallet, 30n],
      [carol.wallet, 50n],
    ]);
    expect(await rowsOf("house_credit")).toEqual([]);
    expect([await tickets(alice.wallet), await tickets(bob.wallet), await tickets(carol.wallet)]).toEqual([1_000n, 1_000n, 1_000n]);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  const forged = {
    ...BEACONS[32883574]!,
    signature: BEACONS[32883614]!.signature,
    randomness: BEACONS[32883614]!.randomness,
  };

  it("refuses a bad signature and settles from the next relay", async () => {
    await playRound1();
    await rounds.closeDue(CLOSE1);
    const calls: number[] = [];
    rounds.relays = [relay("forger", () => forged), goodRelay(calls)];
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + 1_000));
    expect(calls).toEqual([32883574]);
    expect(await roundOf(1n)).toMatchObject({ status: "settled", drandSignature: BEACONS[32883574]!.signature });
  });

  it("leaves the Round closed for the next pass when every relay's signature is bad", async () => {
    await playRound1();
    await rounds.closeDue(CLOSE1);
    rounds.relays = [relay("forger", () => forged), relay("forger2", () => forged)];
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + 1_000));
    expect((await roundOf(1n)).status).toBe("closed");
    expect(await rowsOf("reward")).toEqual([]);

    rounds.relays = [goodRelay()];
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + 2_000));
    expect((await roundOf(1n)).status).toBe("settled");
  });

  it("does nothing before the beacon is emitted", async () => {
    await playRound1();
    await rounds.closeDue(CLOSE1);
    const calls: number[] = [];
    rounds.relays = [goodRelay(calls)];
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() - 1));
    expect(calls).toEqual([]);
    expect((await roundOf(1n)).status).toBe("closed");
  });

  it("reveals three closed Rounds in id order", async () => {
    const alice = await player(1_000n);
    await bet(alice, [1, 2], 10n, 0, 1n, 0);
    await bet(alice, [3], 10n, 91, 2n, 1);
    await bet(alice, [4], 10n, 211, 3n, 2);
    await rounds.closeDue(at(331));
    expect((await prisma.round.findMany({ orderBy: { id: "asc" } })).map((r) => [r.id, r.status])).toEqual([
      [1n, "closed"],
      [2n, "closed"],
      [3n, "closed"],
    ]);

    const calls: number[] = [];
    rounds.relays = [goodRelay(calls)];
    await rounds.revealDue(beaconTime(32883654));

    expect(calls).toEqual([32883574, 32883614, 32883654]);
    const all = await prisma.round.findMany({ orderBy: { id: "asc" } });
    expect(all.map((r) => [r.id, r.status, r.drandRound])).toEqual([
      [1n, "settled", 32883574n],
      [2n, "settled", 32883614n],
      [3n, "settled", 32883654n],
    ]);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("skips a Round that cannot settle, settles the ones after it, and retries it once repaired (audit-2026-10-09 08)", async () => {
    const alice = await player(1_000n);
    await bet(alice, [1, 2], 10n, 0, 1n, 0);
    await bet(alice, [3], 10n, 91, 2n, 1);
    await rounds.closeDue(at(331));
    // Round 1's pot no longer matches its Positions (20).
    await prisma.round.update({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } }, data: { pot: 999n } });
    const calls: number[] = [];
    rounds.relays = [goodRelay(calls)];
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await rounds.revealDue(beaconTime(32883614));
    expect((await prisma.round.findMany({ orderBy: { id: "asc" } })).map((r) => [r.id, r.status])).toEqual([
      [1n, "closed"],
      [2n, "settled"],
    ]);
    expect(rounds.settleFailed()).toEqual([1n]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Round 1 failed to settle"));

    // Every later sweep fails the same way and logs it once.
    await rounds.revealDue(beaconTime(32883614));
    expect(error).toHaveBeenCalledTimes(1);

    await prisma.round.update({ where: { poolAddress_id: { poolAddress: POOL, id: 1n } }, data: { pot: 20n } });
    await rounds.revealDue(beaconTime(32883614));
    expect((await roundOf(1n)).status).toBe("settled");
    expect(rounds.settleFailed()).toEqual([]);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);
  });

  it("settles an earlier Round whose beacon is out and leaves a later one waiting", async () => {
    const alice = await player(1_000n);
    await bet(alice, [1], 10n, 0, 1n, 0);
    await bet(alice, [3], 10n, 91, 2n, 1);
    await rounds.closeDue(at(331));
    await rounds.revealDue(new Date(beaconTime(32883574).getTime() + 1_000));
    expect((await prisma.round.findMany({ orderBy: { id: "asc" } })).map((r) => [r.id, r.status])).toEqual([
      [1n, "settled"],
      [2n, "closed"],
    ]);
  });
});
