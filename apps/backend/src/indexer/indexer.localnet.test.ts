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
import type { HexVaultEnv } from "../config/env";
import { randomNonce, vrfSeed } from "../operator/vrf";
import { PrismaService } from "../prisma/prisma.service";
import { IndexerService } from "./indexer.service";

// Pinned at pool creation and forwarded to ORAO. The `test-vrf` build never
// reads either, so any pubkey would do on localnet; these are the real devnet
// ones so the setup matches what the operator will send.
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");
const VRF_TREASURY = new PublicKey("9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR");
const VRF_PROGRAM = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

const ROUND_SECONDS = 15;
const DEPOSIT = 5_000_000n;
const STAKE = 1_000_000n;
/** Bit 0 of the tile mask: the position covers tile 0 and nothing else. */
const TILE_ZERO = 1n;
/** `create_pool`'s Weight tree: discriminator plus the zero-copy header. */
const WEIGHT_TREE_SPACE = 8 + 48;

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
  | "deposit"
  | "grantTickets"
  | "createRound"
  | "buyPosition"
  | "requestRoundRandomness"
  | "testFulfill"
  | "settleRound"
  | "settlePosition";
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
  const weightTree = Keypair.generate();

  let round: PublicKey;
  let position: PublicKey;
  let roundEndsAt: number;
  let startedAt = 0;

  /** The validator's slot-derived clock, which lags wall time under load. */
  async function chainNow(): Promise<number> {
    const slot = await connection.getSlot("confirmed");
    const at = await connection.getBlockTime(slot);
    if (at === null) throw new Error("validator has no block time yet");
    return at;
  }

  async function waitUntil(seconds: number): Promise<void> {
    for (;;) {
      const remaining = seconds + 1 - (await chainNow());
      if (remaining <= 0) return;
      await sleep(Math.max(300, remaining * 1_000));
    }
  }

  async function airdrop(to: PublicKey, sol: number): Promise<void> {
    const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, "confirmed");
  }

  /** The `test-vrf` stand-in randomness account for a request seed. */
  function randomnessAddress(seed: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("test-vrf"), Buffer.from(seed)],
      chain.programId,
    )[0];
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
    await methods
      .createPool({
        poolId: new BN(poolId.toString()),
        // One key plays both roles here: it pays, cranks and administers.
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(3_600),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        roundSeconds: new BN(ROUND_SECONDS),
        closeBuffer: new BN(2),
        vrfTimeout: new BN(5),
        minDeposit: new BN(1_000_000),
        houseCutBps: 600,
        minJackpot: new BN(1),
        // Far past this run, and under the epoch length as create_pool requires.
        payoutTimeout: new BN(3_000),
        // Base yield and grant-tickets are off (0), same reasoning as the
        // operator localnet suite: neither is what this suite is about.
        // `ticketsPerUsdc` only has to be positive to pass `create_pool`'s
        // own validation.
        baseRateBps: 0,
        ticketsPerUsdc: 10,
        bonusCapBps: 0,
        venueKind: 1, // the stub, which is what these suites pin
      })
      .accountsPartial({
        payer: authority.publicKey,
        pool,
        acceptedMint: mint,
        principalVault: chain.principalVaultAddress(),
        jackpotVault: chain.jackpotVaultAddress(),
        house: chain.playerAddress(authority.publicKey),
        weightTree: weightTree.publicKey,
        treasury,
        buybackReserve,
        ...venue,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: weightTree.publicKey,
          space: WEIGHT_TREE_SPACE,
          lamports: await connection.getMinimumBalanceForRentExemption(WEIGHT_TREE_SPACE),
          programId: chain.programId,
        }),
      ])
      .signers([authority, weightTree])
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
    for (const feature of ["jackpot", "game"]) {
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

    await methods
      .deposit(new BN(DEPOSIT.toString()))
      .accountsPartial({
        owner: depositor.publicKey,
        pool,
        player: chain.playerAddress(depositor.publicKey),
        weightTree: weightTree.publicKey,
        acceptedMint: mint,
        ownerToken: ata.address,
        principalVault: chain.principalVaultAddress(),
        ...venue,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();
    // A deposit holds no Ticket until the next epoch (ADR 0020), so the admin
    // grants the Tickets a depositor from yesterday would hold.
    await methods
      .grantTickets(new BN(DEPOSIT.toString()))
      .accountsPartial({
        signer: authority.publicKey,
        pool,
        player: chain.playerAddress(depositor.publicKey),
        weightTree: weightTree.publicKey,
      })
      .rpc();

    const startsAt = await chainNow();
    roundEndsAt = startsAt + ROUND_SECONDS;
    round = chain.roundAddress(1n);
    position = chain.positionAddress(round, depositor.publicKey);
    await methods
      .createRound(new BN(startsAt), new BN(roundEndsAt))
      .accountsPartial({
        operator: authority.publicKey,
        pool,
        currentEpoch: chain.epochAddress(1n),
        round,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const buySignature = await methods
      .buyPosition(new BN(TILE_ZERO.toString()), new BN(STAKE.toString()))
      .accountsPartial({
        owner: depositor.publicKey,
        pool,
        player: chain.playerAddress(depositor.publicKey),
        weightTree: weightTree.publicKey,
        round,
        position,
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
        (await connection.getSignatureStatus(buySignature)).value
          ?.confirmationStatus === "finalized",
      90_000,
    );

    prisma = new PrismaService();
    await prisma.$connect();
    await wipe(prisma);

    indexer = new IndexerService(prisma, chain, config);
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

  it("mirrors the player, the round and the position within 4 s", async () => {
    await waitFor(
      "the deposit and the round to reach Postgres",
      async () =>
        (await prisma.player.count()) > 0 &&
        (await prisma.round.count()) > 0 &&
        (await prisma.position.count()) > 0,
      // The boot sweep runs at once; the ticket's 4 s budget covers one RPC round trip.
      4_000 - (Date.now() - startedAt),
    );
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    expect(await prisma.player.findMany({ where: { isHouse: false } })).toMatchObject([
      { owner: depositor.publicKey.toBase58(), principal: DEPOSIT, entries: DEPOSIT - STAKE },
    ]);
    expect(await prisma.round.findMany()).toMatchObject([
      { id: 1n, epochId: 1n, status: 0, pot: STAKE, winningTile: null },
    ]);
    expect(await prisma.position.findMany()).toMatchObject([
      {
        address: position.toBase58(),
        owner: depositor.publicKey.toBase58(),
        roundId: 1n,
        tiles: TILE_ZERO,
        stakePerTile: STAKE,
      },
    ]);
    expect(await prisma.pool.findMany()).toMatchObject([
      { poolId, totalPrincipal: DEPOSIT, currentEpochId: 1n },
    ]);
  }, 30_000);

  it("drops the Position row once settle_position closes the account", async () => {
    await waitUntil(roundEndsAt);

    // The seed is unknowable before this call (beta-launch-fixes ticket 02):
    // it depends on a nonce this test generates fresh, mixed in by the
    // program, so it cannot be read back off the Round account beforehand
    // the way it could before the nonce landed.
    const nonce = randomNonce();
    const seed = vrfSeed("round", chain.poolAddress(), 1n, nonce);
    const randomness = randomnessAddress(seed);

    await methods
      .requestRoundRandomness(Array.from(nonce))
      .accountsPartial({
        payer: authority.publicKey,
        pool: chain.poolAddress(),
        round,
        randomness,
        vrfNetworkState: VRF_NETWORK_STATE,
        vrfTreasury: VRF_TREASURY,
        vrfProgram: VRF_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Any randomness will do: the tile comes from `vrf::unbiased_u64`, and the
    // Position row goes once settle_position closes the account, win or lose.
    const drawn = new Uint8Array(64).fill(0);
    await methods
      .testFulfill(Array.from(seed), Array.from(drawn))
      .accountsPartial({
        payer: authority.publicKey,
        randomness,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await methods
      .settleRound()
      .accountsPartial({
        caller: authority.publicKey,
        pool: chain.poolAddress(),
        round,
        randomness,
        house: chain.playerAddress(authority.publicKey),
        weightTree: weightTree.publicKey,
      })
      .rpc();

    await waitFor(
      "the settled round to reach Postgres",
      async () =>
        (
          await prisma.round.findUnique({
            where: { poolAddress_id: { poolAddress: chain.poolAddress().toBase58(), id: 1n } },
          })
        )?.winningTile != null,
      8_000,
    );

    await methods
      .settlePosition()
      .accountsPartial({
        pool: chain.poolAddress(),
        weightTree: weightTree.publicKey,
        round,
        player: chain.playerAddress(depositor.publicKey),
        owner: depositor.publicKey,
        position,
      })
      .rpc();

    await waitFor(
      "the closed Position row to be deleted",
      async () => (await prisma.position.count()) === 0,
      8_000,
    );
  }, 120_000);

  it("stores the round's finalized events and leaves a cursor behind", async () => {
    const wanted = ["Deposited", "RoundOpened", "PositionBought", "RoundSettled", "PositionSettled"];
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
    prisma.position.deleteMany(),
    prisma.player.deleteMany(),
    prisma.round.deleteMany(),
    prisma.epoch.deleteMany(),
    prisma.referralGrantShare.deleteMany(),
    prisma.referralGrant.deleteMany(),
    prisma.operatorState.deleteMany(),
    prisma.yieldIndexPoint.deleteMany(),
    prisma.weightTreeState.deleteMany(),
    prisma.pool.deleteMany(),
  ]);
}
