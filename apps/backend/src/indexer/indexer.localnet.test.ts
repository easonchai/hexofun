// The indexer against a real validator and a real Postgres, ticket 06's third
// acceptance check. Skipped unless HEXVAULT_INDEXER_LOCALNET is set, because
// it needs the program deployed:
//
//   HEXVAULT_SKIP_BUILD=1 HEXVAULT_RPC_PORT=9199 HEXVAULT_INDEXER_LOCALNET=1 \
//     sh tests/run-local.sh --root apps/backend --config vitest.config.ts \
//     src/indexer/indexer.localnet.test.ts
//
// run-local.sh ends in `pnpm exec vitest` from the repo root, so `--root`
// points vitest at this package and `--config` is then relative to it.
//
// The chain setup is spelled out here rather than imported from
// `tests/helpers/hx.ts`: that file is written for the root tsconfig and does
// not typecheck under this package's, and pulling it in would also drag
// `tests/` into `nest build`'s output.
process.env.DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_indexer";

import { BN } from "@anchor-lang/core";
import type { ConfigService } from "@nestjs/config";
import {
  createAccount,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { deployWallet } from "../chain/deploy-wallet.fixture";
import { programDataAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { IndexerService } from "./indexer.service";

// Pinned at pool creation and forwarded to ORAO. The `test-vrf` build never
// reads it, so any pubkey would do on localnet; this is the real devnet one so
// the setup matches what the operator will send.
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

const DEPOSIT = 5_000_000n;

/**
 * `Program<Idl>` types every instruction as possibly undefined, because which
 * ones exist is only known once the IDL is read. These are the shapes the
 * builder actually has.
 */
interface MethodBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): MethodBuilder;
  signers(signers: Keypair[]): MethodBuilder;
  preInstructions(instructions: TransactionInstruction[]): MethodBuilder;
  rpc(): Promise<string>;
}
type Instruction =
  | "createPool"
  | "testVenueInit"
  | "setFeaturePause"
  | "beginEpoch"
  | "deposit";
type Methods = { [K in Instruction]: (...args: unknown[]) => MethodBuilder };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` holds, or fails saying what it was still waiting for. */
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(100);
  }
}

describe.skipIf(process.env.HEXVAULT_INDEXER_LOCALNET !== "1")("indexer on localnet", () => {
  let connection: Connection;
  let chain: ChainService;
  let methods: Methods;
  let prisma: PrismaService;
  let indexer: IndexerService;

  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  const poolId = BigInt(Date.now());

  let startedAt = 0;

  async function airdrop(to: PublicKey, sol: number): Promise<void> {
    const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, "confirmed");
  }

  beforeAll(async () => {
    const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
    if (!rpcUrl) throw new Error("ANCHOR_PROVIDER_URL is unset; run this through tests/run-local.sh");
    connection = new Connection(rpcUrl, "confirmed");

    const env: Partial<HexVaultEnv> = {
      OPERATOR_KEYPAIR: bs58.encode(authority.secretKey),
      POOL_ID: poolId.toString(),
      // run-local.sh points `loadIdl()` (via HEXVAULT_IDL_PATH) at the
      // freshly built target/idl/hex_vault.json, so this is the id it just
      // deployed, not whatever the committed src/idl/ snapshot carries.
      PROGRAM_ID: loadIdl().address,
      RPC_URL: rpcUrl,
    };
    // SAFETY: ChainService reads only those four keys through `get`.
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    chain = new ChainService(connection, config);
    // SAFETY: see MethodBuilder. A name the IDL does not have is undefined
    // here and throws on the call, it never sends a wrong instruction.
    methods = chain.program.methods as unknown as Methods;

    await airdrop(authority.publicKey, 20);
    await airdrop(depositor.publicKey, 5);

    const mint = await createMint(connection, authority, authority.publicKey, null, 6);
    // Two plain accounts with their own keypairs: treasury and buyback_reserve
    // share (mint, owner), so both cannot be the ATA.
    const treasury = await createAccount(
      connection,
      authority,
      mint,
      authority.publicKey,
      Keypair.generate(),
    );
    const buybackReserve = await createAccount(
      connection,
      authority,
      mint,
      authority.publicKey,
      Keypair.generate(),
    );

    const pool = chain.poolAddress();
    // `test-venue` pins this program as klend, the pool as the market and
    // two PDAs of its own as the reserve and the position's token account.
    const venue = {
      klendProgram: chain.programId,
      klendMarket: pool,
      klendReserve: PublicKey.findProgramAddressSync(
        [Buffer.from("test-venue-reserve"), pool.toBuffer()],
        chain.programId,
      )[0],
      klendCtoken: PublicKey.findProgramAddressSync(
        [Buffer.from("test-venue-vault"), pool.toBuffer()],
        chain.programId,
      )[0],
    };
    const deploy = deployWallet();
    await methods
      .createPool({
        poolId: new BN(poolId.toString()),
        // One key plays both roles here: it pays, cranks and administers.
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(3_600),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        vrfTimeout: new BN(5),
        minDeposit: new BN(1_000_000),
        minJackpot: new BN(1),
        // Far past this run, and under the epoch length as create_pool requires.
        payoutTimeout: new BN(3_000),
        // Base yield is off (0), same reasoning as the operator localnet
        // suite: it is not what this suite is about.
        baseRateBps: 0,
        venueKind: 1, // the stub, which is what these suites pin
      })
      .accountsPartial({
        // The deploy wallet is the upgrade authority, so it pays.
        payer: deploy.publicKey,
        programData: programDataAddress(chain.programId),
        pool,
        acceptedMint: mint,
        principalVault: chain.principalVaultAddress(),
        jackpotVault: chain.jackpotVaultAddress(),
        house: chain.playerAddress(authority.publicKey),
        treasury,
        buybackReserve,
        ...venue,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority, deploy])
      .rpc();
    await methods
      .testVenueInit()
      .accountsPartial({
        payer: authority.publicKey,
        pool,
        acceptedMint: mint,
        reserve: venue.klendReserve,
        venueVault: venue.klendCtoken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    // game-jackpot-pause ticket 02: create_pool leaves both switches on.
    for (const feature of ["jackpot"]) {
      await methods
        .setFeaturePause({ [feature]: {} }, false)
        .accountsPartial({ signer: authority.publicKey, pool })
        .rpc();
    }

    await methods
      .beginEpoch()
      .accountsPartial({
        operator: authority.publicKey,
        pool,
        currentEpoch: chain.epochAddress(0n),
        epochTwoBehind: chain.epochAddress(0n),
        newEpoch: chain.epochAddress(1n),
        // begin_epoch syncs the venue first (the stub takes no extra accounts).
        ...venue,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      depositor.publicKey,
    );
    await mintTo(connection, authority, mint, ata.address, authority, 10_000_000n);

    const depositSignature = await methods
      .deposit(new BN(DEPOSIT.toString()))
      .accountsPartial({
        owner: depositor.publicKey,
        pool,
        player: chain.playerAddress(depositor.publicKey),
        acceptedMint: mint,
        ownerToken: ata.address,
        principalVault: chain.principalVaultAddress(),
        ...venue,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    // The setup above is the history the indexer's boot backfill has to
    // replay, and `getSignaturesForAddress("finalized")` cannot list a
    // transaction that has not finalized yet. Booting before they do leaves
    // the backfill with an empty page while the live finalized subscription
    // moves the cursor to a later slot, and the next sweep then lists only
    // what came after it. A validator finalizes in about 32 slots.
    await waitFor(
      "the setup transactions to finalize",
      async () =>
        (await connection.getSignatureStatus(depositSignature)).value
          ?.confirmationStatus === "finalized",
      90_000,
    );

    prisma = new PrismaService();
    await prisma.$connect();
    await wipe(prisma);

    indexer = new IndexerService(prisma, chain);
    // The real boot path: the boot sweep, the confirmed-log sync trigger and
    // the finalized log subscription.
    indexer.onModuleInit();
    startedAt = Date.now();
  }, 180_000);

  afterAll(async () => {
    if (indexer) await indexer.onModuleDestroy();
    if (prisma) {
      await wipe(prisma);
      await prisma.$disconnect();
    }
  });

  it("mirrors the pool, the epoch and the player within 4 s", async () => {
    await waitFor(
      "the deposit and the epoch to reach Postgres",
      async () => (await prisma.player.count()) > 0 && (await prisma.epoch.count()) > 0,
      // The boot sweep runs at once; the ticket's 4 s budget covers one RPC round trip.
      4_000 - (Date.now() - startedAt),
    );
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    expect(await prisma.player.findMany({ where: { isHouse: false } })).toMatchObject([
      { owner: depositor.publicKey.toBase58(), principal: DEPOSIT, tickets: 0n },
    ]);
    expect(await prisma.epoch.findMany()).toMatchObject([{ id: 1n, status: 0 }]);
    expect(await prisma.pool.findMany()).toMatchObject([
      { poolId, totalPrincipal: DEPOSIT, currentEpochId: 1n },
    ]);
  }, 30_000);

  it("stores the finalized events and leaves a cursor behind", async () => {
    const wanted = ["Deposited", "EpochBegan"];
    await waitFor(
      `events ${wanted.join(", ")}`,
      async () => {
        const stored = new Set((await prisma.event.findMany()).map((event) => event.name));
        return wanted.every((name) => stored.has(name));
      },
      // Finalization on a test validator trails confirmation by a few slots.
      90_000,
    );

    const deposited = await prisma.event.findFirstOrThrow({ where: { name: "Deposited" } });
    expect(deposited.data).toMatchObject({
      owner: depositor.publicKey.toBase58(),
      amount: DEPOSIT.toString(),
    });

    const cursor = await prisma.cursor.findUniqueOrThrow({
      where: { poolAddress: chain.poolAddress().toBase58() },
    });
    expect(cursor.lastSignature).toBeTruthy();
    expect(cursor.lastSlot).not.toBeNull();
  }, 120_000);
});

async function wipe(prisma: PrismaService): Promise<void> {
  // Pool goes last, after every table that references it (ADR 0016).
  await prisma.$transaction([
    prisma.event.deleteMany(),
    prisma.cursor.deleteMany(),
    prisma.player.deleteMany(),
    prisma.epoch.deleteMany(),
    prisma.referralGrantShare.deleteMany(),
    prisma.referralGrant.deleteMany(),
    prisma.operatorState.deleteMany(),
    prisma.yieldIndexPoint.deleteMany(),
    prisma.pool.deleteMany(),
  ]);
}
