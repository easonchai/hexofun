// The epoch draw end to end against a solana-test-validator running the
// `test-vrf` build (off-chain-tickets ticket 12). Three wallets deposit, the
// indexer books their Tickets and the Epoch snapshot, and the operator
// commits it with `request_draw`. The test fulfils the randomness, the
// operator draws, and `GET /epochs/:id/draw` names the winner and the proof.
// The first payout is held back from the operator and sent by a second signer
// with the API's proof; the next epoch is paid by the operator itself.
//
//   HEXVAULT_SKIP_BUILD=1 HEXVAULT_RPC_PORT=8912 \
//     sh tests/run-local.sh --root apps/backend --config vitest.config.ts \
//     src/operator/draw.localnet.test.ts
//
// Skipped everywhere else. Takes about four minutes: epochs are 45 s and the
// ledger books on finalized transactions.
import "reflect-metadata";

import { BN, BorshInstructionCoder } from "@anchor-lang/core";
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
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { ApiService } from "../api/api.service";
import { toJsonSafe } from "../api/serialization.interceptor";
import { ChainService } from "../chain/chain.service";
import { deployWallet } from "../chain/deploy-wallet.fixture";
import { loadIdl } from "../chain/idl";
import { programDataAddress } from "../chain/pda";
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  DEFAULT_RPC_TIMEOUT_MS,
  type HexVaultEnv,
} from "../config/env";
import { IndexerService } from "../indexer/indexer.service";
import { PrismaService } from "../prisma/prisma.service";
import { decodeEpoch, EPOCH_STATUS } from "./chain-state";
import { OperatorService } from "./operator.service";
import { epochSeed, isFulfilled, randomnessAddress } from "./vrf";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL;

process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

/** Pinned on the pool at creation; `test-vrf` builds never dereference it. */
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

const EPOCH_SECONDS = 45;
const DEPOSITS = [100_000_000n, 200_000_000n, 300_000_000n];
const PRIZE = 5_000_000n;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of an Anchor methods builder this file drives. */
interface TxBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): TxBuilder;
  signers(signers: Keypair[]): TxBuilder;
  rpc(): Promise<string>;
}

/** `GET /epochs/:id/draw` after the JSON round trip every client sees. */
interface DrawJson {
  epochId: string;
  status: number;
  root: string | null;
  depth: number;
  leafCount: number;
  totalTickets: string;
  nonce: string | null;
  seed: string | null;
  randomness: string | null;
  target: string | null;
  winner: string | null;
  winnerIndex: number | null;
  winnerTickets: string | null;
  proof: { hash: string; sum: string }[] | null;
}

/**
 * Checks a draw using only the API response and the chain's Epoch account, with
 * nothing imported from the backend: the leaf hash, the walk to the root taking
 * the direction from the index bits, the committed total, and the target's
 * range (research 01).
 */
function verifiesAgainstChain(
  draw: DrawJson,
  chainEpoch: { snapshotRoot: Buffer; snapshotDepth: number; leafCount: number; totalTickets: bigint; target: bigint },
): boolean {
  if (draw.winner === null || draw.winnerIndex === null || draw.winnerTickets === null || draw.proof === null) {
    return false;
  }
  const sha = (...parts: Buffer[]): Buffer => createHash("sha256").update(Buffer.concat(parts)).digest();
  const u64 = (n: bigint): Buffer => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(n);
    return out;
  };
  const tickets = BigInt(draw.winnerTickets);
  if (draw.proof.length !== chainEpoch.snapshotDepth || draw.winnerIndex >= chainEpoch.leafCount) return false;
  let hash = sha(Buffer.from([0]), Buffer.from(bs58.decode(draw.winner)), u64(tickets));
  let sum = tickets;
  let prefix = 0n;
  draw.proof.forEach((sibling, level) => {
    const siblingHash = Buffer.from(sibling.hash, "hex");
    const siblingSum = BigInt(sibling.sum);
    if ((draw.winnerIndex! >> level) & 1) {
      prefix += siblingSum;
      hash = sha(Buffer.from([1]), siblingHash, u64(siblingSum), hash, u64(sum));
    } else {
      hash = sha(Buffer.from([1]), hash, u64(sum), siblingHash, u64(siblingSum));
    }
    sum += siblingSum;
  });
  return (
    hash.equals(chainEpoch.snapshotRoot) &&
    sum === chainEpoch.totalTickets &&
    prefix <= chainEpoch.target &&
    chainEpoch.target < prefix + tickets
  );
}

describe.skipIf(!RPC_URL)("the epoch draw on localnet", () => {
  let prisma: PrismaService | null = null;
  let indexer: IndexerService | null = null;
  let stopped = false;
  let crank: Promise<void> = Promise.resolve();

  afterAll(async () => {
    stopped = true;
    await crank;
    if (indexer) await indexer.onModuleDestroy();
    if (prisma) await prisma.$disconnect();
  });

  it(
    "commits the snapshot, draws, and pays the API's winner by a second signer and by the operator",
    async () => {
      const connection = new Connection(RPC_URL as string, "confirmed");
      prisma = new PrismaService();
      await prisma.$connect();
      const authority = Keypair.generate();
      await airdrop(connection, authority.publicKey, 20);
      const mint = await createMint(connection, authority, authority.publicKey, null, 6);
      const treasury = await createAccount(connection, authority, mint, authority.publicKey, Keypair.generate());
      const buybackReserve = await createAccount(
        connection,
        authority,
        mint,
        authority.publicKey,
        Keypair.generate(),
      );

      const poolId = BigInt(Date.now());
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
        admin: authority.publicKey,
        operator: authority.publicKey,
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(86_400),
        epochAnchor: new BN(Math.floor(Date.now() / 1000)),
        vrfTimeout: new BN(120),
        minDeposit: new BN(1_000_000),
        minJackpot: new BN(1),
        payoutTimeout: new BN(30),
        baseRateBps: 0,
        venueKind: 1,
      })
        .accountsPartial({
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
      await method("setFeaturePause", { jackpot: {} }, false)
        .accountsPartial({ signer: authority.publicKey, pool })
        .rpc();
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

      const readEpochAccount = async (id: bigint) => {
        const info = await connection.getAccountInfo(chain.epochAddress(id));
        return info ? info.data : null;
      };
      const readEpoch = async (id: bigint) => {
        const data = await readEpochAccount(id);
        return data ? decodeEpoch(chain.program, data) : null;
      };
      /** What the Epoch account itself holds: all a checker outside the backend gets to see. */
      const committedOf = async (id: bigint) => {
        // SAFETY: the anchor coder returns the account's fields by name.
        const raw = chain.program.coder.accounts.decode("epoch", (await readEpochAccount(id)) as Buffer) as {
          snapshotRoot: number[];
          snapshotDepth: number;
          leafCount: number;
          totalTickets: { toString(): string };
          target: { toString(): string };
          vrfSeed: number[];
          winner: PublicKey;
        };
        return {
          snapshotRoot: Buffer.from(raw.snapshotRoot),
          snapshotDepth: raw.snapshotDepth,
          leafCount: raw.leafCount,
          totalTickets: BigInt(raw.totalTickets.toString()),
          target: BigInt(raw.target.toString()),
          vrfSeed: Buffer.from(raw.vrfSeed),
          winner: raw.winner,
        };
      };
      const currentEpochId = async (): Promise<bigint> => {
        const info = await connection.getAccountInfo(pool);
        if (!info) throw new Error("pool disappeared");
        // SAFETY: the anchor coder returns the account's fields by name; only this one is read.
        return BigInt(String((chain.program.coder.accounts.decode("pool", info.data) as { currentEpochId: unknown }).currentEpochId));
      };
      const principalOf = async (owner: PublicKey): Promise<bigint> => {
        const info = await connection.getAccountInfo(chain.playerAddress(owner));
        if (!info) throw new Error(`no Player for ${owner.toBase58()}`);
        // SAFETY: as above.
        return BigInt(String((chain.program.coder.accounts.decode("player", info.data) as { principal: unknown }).principal));
      };

      // Holds the first payout back from the operator and notes which epoch it was.
      let heldEpoch: bigint | null = null;
      const send = chain.send.bind(chain);
      const instructionCoder = new BorshInstructionCoder(chain.program.idl);
      chain.send = (async (instructions: TransactionInstruction[], ...rest: unknown[]) => {
        const first = instructions[0];
        if (first && first.programId.equals(chain.programId) && instructionCoder.decode(first.data)?.name === "payout") {
          const epochKey = first.keys[3]?.pubkey;
          if (heldEpoch === null) {
            for (let id = 1n; id < 20n && heldEpoch === null; id += 1n) {
              if (epochKey?.equals(chain.epochAddress(id))) heldEpoch = id;
            }
          }
          if (epochKey?.equals(chain.epochAddress(heldEpoch ?? 0n))) throw new Error("EpochNotDrawn");
        }
        return (send as (...a: unknown[]) => Promise<string>)(instructions, ...rest);
      }) as typeof chain.send;

      const operator = new OperatorService(chain, prisma, config);
      indexer = new IndexerService(prisma, chain);
      indexer.onModuleInit();
      const api = new ApiService(prisma, chain, config);
      const poolKey = pool.toBase58();

      /** Fulfils the randomness of an epoch that is waiting for it, as ORAO would. */
      const fulfilWaiting = async (): Promise<void> => {
        const id = (await currentEpochId()) - 1n;
        const epoch = id >= 1n ? await readEpoch(id) : null;
        if (!epoch || epoch.status !== EPOCH_STATUS.DRAWING) return;
        const randomness = randomnessAddress(chain.programId, epoch.vrfSeed, true);
        if (isFulfilled((await connection.getAccountInfo(randomness))?.data)) return;
        await method("testFulfill", Array.from(epoch.vrfSeed), Array.from(Buffer.alloc(64, 7)))
          .accountsPartial({ payer: authority.publicKey, randomness, systemProgram: SystemProgram.programId })
          .rpc();
      };

      const actions: (string | null)[] = [];
      crank = (async () => {
        while (!stopped) {
          try {
            const outcome = await operator.tick();
            if (outcome) actions.push(outcome.action);
            await fulfilWaiting();
            await indexer?.tick();
          } catch {
            // The next pass reads the chain again; a failed assertion below names what was missing.
          }
          await sleep(400);
        }
      })();

      await waitFor(async () => (await currentEpochId()) >= 1n, "the first epoch", 60_000);

      const wallets = await Promise.all(DEPOSITS.map(() => fundedWallet(connection, authority, mint)));
      for (const [i, wallet] of wallets.entries()) {
        await method("deposit", new BN((DEPOSITS[i] as bigint).toString()))
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
      // The prize the first draw is for.
      await mintTo(connection, authority, mint, chain.jackpotVaultAddress(), authority, PRIZE);

      // The ledger gives each wallet Tickets at the next epoch boundary, and the
      // snapshot taken after that lists all three.
      const owners = wallets.map((wallet) => wallet.keypair.publicKey.toBase58());
      await waitFor(
        async () =>
          (await prisma?.ticketBalance.count({ where: { poolAddress: poolKey, owner: { in: owners }, tickets: { gt: 0n } } })) === 3,
        "the ledger to give all three wallets Tickets",
        240_000,
      );

      // The operator tries to pay the first drawn epoch; the held send records which one.
      await waitFor(async () => heldEpoch !== null, "the operator to reach payout of the first drawn epoch", 240_000);
      const first = heldEpoch as unknown as bigint;
      expect(first).toBeGreaterThan(1n);
      const drawOf = async (id: bigint): Promise<DrawJson> => toJsonSafe(await api.getEpochDraw(id)) as DrawJson;
      await waitFor(async () => (await drawOf(first)).status === EPOCH_STATUS.DRAWN, "the mirror to show epoch Drawn", 60_000);

      const draw = await drawOf(first);
      const committed = await committedOf(first);

      // The API serves what the chain holds, and the seed the chain derived.
      expect(draw.root).toBe(committed.snapshotRoot.toString("hex"));
      expect([draw.depth, draw.leafCount, BigInt(draw.totalTickets)]).toEqual([
        committed.snapshotDepth,
        committed.leafCount,
        committed.totalTickets,
      ]);
      expect(committed.leafCount).toBe(3);
      expect(draw.seed).toBe(committed.vrfSeed.toString("hex"));
      expect(draw.seed).toBe(
        epochSeed(pool, first, Buffer.from(draw.nonce as string, "hex"), committed.snapshotRoot, committed.totalTickets).toString("hex"),
      );
      expect(draw.randomness).toBe(randomnessAddress(chain.programId, committed.vrfSeed, true).toBase58());
      expect(draw.target).toBe(committed.target.toString());
      expect(owners).toContain(draw.winner);
      expect(verifiesAgainstChain(draw, committed)).toBe(true);
      // A script that breaks one sibling fails the same check.
      const tampered = { ...draw, proof: (draw.proof ?? []).map((s, i) => (i === 0 ? { ...s, sum: String(BigInt(s.sum) + 1n) } : s)) };
      expect(verifiesAgainstChain(tampered, committed)).toBe(false);

      // A second signer cranks `payout` with the API's proof.
      const winner = new PublicKey(draw.winner as string);
      const before = await principalOf(winner);
      const jackpot = (await prisma.epoch.findUniqueOrThrow({ where: { poolAddress_id: { poolAddress: poolKey, id: first } } })).jackpotAmount;
      expect(jackpot).toBe(PRIZE);
      const second = Keypair.generate();
      await airdrop(connection, second.publicKey, 1);
      await method(
        "payout",
        draw.winnerIndex,
        new BN(draw.winnerTickets as string),
        (draw.proof ?? []).map((s) => ({ hash: Array.from(Buffer.from(s.hash, "hex")), sum: new BN(s.sum) })),
      )
        .accountsPartial({
          caller: second.publicKey,
          pool,
          acceptedMint: mint,
          epoch: chain.epochAddress(first),
          winner: chain.playerAddress(winner),
          jackpotVault: chain.jackpotVaultAddress(),
          principalVault: chain.principalVaultAddress(),
          treasury,
          buybackReserve,
          ...venue,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([second])
        .rpc();
      expect((await readEpoch(first))?.status).toBe(EPOCH_STATUS.PAID);
      expect(await principalOf(winner)).toBe(before + PRIZE);

      // The next epoch needs a prize of its own; the operator draws and pays it.
      await mintTo(connection, authority, mint, chain.jackpotVaultAddress(), authority, PRIZE);
      const next = first + 1n;
      await waitFor(async () => (await readEpoch(next))?.status === EPOCH_STATUS.PAID, `epoch ${next} to be paid by the operator`, 240_000);
      await waitFor(async () => (await drawOf(next)).winner !== null, "the API to name the second winner", 60_000);
      const drawNext = await drawOf(next);
      const nextWinner = new PublicKey(drawNext.winner as string);
      const committedNext = await committedOf(next);
      expect(verifiesAgainstChain(drawNext, committedNext)).toBe(true);
      expect(committedNext.winner.toBase58()).toBe(nextWinner.toBase58());

      // Empty first epoch: committed as zeros and rolled over, not stranded.
      expect((await readEpoch(1n))?.status).toBe(EPOCH_STATUS.ROLLED_OVER);

      // Both prizes are Principal on chain and `prize` rows in the ledger.
      await waitFor(
        async () => (await prisma?.ticketLedger.count({ where: { poolAddress: poolKey, reason: "prize" } })) === 2,
        "the ledger to book both prizes",
        90_000,
      );
      const prizes = await prisma.ticketLedger.findMany({ where: { poolAddress: poolKey, reason: "prize" }, orderBy: { id: "asc" } });
      expect(prizes.map((row) => [row.owner, row.delta])).toEqual([
        [winner.toBase58(), PRIZE],
        [nextWinner.toBase58(), PRIZE],
      ]);

      expect(actions.filter((action) => action?.includes("round"))).toEqual([]);
      expect(actions).toContain("request_draw");
      expect(actions).toContain("draw");
      const state = await prisma.operatorState.findUniqueOrThrow({ where: { poolAddress: poolKey } });
      expect(state.snapshotMismatch).not.toBe(true);
    },
    540_000,
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
  const account = await getOrCreateAssociatedTokenAccount(connection, authority, mint, keypair.publicKey);
  await mintTo(connection, authority, mint, account.address, authority, 500_000_000n);
  return { keypair, token: account.address };
}

async function waitFor(condition: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}
