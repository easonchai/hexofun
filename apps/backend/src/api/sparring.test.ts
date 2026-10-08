// Against a real Postgres (off-chain-tickets ticket 20): the Sparring player
// delegating to a session key and betting through RoundsService, with the clock
// passed in so the 24 hour renewal can be stepped through.
const TEST_DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_sparring";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChainService } from "../chain/chain.service";
import { countLedgerMismatches } from "../ledger/ledger-store";
import { ensurePoolRow } from "../operator/pool-row.fixture";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { betMessage } from "./bet";
import { DEFAULT_GAME_CONFIG } from "./game-config";
import { RoundsService } from "./rounds.service";
import { RENEW_BEFORE_SECONDS, SparringService, STAKE_PER_TILE } from "./sparring.service";
import { SessionsService } from "./sessions.service";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
const POOL = Keypair.generate().publicKey.toBase58();
const EPOCH = 3n;
const NOON = new Date("2026-10-08T12:00:00.000Z");
const at = (seconds: number): Date => new Date(NOON.getTime() + seconds * 1000);
const FAR_EPOCH_END = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

const sparringWallet = Keypair.generate();
const sparringWalletKey = sparringWallet.publicKey.toBase58();

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

describe.skipIf(!DB_AVAILABLE)("sparring player on session keys", () => {
  let prisma: PrismaService;
  let rounds: RoundsService;
  let sessions: SessionsService;
  let chain: { poolAddress: () => PublicKey };

  const config = (enabled: boolean) =>
    new ConfigService({
      CORS_ORIGIN: "https://hexvault.xyz",
      CLUSTER: "devnet",
      PROGRAM_ID,
      SPARRING_ENABLED: enabled,
      SPARRING_KEYPAIR: bs58.encode(sparringWallet.secretKey),
    });
  const sparring = (enabled = true) =>
    new SparringService(prisma, sessions, rounds, chain as ChainService, config(enabled) as never);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        RoundsService,
        SessionsService,
        { provide: ConfigService, useValue: config(true) },
        { provide: ChainService, useValue: { poolAddress: () => new PublicKey(POOL) } },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();
    prisma = moduleRef.get(PrismaService);
    rounds = moduleRef.get(RoundsService);
    sessions = moduleRef.get(SessionsService);
    chain = moduleRef.get(ChainService);
    await ensurePoolRow(prisma, POOL, 1n);
  });

  const wipe = async (): Promise<void> => {
    await prisma.position.deleteMany();
    await prisma.round.deleteMany();
    await prisma.ticketLedger.deleteMany();
    await prisma.ticketBalance.deleteMany();
    await prisma.session.deleteMany();
    await prisma.sessionNonce.deleteMany();
    await prisma.gameConfig.deleteMany();
  };

  afterAll(async () => {
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    await prisma.pool.update({
      where: { address: POOL },
      data: { currentEpochId: EPOCH, currentEpochEndsAt: FAR_EPOCH_END, paused: false, gamePaused: false, shutdown: false },
    });
    await prisma.gameConfig.create({ data: { poolAddress: POOL, ...DEFAULT_GAME_CONFIG } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fund(owner: string, tickets: bigint): Promise<void> {
    await prisma.ticketBalance.create({ data: { poolAddress: POOL, owner, tickets, epochId: EPOCH } });
    await prisma.ticketLedger.create({
      data: { poolAddress: POOL, owner, epochId: EPOCH, delta: tickets, reason: "reset", ref: "test" },
    });
  }

  /** A human opens the next Round with a one-tile bet; Round `id` is open until `closeAt`. */
  async function openRoundByHuman(id: bigint, now: Date): Promise<void> {
    const wallet = Keypair.generate().publicKey.toBase58();
    const key = Keypair.generate();
    await fund(wallet, 100n);
    await prisma.session.create({
      data: {
        poolAddress: POOL,
        wallet,
        sessionPubkey: key.publicKey.toBase58(),
        message: "delegation",
        signature: "sig",
        issuedAt: new Date(now.getTime() - 60_000),
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
    });
    const message = betMessage({
      cluster: "devnet",
      program: PROGRAM_ID,
      pool: POOL,
      round: id,
      session: key.publicKey.toBase58(),
      seq: 0,
      tiles: [0],
      stake: 1n,
    });
    expect(await rounds.placeBet(message, signWith(key, message), now)).toMatchObject({ ok: true, opened: true });
  }

  const sparringPositions = (): Promise<number> =>
    prisma.position.count({ where: { poolAddress: POOL, owner: sparringWalletKey } });

  it("bets all 36 tiles at one Ticket in a Round another wallet opened, once", async () => {
    await fund(sparringWalletKey, 100n * STAKE_PER_TILE);
    const service = sparring();
    await openRoundByHuman(1n, at(10));
    const placeBet = vi.spyOn(rounds, "placeBet");

    await service.tick(at(11));
    await service.tick(at(12));

    expect(placeBet).toHaveBeenCalledTimes(1);
    const position = await prisma.position.findFirstOrThrow({ where: { owner: sparringWalletKey } });
    expect(position).toMatchObject({ roundId: 1n, tiles: (1n << 36n) - 1n, stakePerTile: STAKE_PER_TILE, seq: 0 });
    const balance = await prisma.ticketBalance.findUniqueOrThrow({
      where: { poolAddress_owner: { poolAddress: POOL, owner: sparringWalletKey } },
    });
    expect(balance.tickets).toBe(64n * STAKE_PER_TILE);
    expect(await countLedgerMismatches(prisma, POOL)).toBe(0);

    const session = await prisma.session.findUniqueOrThrow({ where: { id: position.sessionId } });
    expect(session).toMatchObject({ wallet: sparringWalletKey, nextSeq: 1 });
    expect(session.expiresAt.getTime() - session.issuedAt.getTime()).toBe(24 * 3600 * 1000);
    expect(session.sessionPubkey).not.toBe(sparringWalletKey);
  });

  it("posts nothing while no Round is open, and never opens one", async () => {
    await fund(sparringWalletKey, 100n * STAKE_PER_TILE);
    const placeBet = vi.spyOn(rounds, "placeBet");

    await sparring().tick(at(10));

    expect(placeBet).not.toHaveBeenCalled();
    expect(await prisma.round.count()).toBe(0);
    expect(await prisma.position.count()).toBe(0);
  });

  it("logs a refused bet once per Round and tries the next Round again", async () => {
    await fund(sparringWalletKey, 10n * STAKE_PER_TILE); // fewer than 36 Tickets
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const service = sparring();
    await openRoundByHuman(1n, at(10));
    const placeBet = vi.spyOn(rounds, "placeBet");

    await service.tick(at(11));
    await service.tick(at(12));
    await service.tick(at(13));

    expect(placeBet).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("InsufficientTickets"))).toHaveLength(1);
    expect(await sparringPositions()).toBe(0);

    await openRoundByHuman(2n, at(130)); // closes Round 1, which was past its closeAt
    placeBet.mockClear();
    await service.tick(at(131));
    expect(placeBet).toHaveBeenCalledTimes(1);
  });

  it("adopts nextSeq from a SeqMismatch instead of waiting for the next delegation", async () => {
    await fund(sparringWalletKey, 100n * STAKE_PER_TILE);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const service = sparring();
    await openRoundByHuman(1n, at(10));
    await service.tick(at(11));
    // A bet that committed but whose response was lost: the row is ahead of the in-memory count.
    await prisma.session.updateMany({ where: { wallet: sparringWalletKey }, data: { nextSeq: 5 } });

    await openRoundByHuman(2n, at(130));
    await service.tick(at(131)); // refused with SeqMismatch, nextSeq 5
    await openRoundByHuman(3n, at(250));
    await service.tick(at(251));

    const seqs = (await prisma.position.findMany({ where: { owner: sparringWalletKey }, orderBy: { roundId: "asc" } }))
      .map((row) => [row.roundId, row.seq]);
    expect(seqs).toEqual([[1n, 0], [3n, 5]]);
  });

  it("signs a new delegation before the 24 hours end and bets with the new key", async () => {
    await fund(sparringWalletKey, 100n * STAKE_PER_TILE);
    const service = sparring();
    await service.tick(at(0));
    const [first] = await prisma.session.findMany({ where: { wallet: sparringWalletKey } });

    await service.tick(at(24 * 3600 - RENEW_BEFORE_SECONDS - 60)); // an hour and a minute left
    expect(await prisma.session.count({ where: { wallet: sparringWalletKey } })).toBe(1);

    const renewAt = 24 * 3600 - RENEW_BEFORE_SECONDS + 60;
    await service.tick(at(renewAt));
    const rows = await prisma.session.findMany({ where: { wallet: sparringWalletKey }, orderBy: { issuedAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.sessionPubkey).not.toBe(first!.sessionPubkey);
    expect(rows[1]!.expiresAt.getTime()).toBeGreaterThan(first!.expiresAt.getTime());

    await openRoundByHuman(1n, at(renewAt + 1));
    await service.tick(at(renewAt + 2));
    const position = await prisma.position.findFirstOrThrow({ where: { owner: sparringWalletKey } });
    expect(position.sessionId).toBe(rows[1]!.id);
  });

  it("leaves no session row and no bet when SPARRING_ENABLED is off", async () => {
    await fund(sparringWalletKey, 100n * STAKE_PER_TILE);
    await openRoundByHuman(1n, at(10));
    const service = sparring(false);

    service.onModuleInit();
    await service.tick(at(11));
    service.onModuleDestroy();

    expect(await prisma.session.count({ where: { wallet: sparringWalletKey } })).toBe(0);
    expect(await prisma.sessionNonce.count()).toBe(0);
    expect(await sparringPositions()).toBe(0);
  });
});
