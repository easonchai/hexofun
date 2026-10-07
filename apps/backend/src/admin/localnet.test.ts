// End to end against a solana-test-validator running the `test-vrf` build:
//
//   HEXVAULT_SKIP_BUILD=1 HEXVAULT_RPC_PORT=9299 \
//     sh tests/run-local.sh --root apps/backend --config vitest.config.ts \
//     src/admin/localnet.test.ts
//
// Same shape as ../operator/localnet.test.ts: `run-local.sh` ends in
// `pnpm exec vitest` from the repo root, so `--root` points vitest at this
// package. Skipped everywhere else, so `pnpm test` stays offline.
//
// Mainnet-review-fixes ticket 05: bootstrap sets the Bought tickets pause on
// mainnet, and `start-buy-tickets` is the only thing that clears it. This
// drives that command through `run` against a real pool, then buys Tickets.
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
  type TransactionInstruction,
} from "@solana/web3.js";
import type { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  DEFAULT_RPC_TIMEOUT_MS,
  type HexVaultEnv,
} from "../config/env";
import { run } from "./index";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL;

/** Pinned on the pool at creation; `test-vrf` builds never dereference it. */
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

/** `create_pool`'s Weight tree: discriminator plus the zero-copy header. */
const WEIGHT_TREE_SPACE = 8 + 48;
const TICKETS_PER_USDC = 10;
const DEPOSIT = 4_000_000n;
const BUY = 1_000_000n;

/** The subset of an Anchor methods builder this file drives. */
interface TxBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): TxBuilder;
  signers(signers: Keypair[]): TxBuilder;
  preInstructions(instructions: TransactionInstruction[]): TxBuilder;
  rpc(): Promise<string>;
}

describe.skipIf(!RPC_URL)("admin CLI on localnet", () => {
  it(
    "start-buy-tickets clears the Bought tickets pause, then a Player buys Tickets",
    async () => {
      const connection = new Connection(RPC_URL as string, "confirmed");
      // One key plays both roles: it pays, administers and begins the epoch.
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
      // SAFETY: ChainService reads only the six keys set here.
      const config = stubConfig({
        DATABASE_URL: "",
        RPC_URL: RPC_URL ?? "",
        RPC_TIMEOUT_MS: DEFAULT_RPC_TIMEOUT_MS,
        PROGRAM_ID: String(loadIdl().address),
        POOL_ID: poolId.toString(),
        CLUSTER: "devnet",
        OPERATOR_KEYPAIR: bs58.encode(authority.secretKey),
        ACCEPTED_MINT: mint.toBase58(),
        PRIORITY_FEE_MAX_MICROLAMPORTS: DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
      } as HexVaultEnv);
      const chain = new ChainService(connection, config);
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
      // SAFETY: Program<Idl> has no generated method types; the name is
      // checked against the IDL right here.
      const method = (name: string, ...args: unknown[]): TxBuilder => {
        const factory = (chain.program.methods as Record<string, ((...a: unknown[]) => TxBuilder) | undefined>)[name];
        if (!factory) throw new Error(`instruction ${name} is missing from the IDL`);
        return factory(...args);
      };

      await method("createPool", {
        poolId: new BN(poolId.toString()),
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(86_400),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        roundSeconds: new BN(15),
        closeBuffer: new BN(5),
        vrfTimeout: new BN(120),
        minDeposit: new BN(1_000_000),
        houseCutBps: 0,
        minJackpot: new BN(1),
        payoutTimeout: new BN(30),
        baseRateBps: 0,
        ticketsPerUsdc: TICKETS_PER_USDC,
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
      // create_pool leaves the game and the jackpot paused; start both the
      // way `bootstrap --start` does, so only the Bought tickets pause is left.
      for (const feature of ["game", "jackpot"]) {
        await method("setFeaturePause", { [feature]: {} }, false)
          .accountsPartial({ signer: authority.publicKey, pool })
          .rpc();
      }

      const owner = Keypair.generate();
      await airdrop(connection, owner.publicKey, 5);
      const ownerToken = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint,
        owner.publicKey,
      );
      await mintTo(connection, authority, mint, ownerToken.address, authority, DEPOSIT + BUY);
      await method("deposit", new BN(DEPOSIT.toString()))
        .accountsPartial({
          owner: owner.publicKey,
          pool,
          player: chain.playerAddress(owner.publicKey),
          acceptedMint: mint,
          ownerToken: ownerToken.address,
          principalVault: chain.principalVaultAddress(),
          ...venue,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      // Buying needs an epoch to land in; the first `begin_epoch` has none to wait for.
      await method("beginEpoch")
        .accountsPartial({
          operator: authority.publicKey,
          pool,
          currentEpoch: chain.epochAddress(0n),
          epochTwoBehind: chain.epochAddress(0n),
          newEpoch: chain.epochAddress(1n),
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const buyTickets = () =>
        method("buyTickets", new BN(BUY.toString()))
          .accountsPartial({
            owner: owner.publicKey,
            pool,
            player: chain.playerAddress(owner.publicKey),
            acceptedMint: mint,
            ownerToken: ownerToken.address,
            jackpotVault: chain.jackpotVaultAddress(),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
      const bought = async (): Promise<{ paused: boolean; entries: bigint }> => {
        const [poolInfo, playerInfo] = await Promise.all([
          connection.getAccountInfo(pool),
          connection.getAccountInfo(chain.playerAddress(owner.publicKey)),
        ]);
        const poolAccount = chain.program.coder.accounts.decode<{ buyTicketsPaused: boolean }>(
          "pool",
          poolInfo?.data ?? Buffer.alloc(0),
        );
        const player = chain.program.coder.accounts.decode<{ entries: BN }>(
          "player",
          playerInfo?.data ?? Buffer.alloc(0),
        );
        return {
          paused: poolAccount.buyTicketsPaused,
          entries: BigInt(player.entries.toString()),
        };
      };
      const admin = { signer: chain.keypair.publicKey, multisig: false };

      // What bootstrap does on mainnet, through the CLI's own command.
      await run({ kind: "pause-buy-tickets" }, chain, admin);
      expect((await bought()).paused).toBe(true);
      await expect(buyTickets()).rejects.toThrow(/BuyTicketsPaused/);

      await run({ kind: "start-buy-tickets" }, chain, admin);
      expect((await bought()).paused).toBe(false);
      await buyTickets();
      // The deposit became Tickets when epoch 1 began; the purchase lands on top.
      expect((await bought()).entries).toBe(DEPOSIT + BUY * BigInt(TICKETS_PER_USDC));
    },
    120_000,
  );
});

function stubConfig(env: HexVaultEnv): ConfigService<HexVaultEnv, true> {
  return {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}
