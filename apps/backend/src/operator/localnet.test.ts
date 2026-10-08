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
// operator drives the whole custody protocol here; the test only deposits. The
// venue is the `test-venue` stub, so deploy runs for real against it. The
// draw steps wait on the Epoch snapshot (off-chain-tickets ticket 12), so the
// run ends with epoch 1 Ended and the operator reporting `snapshot_pending`.
import "reflect-metadata";

import { BN } from "@anchor-lang/core";
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
} from "@solana/web3.js";
import type { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import { afterAll, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { programDataAddress } from "../chain/pda";
import { deployWallet } from "../chain/deploy-wallet.fixture";
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  DEFAULT_RPC_TIMEOUT_MS,
  type HexVaultEnv,
} from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { decodeEpoch, decodePool, EPOCH_STATUS, type PoolState } from "./chain-state";
import { OperatorService } from "./operator.service";
import { ensurePoolRow } from "./pool-row.fixture";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL;

// The operator writes OperatorState and reads Players here. Same database the
// unit tests use; every row this file writes is deleted again below.
process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

/** Pinned on the pool at creation; `test-vrf` builds never dereference it. */
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

const EPOCH_SECONDS = 40;
/** 400 USDC each: 800 free idle against a 10% target leaves 720 above it,
 *  over the 100 USDC minimum, so the operator deploys without being asked. */
const DEPOSIT = 400_000_000n;
const WALLET_FUNDS = 500_000_000n;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of an Anchor methods builder this file drives. */
interface TxBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): TxBuilder;
  signers(signers: Keypair[]): TxBuilder;
  rpc(): Promise<string>;
}

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
    "runs an epoch end to end: venue deploy, the next epoch opens, the draw waits for the snapshot",
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
      await method("createPool", {
        poolId: new BN(poolId.toString()),
        // One key plays both roles here: it pays, cranks and administers.
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(86_400),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        vrfTimeout: new BN(120),
        minDeposit: new BN(1_000_000),
        minJackpot: new BN(1),
        // Under the epoch length this run sets below: set_params refuses a
        // payout timeout at or above it.
        payoutTimeout: new BN(30),
        // Base yield is off (0): it is not what this suite is about.
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
      // Start the jackpot the way `bootstrap --start` does, so the operator
      // begins epochs.
      await method("setFeaturePause", { jackpot: {} }, false)
        .accountsPartial({ signer: authority.publicKey, pool })
        .rpc();

      // Params apply to the next epoch created, so this lands before the
      // operator opens the first one.
      await method("setParams", {
        epochSeconds: new BN(EPOCH_SECONDS),
        epochAnchor: null,
        vrfTimeout: null,
        minDeposit: null,
        minJackpot: null,
        payoutTimeout: null,
        baseRateBps: null,
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

      const operator = new OperatorService(chain, prisma, config);
      // Also the indexer's job: the Pool row every pool-scoped row the
      // operator touches references (ADR 0016).
      poolKey = pool.toBase58();
      await ensurePoolRow(prisma, poolKey, poolId);

      const actions: (string | null)[] = [];
      const pending: string[] = [];
      let stopped = false;
      const crank = (async () => {
        while (!stopped) {
          const outcome = await operator.tick();
          if (outcome) {
            actions.push(outcome.action);
            if (outcome.snapshotPending) pending.push(outcome.snapshotPending.step);
          }
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
              acceptedMint: mint,
              ownerToken: wallet.token,
              principalVault: chain.principalVaultAddress(),
              ...venue,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
        }
        // 800 free idle is far above the 10% target: the operator deploys the
        // excess into the stub venue on its own, with no instruction from here.
        await waitFor(
          async () => (await readPool()).venueValue >= 700_000_000n,
          "the operator to deploy idle USDC into the venue",
          60_000,
        );

        // Epoch 1 ends: the operator's begin_epoch syncs the venue and opens
        // epoch 2, then waits for the snapshot before it asks for the draw.
        await waitFor(
          async () => (await readPool()).currentEpochId === 2n,
          "the operator to begin epoch 2",
          90_000,
        );
        await waitFor(async () => pending.includes("request_draw"), "snapshot_pending", 30_000);
        // A few more ticks, so a stray draw step would have had its chance.
        await sleep(2_000);

        expect((await readEpoch(1n))?.status).toBe(EPOCH_STATUS.ENDED);
        expect(actions).toContain("begin_epoch");
        expect(actions).not.toContain("request_draw");
        expect(actions.filter((action) => action?.includes("round"))).toEqual([]);
        const state = await prisma.operatorState.findUniqueOrThrow({ where: { poolAddress: poolKey } });
        expect(state.lastError).toBeNull();
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
