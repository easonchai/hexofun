// Shared plumbing every localnet suite needs: the provider/program, PDA
// derivers, and account bootstrap. Test files call
// `program.methods.x().accounts({...}).rpc()` directly instead of going
// through a per-instruction wrapper.

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAccount,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, BN, EventParser, Program, Wallet } from "@anchor-lang/core";
import idl from "../../target/idl/hex_vault.json";

const secret = Uint8Array.from(
  JSON.parse(readFileSync(process.env.ANCHOR_WALLET as string, "utf8")),
);
const connection = new Connection(process.env.ANCHOR_PROVIDER_URL as string, "confirmed");

export const provider = new AnchorProvider(connection, new Wallet(Keypair.fromSecretKey(secret)), {
  commitment: "confirmed",
});

export const program = new Program(idl as typeof idl, provider);
export const PROGRAM_ID = program.programId;

// Pinned on every pool at create_pool; test-vrf never reads it, since
// test_fulfill fabricates the randomness account directly.
export const DEVNET_VRF_NETWORK_STATE = new PublicKey(
  "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK",
);
// ORAO's fee treasury on devnet (`network_state.config.treasury`, read
// 2026-09-05). Forwarded on every request; ORAO rejects any other account.
// test-vrf never touches it either, any pubkey would do on localnet.
export const DEVNET_VRF_TREASURY = new PublicKey(
  "9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR",
);

function u64le(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function poolPda(poolId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), u64le(poolId)], PROGRAM_ID)[0];
}

export function playerPda(pool: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("player"), pool.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function epochPda(pool: PublicKey, epochId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), pool.toBuffer(), u64le(epochId)],
    PROGRAM_ID,
  )[0];
}

export function roundPda(pool: PublicKey, roundId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), pool.toBuffer(), u64le(roundId)],
    PROGRAM_ID,
  )[0];
}

export function positionPda(round: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), round.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function principalVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("principal"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function jackpotVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot"), pool.toBuffer()], PROGRAM_ID)[0];
}

/** The test-venue stub's reserve: shares held and the USDC-per-share rate. */
export function testVenueReservePda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("test-venue-reserve"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** The test-venue stub's USDC vault, owned by the pool PDA. */
export function testVenueVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("test-venue-vault"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** The four addresses `create_pool` pins and every syncing instruction is
 *  handed. Under test-venue: this program, the pool, and the stub's two PDAs. */
export interface VenueAccounts {
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
}

export function venueAccountsFor(pool: PublicKey): VenueAccounts {
  return {
    klendProgram: PROGRAM_ID,
    klendMarket: pool,
    klendReserve: testVenueReservePda(pool),
    klendCtoken: testVenueVaultPda(pool),
  };
}

/** Discriminator plus the zero-copy header; `create_pool` wants exactly
 *  this, a tree with zero nodes (yield-claimer ticket 04). */
export const WEIGHT_TREE_SPACE = 8 + 48;

/**
 * The top-level `create_account` that has to precede `create_pool` in the
 * same transaction: a fresh program-owned account sized for the Weight tree
 * header. Sign the transaction with `keypair` as well as `payer`.
 */
async function weightTreeAccount(
  payer: PublicKey,
): Promise<{ keypair: Keypair; ix: TransactionInstruction }> {
  const keypair = Keypair.generate();
  const ix = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: keypair.publicKey,
    space: WEIGHT_TREE_SPACE,
    lamports: await connection.getMinimumBalanceForRentExemption(WEIGHT_TREE_SPACE),
    programId: PROGRAM_ID,
  });
  return { keypair, ix };
}

/** The test-vrf stand-in PDA for a request seed (see vrf::randomness_address). */
export function randomnessPda(seed: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("test-vrf"), Buffer.from(seed)],
    PROGRAM_ID,
  )[0];
}

/**
 * Fabricates a fulfilled randomness account for `seed` and returns its
 * address, which the settle instruction expects to be handed.
 *
 * Read the seed off the account being settled (`round.vrfSeed`,
 * `epoch.vrfSeed`) rather than recomputing the keccak here: the program is
 * the authority on it, and tests then need no hash library.
 */
export async function fulfillRandomness(
  seed: Uint8Array | number[],
  randomness: Uint8Array | number[] = new Uint8Array(64).fill(7),
): Promise<PublicKey> {
  const seedBytes = Uint8Array.from(seed);
  const account = randomnessPda(seedBytes);
  await program.methods
    .testFulfill(Array.from(seedBytes), Array.from(Uint8Array.from(randomness)))
    .accountsPartial({
      payer: provider.wallet.publicKey,
      randomness: account,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return account;
}

/**
 * 64 randomness bytes whose leading LE u64 is `value`, so a test can pick the
 * winning tile or draw target instead of guessing what the oracle returns.
 */
export function randomnessFor(value: bigint | number): Uint8Array {
  const bytes = new Uint8Array(64).fill(0);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

// --- vrf_seed(domain, pool, id, nonce) --------------------------------------
//
// `request_round_randomness` and `close_registration` (beta-launch-fixes
// ticket 02) mix a 32-byte nonce into the seed, so a test has to derive the
// same seed client-side to know which randomness account to pass -- the
// address is unknowable from public inputs alone any more. No dependency in
// this workspace carries Solana's pre-standard Keccak (differs from SHA3-256
// only in the padding byte), so it is duplicated here from
// `apps/backend/src/operator/vrf.ts`'s own copy, for the same reason that
// file gives: it runs once or twice per test on 48-80 bytes, so speed is
// irrelevant and a real dependency is not worth adding for it.

function u64le64(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

const KECCAK_RATE = 136;
const KECCAK_ROUNDS = 24;

const KECCAK_ROUND_CONSTANTS = new BigUint64Array([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);

const KECCAK_ROTATIONS = new BigUint64Array([
  0n, 1n, 62n, 28n, 27n, 36n, 44n, 6n, 55n, 20n, 3n, 10n, 43n, 25n, 39n, 41n, 45n, 15n,
  21n, 8n, 18n, 2n, 61n, 56n, 14n,
]);

const rotl = (x: bigint, n: bigint): bigint => (n === 0n ? x : (x << n) | (x >> (64n - n)));

function keccakPermute(lanes: BigUint64Array): void {
  const c = new BigUint64Array(5);
  const b = new BigUint64Array(25);
  for (let round = 0; round < KECCAK_ROUNDS; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] = (lanes[x] as bigint) ^ (lanes[x + 5] as bigint) ^ (lanes[x + 10] as bigint) ^
        (lanes[x + 15] as bigint) ^ (lanes[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x += 1) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl(c[(x + 1) % 5] as bigint, 1n);
      for (let y = 0; y < 25; y += 5) lanes[x + y] = (lanes[x + y] as bigint) ^ d;
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(
          lanes[x + 5 * y] as bigint,
          KECCAK_ROTATIONS[x + 5 * y] as bigint,
        );
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        lanes[x + y] = (b[x + y] as bigint) ^ (~(b[((x + 1) % 5) + y] as bigint) & (b[((x + 2) % 5) + y] as bigint));
      }
    }
    lanes[0] = (lanes[0] as bigint) ^ (KECCAK_ROUND_CONSTANTS[round] as bigint);
  }
}

function keccak256(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array((Math.floor(input.length / KECCAK_RATE) + 1) * KECCAK_RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const lanes = new BigUint64Array(25);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE) {
    for (let lane = 0; lane < KECCAK_RATE / 8; lane += 1) {
      lanes[lane] = (lanes[lane] as bigint) ^ view.getBigUint64(offset + lane * 8, true);
    }
    keccakPermute(lanes);
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let lane = 0; lane < 4; lane += 1) out.setBigUint64(lane * 8, lanes[lane] as bigint, true);
  return digest;
}

/** `utils::vrf_seed`: keccak256(domain || pool || id_le || nonce). */
export function vrfSeed(
  domain: "round" | "epoch",
  pool: PublicKey,
  id: bigint,
  nonce: Uint8Array,
): Uint8Array {
  return keccak256(
    Buffer.concat([Buffer.from(domain), pool.toBuffer(), u64le64(id), Buffer.from(nonce)]),
  );
}

/** A fixed, non-zero nonce: tests don't need real unpredictability, just a
 *  value that isn't the account's zero-initialized default. */
export function testNonce(fill = 1): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` until it stops throwing. The localnet validator's on-chain
 * clock does not track wall-clock time closely enough to compute a sleep
 * duration from an `i64` unix-seconds deadline and `Date.now()` (observed
 * lagging real time by a few seconds over a short epoch), so every
 * time-gated instruction (an epoch or round boundary, a vrf timeout) is
 * driven by polling instead of a single calculated sleep.
 */
export async function retryUntilOk<T>(
  fn: () => Promise<T>,
  intervalMs = 750,
  maxAttempts = 120,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError;
}

/** The validator's actual on-chain clock (not `Date.now()`, which drifts a
 * few seconds from it and so is an unreliable proxy over a short window). */
export async function onChainNowSeconds(): Promise<number> {
  for (;;) {
    const slot = await connection.getSlot();
    const time = await connection.getBlockTime(slot);
    if (time !== null) return time;
    await sleep(200);
  }
}

/** Blocks until the validator's own clock reaches `targetUnixSeconds`. */
export async function sleepUntilOnChain(targetUnixSeconds: number): Promise<void> {
  while ((await onChainNowSeconds()) < targetUnixSeconds) {
    await sleep(500);
  }
}

/** Decodes the named event out of one confirmed transaction's logs. */
export async function findEvent<T = unknown>(
  signature: string,
  name: string,
): Promise<T | undefined> {
  const tx = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  const parser = new EventParser(program.programId, program.coder);
  for (const event of parser.parseLogs(logs)) {
    if (event.name === name) return event.data as T;
  }
  return undefined;
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// Unique per call and per process. Vitest gives each test file its own
// worker, and two workers reaching setupPool() in the same millisecond used
// to derive the same pool PDA: preflight passed for both, then the second
// `create_pool` failed on chain with the account already in use.
const poolNonce = BigInt(process.pid % 1_000);
let poolCounter = 0;
/** Exported for the few tests that call `create_pool` themselves instead of
 *  going through `setupPool`. */
export function nextPoolId(): bigint {
  poolCounter += 1;
  return BigInt(Date.now()) * 1_000_000n + poolNonce * 1_000n + BigInt(poolCounter);
}

export interface PoolParamsOverrides {
  epochSeconds?: number;
  /** Phase of the epoch grid. Defaults to the on-chain clock at pool
   * creation, which puts the first grid point one whole `epochSeconds`
   * after bootstrap, so epoch 1 is as long as it was before the grid
   * existed bar the seconds the test spends setting wallets up. */
  epochAnchor?: number;
  roundSeconds?: number;
  closeBuffer?: number;
  vrfTimeout?: number;
  minDeposit?: number;
  /** House cut in basis points, 0..=10_000. Defaults to the bootstrap rate,
   * so every round test settles against the cut the product ships with. */
  houseCutBps?: number;
  /** Jackpot floor below which the draw rolls the epoch over. Defaults to 0
   * (no floor) so a test that never funds the jackpot still reaches the
   * draw; the low-jackpot test sets it. */
  minJackpot?: number;
  /** Seconds a Drawn epoch waits for its payout before `rollover_epoch` will
   * take it. Defaults to a day, well past any test's run. */
  payoutTimeout?: number;
  /** Ceiling on the depositor share, as an APR in basis points. Defaults to
   * the bootstrap rate. */
  baseRateBps?: number;
  /** Tickets credited per USDC spent in `buy_tickets`. Defaults to the
   * bootstrap rate. */
  ticketsPerUsdc?: number;
  /** Share of `total_principal`, in basis points, an operator `grant_tickets`
   * call may credit pool-wide per epoch. Defaults to the bootstrap rate
   * (5%). */
  bonusCapBps?: number;
  /** Reuse an existing mint instead of creating a fresh one (e.g. to test
   * two pools sharing an accepted asset). The caller must not rely on this
   * pool's operator being the mint authority when a shared mint is passed. */
  mint?: PublicKey;
}

// Spec §7 defaults.
const DEFAULT_PARAMS = {
  epochSeconds: 86_400,
  roundSeconds: 60,
  closeBuffer: 5,
  vrfTimeout: 120,
  minDeposit: 1_000_000, // 1 hexUSDC at 6 decimals
  houseCutBps: 600, // 6%, the bootstrap default
  minJackpot: 0,
  // Strictly less than epochSeconds: set_params requires payout_timeout <
  // epoch_seconds (beta-launch-fixes ticket 03), so a pool bootstrapped here
  // has to satisfy that from the start or its very first set_params call
  // (even a no-op one, just testing who may call it) would refuse.
  payoutTimeout: 82_800,
  baseRateBps: 488, // spec §7: ~5% APY with daily compounding
  ticketsPerUsdc: 10,
  bonusCapBps: 500, // spec: default 5%
};

export interface PoolCtx {
  poolId: bigint;
  pool: PublicKey;
  mint: PublicKey;
  epochSeconds: number;
  epochAnchor: number;
  /** Signs set_params, unpause, set_operator and propose_admin. */
  admin: Keypair;
  /** Signs every crank, owns the House, funds the wallets, mints the asset. */
  operator: Keypair;
  treasury: PublicKey;
  buybackReserve: PublicKey;
  principalVault: PublicKey;
  jackpotVault: PublicKey;
  house: PublicKey;
  weightTree: PublicKey;
  /** Spread into any instruction that syncs. */
  venue: VenueAccounts;
  minDeposit: bigint;
  houseCutBps: number;
  baseRateBps: number;
  ticketsPerUsdc: number;
  bonusCapBps: number;
  /** A fresh funded keypair with `amount` hexUSDC already in its ATA. */
  fundedWallet(amount: bigint): Promise<{ keypair: Keypair; tokenAccount: PublicKey }>;
}

/**
 * Airdrops, mints a fresh hexUSDC mint, wires up treasury/buyback token
 * accounts, and calls `create_pool`. Admin and operator are two distinct
 * fresh keypairs (neither is the test wallet), so every role-gated
 * instruction can be tested with the right key and with the wrong one.
 */
export async function setupPool(overrides: PoolParamsOverrides = {}): Promise<PoolCtx> {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const poolId = nextPoolId();

  const admin = Keypair.generate();
  const operator = Keypair.generate();
  await airdrop(admin.publicKey, 10);
  await airdrop(operator.publicKey, 10);

  const mint = overrides.mint ?? (await createMint(connection, operator, operator.publicKey, null, 6));
  // Two independent token accounts, both owned by the operator. They must be
  // plain accounts with their own keypairs: `createAccount` without one
  // derives the ATA, and treasury and buyback_reserve share (mint, owner),
  // so the second call would land on the address the first already took.
  const treasury = await createAccount(
    connection,
    operator,
    mint,
    operator.publicKey,
    Keypair.generate(),
  );
  const buybackReserve = await createAccount(
    connection,
    operator,
    mint,
    operator.publicKey,
    Keypair.generate(),
  );

  const pool = poolPda(poolId);
  const principalVault = principalVaultPda(pool);
  const jackpotVault = jackpotVaultPda(pool);
  const house = playerPda(pool, operator.publicKey);
  const epochAnchor = overrides.epochAnchor ?? (await onChainNowSeconds());
  const weightTree = await weightTreeAccount(operator.publicKey);
  const venue = venueAccountsFor(pool);

  await program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(params.epochSeconds),
      epochAnchor: new BN(epochAnchor),
      roundSeconds: new BN(params.roundSeconds),
      closeBuffer: new BN(params.closeBuffer),
      vrfTimeout: new BN(params.vrfTimeout),
      minDeposit: new BN(params.minDeposit),
      houseCutBps: params.houseCutBps,
      minJackpot: new BN(params.minJackpot),
      payoutTimeout: new BN(params.payoutTimeout),
      baseRateBps: params.baseRateBps,
      ticketsPerUsdc: params.ticketsPerUsdc,
      bonusCapBps: params.bonusCapBps,
    })
    .accountsPartial({
      payer: operator.publicKey,
      pool,
      acceptedMint: mint,
      principalVault,
      jackpotVault,
      house,
      weightTree: weightTree.keypair.publicKey,
      treasury,
      buybackReserve,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([weightTree.ix])
    .signers([operator, weightTree.keypair])
    .rpc();

  // The stub venue's reserve and USDC vault, once per pool (test-venue).
  await program.methods
    .testVenueInit()
    .accountsPartial({
      payer: operator.publicKey,
      pool,
      acceptedMint: mint,
      reserve: venue.klendReserve,
      venueVault: venue.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([operator])
    .rpc();

  // A new pool starts with both the game and the jackpot paused (spec
  // "game-jackpot-pause"): the admin has to explicitly start each one. Every
  // suite's fixture starts both right here, right after create_pool, so the
  // rest of the tests see the pool the way they did before either switch
  // existed -- running from the moment `setupPool` returns.
  await program.methods
    .setFeaturePause({ game: {} }, false)
    .accountsPartial({ signer: admin.publicKey, pool })
    .signers([admin])
    .rpc();
  await program.methods
    .setFeaturePause({ jackpot: {} }, false)
    .accountsPartial({ signer: admin.publicKey, pool })
    .signers([admin])
    .rpc();

  async function fundedWallet(amount: bigint) {
    const keypair = Keypair.generate();
    await airdrop(keypair.publicKey, 5);
    const ata = await getOrCreateAssociatedTokenAccount(connection, operator, mint, keypair.publicKey);
    if (amount > 0n) {
      await mintTo(connection, operator, mint, ata.address, operator, amount);
    }
    return { keypair, tokenAccount: ata.address };
  }

  return {
    poolId,
    pool,
    mint,
    epochSeconds: params.epochSeconds,
    epochAnchor,
    admin,
    operator,
    treasury,
    buybackReserve,
    principalVault,
    jackpotVault,
    house,
    weightTree: weightTree.keypair.publicKey,
    venue,
    minDeposit: BigInt(params.minDeposit),
    houseCutBps: params.houseCutBps,
    baseRateBps: params.baseRateBps,
    ticketsPerUsdc: params.ticketsPerUsdc,
    bonusCapBps: params.bonusCapBps,
    fundedWallet,
  };
}

// --- Stub venue (test-venue) -------------------------------------------------

const big = (n: { toString(): string }): bigint => BigInt(n.toString());

/** Builder for `deploy_to_venue`; `.rpc()` it, or `.transaction()` it to pick
 *  the fee payer. `venue` overrides the pinned accounts for mismatch tests. */
export function deployMethod(ctx: PoolCtx, amount: bigint, venue: VenueAccounts = ctx.venue) {
  return program.methods.deployToVenue(new BN(amount.toString())).accountsPartial({
    pool: ctx.pool,
    principalVault: ctx.principalVault,
    acceptedMint: ctx.mint,
    ...venue,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

export function deployToVenue(ctx: PoolCtx, amount: bigint, venue: VenueAccounts = ctx.venue) {
  return deployMethod(ctx, amount, venue).rpc();
}

/** The stub's USDC-per-share rate scaled by 1e18, up or down. */
export function setVenueRate(ctx: PoolCtx, rate: bigint) {
  return program.methods
    .testSetVenueRate(new BN(rate.toString()))
    .accountsPartial({ pool: ctx.pool, reserve: ctx.venue.klendReserve });
}

/** Builder for `test_sync`: sync and nothing else. */
export function testSyncMethod(ctx: PoolCtx, venue: VenueAccounts = ctx.venue) {
  return program.methods.testSync().accountsPartial({ pool: ctx.pool, ...venue });
}

/** Blocks until the chain clock is past the pool's `last_sync_at`, so the next
 *  sync is not swallowed by the same-second no-op. */
export async function waitPastLastSync(ctx: PoolCtx): Promise<void> {
  const pool = await program.account.pool.fetch(ctx.pool);
  await sleepUntilOnChain(Number(pool.lastSyncAt.toString()) + 1);
}

/** The stub's live value, `floor(shares x rate / 1e18)`, in USDC atomic units. */
export async function stubVenueValue(ctx: PoolCtx): Promise<bigint> {
  const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
  return (big(reserve.shares) * big(reserve.rate)) / 10n ** 18n;
}

/**
 * The solvency invariant (spec "Solvency invariant"): principal vault balance
 * plus venue value covers every claim on it. Call after every instruction.
 */
export async function assertSolvent(ctx: PoolCtx): Promise<void> {
  const pool = await program.account.pool.fetch(ctx.pool);
  const vault = big(
    (await provider.connection.getTokenAccountBalance(ctx.principalVault)).value.amount,
  );
  const assets = vault + (await stubVenueValue(ctx));
  const claims =
    big(pool.totalPrincipal) +
    big(pool.pendingWithdrawals) +
    big(pool.yieldOwed) +
    big(pool.feeOwed) +
    big(pool.prizeOwed) -
    big(pool.deficit);
  if (assets < claims) {
    throw new Error(`insolvent: vault ${vault} + venue ${assets - vault} < claims ${claims}`);
  }
}

// --- Recall, harvest, treasury accounts (yield-claimer ticket 07) -------------

/** Builder for `recall`; permissionless, so there is no signer to name. */
export function recallMethod(ctx: PoolCtx, amount: bigint, venue: VenueAccounts = ctx.venue) {
  return program.methods.recall(new BN(amount.toString())).accountsPartial({
    pool: ctx.pool,
    principalVault: ctx.principalVault,
    acceptedMint: ctx.mint,
    ...venue,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

/** Builder for `harvest`. `treasury` overrides the pool's own for the
 *  wrong-destination test. */
export function harvestMethod(
  ctx: PoolCtx,
  treasury: PublicKey = ctx.treasury,
  venue: VenueAccounts = ctx.venue,
) {
  return program.methods.harvest().accountsPartial({
    pool: ctx.pool,
    principalVault: ctx.principalVault,
    jackpotVault: ctx.jackpotVault,
    treasury,
    acceptedMint: ctx.mint,
    ...venue,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

/** Builder for `set_treasury_accounts`, signed by `admin` unless told otherwise. */
export function setTreasuryAccountsMethod(
  ctx: PoolCtx,
  treasury: PublicKey,
  buybackReserve: PublicKey,
  admin: Keypair = ctx.admin,
) {
  return program.methods
    .setTreasuryAccounts()
    .accountsPartial({
      admin: admin.publicKey,
      pool: ctx.pool,
      acceptedMint: ctx.mint,
      treasury,
      buybackReserve,
    })
    .signers([admin]);
}
