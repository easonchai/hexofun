// End to end against a solana-test-validator running the `test-vrf` build:
//
//   HEXVAULT_SKIP_BUILD=1 HEXVAULT_RPC_PORT=9299 \
//     sh tests/run-local.sh --root apps/backend --config vitest.config.ts \
//     src/operator/localnet.test.ts
//
// run-local.sh ends in `pnpm exec vitest` from the repo root, so `--root`
// points vitest at this package and `--config` is then relative to it.
//
// Skipped everywhere else, so `pnpm test` in this package stays offline. The
// operator drives the whole protocol here; the test only deposits, buys two
// positions, and stands in for the two things the operator does not own: the
// oracle (test_fulfill) and the indexer (Position and Round rows). The venue
// is the `test-venue` stub, so deploy and harvest run for real against it.
import "reflect-metadata";

import { BN } from "@anchor-lang/core";
import {
  createAccount,
  createMint,
  getAssociatedTokenAddressSync,
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
import type { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import { afterAll, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { positionAddress } from "../chain/pda";
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  DEFAULT_RPC_TIMEOUT_MS,
  type HexVaultEnv,
} from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  decodeEpoch,
  decodePool,
  decodeRound,
  EPOCH_STATUS,
  ROUND_STATUS,
  type PoolState,
} from "./chain-state";
import type { IndexerQueries } from "./indexer-queries";
import { OperatorService } from "./operator.service";
import { ensurePoolRow } from "./pool-row.fixture";
import type { SparringService } from "./sparring";

import { randomnessAddress } from "./vrf";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL;

// The operator writes OperatorState and reads Players here. Same database the
// unit tests use; every row this file writes is deleted again below.
process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

/** Pinned on the pool at creation; `test-vrf` builds never dereference it. */
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

const EPOCH_SECONDS = 40;
const ROUND_SECONDS = 15;
const CLOSE_BUFFER = 5;
/** 400 USDC each: 800 free idle against a 10% target leaves 720 above it,
 *  over the 100 USDC minimum, so the operator deploys without being asked. */
const DEPOSIT = 400_000_000n;
const WALLET_FUNDS = 500_000_000n;
/** The prize this run funds by hand, standing in for the admin's daily
 *  deposit of harvested yield. */
const JACKPOT = 2_000_000n;
const STAKE_PER_TILE = 1_000n;
/** Tiles 0..17 and 18..35: between them the two players cover the board, so
 *  the round always settles rather than being forfeited to the House. */
const LOWER_TILES = (1n << 18n) - 1n;
const UPPER_TILES = ((1n << 36n) - 1n) ^ LOWER_TILES;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of an Anchor methods builder this file drives. */
interface TxBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): TxBuilder;
  signers(signers: Keypair[]): TxBuilder;
  preInstructions(instructions: TransactionInstruction[]): TxBuilder;
  rpc(): Promise<string>;
}

interface RawPosition {
  owner: PublicKey;
  round: PublicKey;
}

/** `create_pool`'s Weight tree: discriminator plus the zero-copy header. */
const WEIGHT_TREE_SPACE = 8 + 48;

describe.skipIf(!RPC_URL)("operator on localnet", () => {
  // Built inside the test: `skipIf` still evaluates this block, and there is
  // no validator (and no RPC url) when the suite is skipped.
  let prisma: PrismaService | null = null;
  let poolKey = "";

  afterAll(async () => {
    if (!prisma) return;
    // The Pool row stays: a Pool row is never deleted (ADR 0016), and each
    // run's pool id is fresh.
    await prisma.operatorState.deleteMany({ where: { poolAddress: poolKey } });
    await prisma.$disconnect();
  });

  it(
    "runs an epoch end to end: venue deploy, rounds settle, the tree picks the winner, the jackpot is paid",
    async () => {
      const connection = new Connection(RPC_URL as string, "confirmed");
      prisma = new PrismaService();
      const authority = Keypair.generate();
      await airdrop(connection, authority.publicKey, 20);
      const mint = await createMint(connection, authority, authority.publicKey, null, 6);
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
      // The admin's own token account, holding the prize it will hand to
      // `fund_jackpot` below. The operator stopped minting the jackpot
      // (ticket 03), so on a real cluster this is harvested yield; here it
      // is minted once, up front.
      const authorityToken = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint,
        authority.publicKey,
      );
      await mintTo(connection, authority, mint, authorityToken.address, authority, JACKPOT);

      const poolId = BigInt(Date.now());
      // run-local.sh points `loadIdl()` (via HEXVAULT_IDL_PATH) at the
      // freshly built target/idl/hex_vault.json, so this is the id it just
      // deployed, not whatever the committed src/idl/ snapshot carries.
      const programId = String(loadIdl().address);
      const config = stubConfig({
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        RPC_URL: RPC_URL ?? "",
        RPC_TIMEOUT_MS: DEFAULT_RPC_TIMEOUT_MS,
        PROGRAM_ID: programId,
        POOL_ID: poolId.toString(),
        CLUSTER: "devnet",
        OPERATOR_KEYPAIR: bs58.encode(authority.secretKey),
        ACCEPTED_MINT: mint.toBase58(),
        OPERATOR_SOL_WARN: 0.3,
        PRIORITY_FEE_MAX_MICROLAMPORTS: DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
        FAUCET_AMOUNT: "0",
        FAUCET_INTERVAL_SECONDS: "0",
        REFERRAL_QUALIFY_SECONDS: 604_800,
        ALERT_TICK_STALE_S: 300,
        ALERT_INDEXER_STALE_S: 600,
        ALERT_IDLE_LOW_S: 3600,
        ALERT_RESERVE_FREE_MIN: 100_000_000_000,
        INVITE_CIRCULATION_CAP: 50,
        INVITE_REDEEM_GRANT_COUNT: 2,
        CORS_ORIGIN: "http://localhost",
        PORT: "0",
        SPARRING_ENABLED: false,
      });

      const chain = new ChainService(connection, config);
      const method = (name: string, ...args: unknown[]): TxBuilder => {
        // SAFETY: Program<Idl> has no generated method types; the name is
        // checked against the IDL right here.
        const factory = (chain.program.methods as Record<string, ((...a: unknown[]) => TxBuilder) | undefined>)[name];
        if (!factory) throw new Error(`instruction ${name} is missing from the IDL`);
        return factory(...args);
      };

      const pool = chain.poolAddress();
      const weightTree = Keypair.generate();
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
      await method("createPool", {
        poolId: new BN(poolId.toString()),
        // One key plays both roles here: it pays, cranks and administers.
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(86_400),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        roundSeconds: new BN(ROUND_SECONDS),
        closeBuffer: new BN(CLOSE_BUFFER),
        vrfTimeout: new BN(120),
        minDeposit: new BN(1_000_000),
        // Rate zero on purpose: a cut gives the House Entries, so it registers
        // for the draw and can win it, and the assertions below expect exactly
        // the two depositors. tests/02-rounds covers the cut itself.
        houseCutBps: 0,
        minJackpot: new BN(1),
        // Under the 40 s epoch this run sets below: set_params refuses a
        // payout timeout at or above the epoch length. The operator pays the
        // winner within seconds, and never rolls a human winner over before
        // the five-minute drawn-unpaid window anyway.
        payoutTimeout: new BN(30),
        // Base yield and grant-tickets are off (0) so this suite's round and
        // jackpot flow behaves exactly as it did before these params
        // existed; `ticketsPerUsdc` only has to be positive to pass
        // `create_pool`'s own validation and is never exercised here.
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
      await method("testVenueInit")
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
      // Start them the way `bootstrap --start` does, jackpot first, so the
      // operator runs this pool as it did before either switch existed.
      for (const feature of ["jackpot", "game"]) {
        await method("setFeaturePause", { [feature]: {} }, false)
          .accountsPartial({ signer: authority.publicKey, pool })
          .rpc();
      }

      // Params apply to the next epoch created, so this lands before the
      // operator opens the first one.
      await method("setParams", {
        epochSeconds: new BN(EPOCH_SECONDS),
        epochAnchor: null,
        roundSeconds: null,
        closeBuffer: null,
        vrfTimeout: null,
        minDeposit: null,
        houseCutBps: null,
        minJackpot: null,
        payoutTimeout: null,
        baseRateBps: null,
        ticketsPerUsdc: null,
        bonusCapBps: null,
      })
        .accountsPartial({ admin: authority.publicKey, pool })
        .rpc();

      const readPool = async (): Promise<PoolState> => {
        const info = await connection.getAccountInfo(pool);
        if (!info) throw new Error("pool disappeared");
        return decodePool(chain.program, pool, info.data);
      };
      const readEpoch = async (id: bigint) => {
        const info = await connection.getAccountInfo(chain.epochAddress(id));
        return info ? decodeEpoch(chain.program, info.data) : null;
      };

      // Stands in for the indexer module: the sweep queries, answered off the
      // chain instead of Postgres. The winner needs no mirror any more: the
      // operator reads the Weight tree and the Player accounts itself.
      const indexer: IndexerQueries = {
        unsettledPositions: async () => {
          const terminal = new Map(
            (await allRounds(chain))
              .filter((round) => round.status !== ROUND_STATUS.OPEN && round.status !== ROUND_STATUS.REQUESTED)
              .map((round) => [round.address.toBase58(), round.roundId]),
          );
          return (await allPositions(chain))
            .filter((position) => terminal.has(position.round.toBase58()))
            .map((position) => ({
              address: positionAddress(chain.programId, position.round, position.owner).toBase58(),
              owner: position.owner.toBase58(),
              // SAFETY: `terminal.has` above already confirmed this key exists.
              roundId: terminal.get(position.round.toBase58()) as bigint,
            }));
        },
        // No referral binding in this fixture, so ticket 08's step has
        // nothing to do; it still has to be callable.
        referralGrantsDue: async () => [],
        markReferralGrantsSent: async () => {},
        // Same terminal-and-clear rule as unsettledPositions above, off the
        // chain instead of Postgres; this fixture has no `closed` flag to
        // mirror, so a Round this validator has already closed simply stops
        // showing up in `allRounds` at all.
        roundsToClose: async () => {
          const busy = new Set(
            (await allPositions(chain)).map((position) => position.round.toBase58()),
          );
          return (await allRounds(chain))
            .filter(
              (round) =>
                round.status !== ROUND_STATUS.OPEN &&
                round.status !== ROUND_STATUS.REQUESTED &&
                !busy.has(round.address.toBase58()),
            )
            .map((round) => round.roundId);
        },
      };

      // SAFETY: the Operator only ever calls `wake()` on the Sparring player,
      // and this test drives the crank itself rather than running one.
      const sparring = { wake: () => {} } as unknown as SparringService;
      const operator = new OperatorService(chain, prisma, indexer, sparring, config);
      // Also the indexer's job: the Pool row every pool-scoped row the
      // operator touches references (ADR 0016).
      poolKey = pool.toBase58();
      await ensurePoolRow(prisma, poolKey, poolId);

      let stopped = false;
      const crank = (async () => {
        while (!stopped) {
          await operator.tick();
          await fulfil(chain, method, authority);
          await sleep(400);
        }
      })();

      try {
        await waitFor(async () => (await readPool()).currentEpochId === 1n, "the first epoch");

        const [a, b] = await Promise.all([
          fundedWallet(connection, authority, mint),
          fundedWallet(connection, authority, mint),
        ]);
        for (const wallet of [a, b]) {
          await method("deposit", new BN(DEPOSIT.toString()))
            .accountsPartial({
              owner: wallet.keypair.publicKey,
              pool,
              player: chain.playerAddress(wallet.keypair.publicKey),
              weightTree: weightTree.publicKey,
              acceptedMint: mint,
              ownerToken: wallet.token,
              principalVault: chain.principalVaultAddress(),
              ...venue,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
          // A deposit holds no Ticket until the next epoch (ADR 0020), so the
          // admin grants the Tickets a depositor from yesterday would hold.
          await method("grantTickets", new BN(DEPOSIT.toString()))
            .accountsPartial({
              signer: authority.publicKey,
              pool,
              player: chain.playerAddress(wallet.keypair.publicKey),
              weightTree: weightTree.publicKey,
            })
            .rpc();
        }
        // 800 free idle is far above the 10% target: the operator deploys the
        // excess into the stub venue on its own, with no instruction from here.
        await waitFor(
          async () => (await readPool()).venueValue >= 700_000_000n,
          "the operator to deploy idle USDC into the venue",
          60_000,
        );

        // The prize. The operator stopped minting it (ticket 03), so the
        // test funds it the way the admin does on a real cluster: one
        // permissionless `fund_jackpot` before the epoch closes.
        await method("fundJackpot", new BN(JACKPOT.toString()))
          .accountsPartial({
            sourceAuthority: authority.publicKey,
            pool,
            acceptedMint: mint,
            source: getAssociatedTokenAddressSync(mint, authority.publicKey),
            jackpotVault: chain.jackpotVaultAddress(),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        // A non-House win compounds into the winner's Principal instead of
        // paying their token account (epochs.rs `payout`, spec's no-loss
        // model), so the win is asserted against Principal, not a token
        // balance.
        const principalOf = async (wallet: PublicKey): Promise<bigint> => {
          const info = await connection.getAccountInfo(chain.playerAddress(wallet));
          const raw = chain.program.coder.accounts.decode<{ principal: BN }>(
            "player",
            info?.data ?? Buffer.alloc(0),
          );
          return BigInt(raw.principal.toString());
        };
        const principalsBefore = new Map([
          [a.keypair.publicKey.toBase58(), await principalOf(a.keypair.publicKey)],
          [b.keypair.publicKey.toBase58(), await principalOf(b.keypair.publicKey)],
        ]);

        // The operator opens rounds on its own; wait for one with enough time
        // left to buy into.
        const roundId = await waitForRound(chain, readPool);
        const round = chain.roundAddress(roundId);
        for (const [wallet, tiles] of [
          [a, LOWER_TILES],
          [b, UPPER_TILES],
        ] as const) {
          await method("buyPosition", new BN(tiles.toString()), new BN(STAKE_PER_TILE.toString()))
            .accountsPartial({
              owner: wallet.keypair.publicKey,
              pool,
              player: chain.playerAddress(wallet.keypair.publicKey),
              weightTree: weightTree.publicKey,
              round,
              position: positionAddress(chain.programId, round, wallet.keypair.publicKey),
              systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
        }

        // The round settles and both Positions are closed by the operator.
        await waitFor(async () => {
          const info = await connection.getAccountInfo(round);
          if (!info) return false;
          return decodeRound(chain.program, info.data).status === ROUND_STATUS.SETTLED;
        }, "the round to settle", 90_000);

        await waitFor(async () => {
          const positions = await Promise.all(
            [a, b].map((wallet) =>
              connection.getAccountInfo(
                positionAddress(chain.programId, round, wallet.keypair.publicKey),
              ),
            ),
          );
          return positions.every((info) => info === null);
        }, "both positions to close", 90_000);

        // Epoch 1 ends: harvest, request_draw, draw and payout, all cranked.
        await waitFor(
          async () => (await readEpoch(1n))?.status === EPOCH_STATUS.PAID,
          "epoch 1 to be paid out",
          150_000,
        );

        const epoch = await readEpoch(1n);
        // The stub venue's rate never moves, so the harvest found nothing owed
        // and the prize is exactly what was funded by hand.
        expect(epoch?.jackpotAmount).toBe(JACKPOT);

        const info = await connection.getAccountInfo(chain.epochAddress(1n));
        const winner = chain.program.coder.accounts
          .decode<{ winner: PublicKey }>("epoch", info?.data ?? Buffer.alloc(0))
          .winner.toBase58();
        const winnerWallet = [a, b].find((w) => w.keypair.publicKey.toBase58() === winner);
        expect(winnerWallet, `winner ${winner} is one of the two depositors`).toBeDefined();

        const principalAfter = await principalOf(winnerWallet?.keypair.publicKey as PublicKey);
        expect(principalAfter - (principalsBefore.get(winner) ?? 0n)).toBe(epoch?.jackpotAmount);
      } finally {
        stopped = true;
        await crank;
      }
    },
    300_000,
  );
});

/** ChainService and OperatorService only ever call `get` on the config. */
function stubConfig(env: HexVaultEnv): ConfigService<HexVaultEnv, true> {
  return {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function fundedWallet(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
): Promise<{ keypair: Keypair; token: PublicKey }> {
  const keypair = Keypair.generate();
  await airdrop(connection, keypair.publicKey, 5);
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    keypair.publicKey,
  );
  await mintTo(connection, authority, mint, account.address, authority, WALLET_FUNDS);
  return { keypair, token: account.address };
}

async function programAccounts<T>(
  chain: ChainService,
  name: "position",
): Promise<{ address: PublicKey; account: T }[]> {
  // The coder's own discriminator: the layout rewrite changed Position's, so a
  // hard-coded one finds nothing and the sweep silently never runs.
  const accounts = await chain.connection.getProgramAccounts(chain.programId, {
    filters: [{ memcmp: chain.program.coder.accounts.memcmp(name) }],
  });
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    account: chain.program.coder.accounts.decode<T>(name, account.data),
  }));
}

const allPositions = async (chain: ChainService): Promise<RawPosition[]> =>
  (await programAccounts<RawPosition>(chain, "position")).map(({ account }) => account);

/** Every Round on chain, for the fake indexer's sweep to filter by status. */
async function allRounds(
  chain: ChainService,
): Promise<{ address: PublicKey; roundId: bigint; status: number }[]> {
  const coder = chain.program.coder.accounts;
  const accounts = await chain.connection.getProgramAccounts(chain.programId, {
    filters: [{ memcmp: coder.memcmp("round") }],
  });
  return accounts.map(({ pubkey, account }) => {
    const decoded = decodeRound(chain.program, account.data);
    return { address: pubkey, roundId: decoded.roundId, status: decoded.status };
  });
}

/**
 * The oracle. `test-vrf` builds fabricate the fulfilled account instead of
 * waiting for ORAO, so something has to notice a pending request; on devnet
 * ORAO's fulfillers do this.
 */
async function fulfil(
  chain: ChainService,
  method: (name: string, ...args: unknown[]) => TxBuilder,
  authority: Keypair,
): Promise<void> {
  const poolInfo = await chain.connection.getAccountInfo(chain.poolAddress());
  if (!poolInfo) return;
  const pool = decodePool(chain.program, chain.poolAddress(), poolInfo.data);

  const seeds: Uint8Array[] = [];
  if (pool.openRoundId > 0n) {
    const info = await chain.connection.getAccountInfo(chain.roundAddress(pool.openRoundId));
    const round = info ? decodeRound(chain.program, info.data) : null;
    if (round?.status === ROUND_STATUS.REQUESTED) seeds.push(round.vrfSeed);
  }
  if (pool.currentEpochId > 1n) {
    const info = await chain.connection.getAccountInfo(
      chain.epochAddress(pool.currentEpochId - 1n),
    );
    const epoch = info ? decodeEpoch(chain.program, info.data) : null;
    if (epoch?.status === EPOCH_STATUS.DRAWING) seeds.push(epoch.vrfSeed);
  }

  for (const seed of seeds) {
    const address = randomnessAddress(chain.programId, seed, true);
    if (await chain.connection.getAccountInfo(address)) continue;
    // Randomness derived from the seed: deterministic per request, different
    // for every round and epoch.
    const randomness = Uint8Array.from([...seed, ...seed]);
    await method("testFulfill", Array.from(seed), Array.from(randomness))
      .accountsPartial({
        payer: authority.publicKey,
        randomness: address,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}

/** An open round with enough time left before `close_buffer` to buy into. */
async function waitForRound(
  chain: ChainService,
  readPool: () => Promise<PoolState>,
): Promise<bigint> {
  let roundId = 0n;
  await waitFor(async () => {
    const pool = await readPool();
    if (pool.openRoundId === 0n) return false;
    const info = await chain.connection.getAccountInfo(chain.roundAddress(pool.openRoundId));
    if (!info) return false;
    const round = decodeRound(chain.program, info.data);
    const slot = await chain.connection.getSlot();
    const now = BigInt((await chain.connection.getBlockTime(slot)) ?? 0);
    if (round.status !== ROUND_STATUS.OPEN) return false;
    if (now + BigInt(CLOSE_BUFFER) + 4n >= round.endsAt) return false;
    roundId = round.roundId;
    return true;
  }, "an open round with time left to buy into", 90_000);
  return roundId;
}

async function waitFor(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}
