// Shared plumbing every localnet suite needs: the provider/program, PDA
// derivers, and account bootstrap. Test files call
// `program.methods.x().accounts({...}).rpc()` directly instead of going
// through a per-instruction wrapper.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AccountMeta,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
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
import { buildSumTree, type SumTree } from "../../apps/backend/src/snapshot/sum-tree.js";

const secret = Uint8Array.from(
  JSON.parse(readFileSync(process.env.ANCHOR_WALLET as string, "utf8")),
);
export const connection = new Connection(process.env.ANCHOR_PROVIDER_URL as string, "confirmed");

export const provider = new AnchorProvider(connection, new Wallet(Keypair.fromSecretKey(secret)), {
  commitment: "confirmed",
});

export const program = new Program(idl as typeof idl, provider);
export const PROGRAM_ID = program.programId;

/** The program's upgradeable-loader data account, which `create_pool` reads
 *  for the upgrade authority (mainnet-readiness 06). */
export const PROGRAM_DATA = PublicKey.findProgramAddressSync(
  [PROGRAM_ID.toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
)[0];

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

export function principalVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("principal"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function jackpotVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot"), pool.toBuffer()], PROGRAM_ID)[0];
}

/** The pool's venue proposal PDA (`propose_venue`); it exists only while a
 *  venue change is open. */
export function venueProposalPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("venue_proposal"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
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

/** The second stub venue (`test_venue_init_alt`): another reserve and vault,
 *  for a stub-to-stub migration (venue-switch ticket 05). */
export function testVenueAltAccountsFor(pool: PublicKey, mint: PublicKey): VenueAccounts {
  const pda = (seed: string) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), pool.toBuffer()], PROGRAM_ID)[0];
  return {
    klendProgram: PROGRAM_ID,
    // Any account the stub never reads; the mint makes the market pin differ
    // from the first venue's too.
    klendMarket: mint,
    klendReserve: pda("test-venue-reserve-alt"),
    klendCtoken: pda("test-venue-vault-alt"),
  };
}

/** The four addresses `create_pool` pins and every syncing instruction is
 *  handed. Under test-venue: this program, the pool, and the stub's two PDAs. */
export interface VenueAccounts {
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
}

/** `Pool.venue_kind` values (`constants::venue_kind`). Fixtures run the stub. */
export const VENUE_KIND = { klend: 0, stub: 1, kvault: 2, unsupported: 3 } as const;

export function venueAccountsFor(pool: PublicKey): VenueAccounts {
  return {
    klendProgram: PROGRAM_ID,
    klendMarket: pool,
    klendReserve: testVenueReservePda(pool),
    klendCtoken: testVenueVaultPda(pool),
  };
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
 * address, which `draw` expects to be handed.
 *
 * Read the seed off the Epoch (`epoch.vrfSeed`) rather than recomputing it
 * here: the program is the authority on it.
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

// --- The program's reduction of 64 randomness bytes (ADR 0019) --------------
//
// `vrf::unbiased_u64` hashes all 64 bytes with SHA-256 and
// sample the digest, so a test can no longer write the outcome into the first
// bytes. It searches instead for randomness that reduces to the outcome it
// wants. This mirrors `vrf.rs` line for line, tail re-derivation included.

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

function rederive(base: Buffer, counter: number): Buffer {
  return sha256(Buffer.concat([base, Buffer.from([counter])]));
}

function leBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i] as number);
  return n;
}

/** `vrf::unbiased_u64`. */
export function unbiasedU64(randomness: Uint8Array, range: bigint): bigint {
  const max = (1n << 64n) - 1n;
  const limit = max - (max % range);
  const base = sha256(randomness);
  for (let counter = 0; counter < 256; counter += 1) {
    const digest = counter === 0 ? base : rederive(base, counter);
    const sample = leBig(digest.subarray(0, 8));
    if (sample < limit) return sample % range;
  }
  throw new Error("randomness rejected");
}

function randomnessCandidate(n: number): Uint8Array {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n), true);
  return bytes;
}

/** 64 randomness bytes whose draw target under `total` lies in `[lo, hi)`. */
export function randomnessForTarget(total: bigint, lo: bigint, hi: bigint): Uint8Array {
  for (let n = 0; n < 100_000; n += 1) {
    const candidate = randomnessCandidate(n);
    const target = unbiasedU64(candidate, total);
    if (target >= lo && target < hi) return candidate;
  }
  throw new Error(`no randomness found for a target in [${lo}, ${hi})`);
}

// --- epoch_seed(pool, epoch, nonce, root, total) ------------------------------
//
// `request_draw` mixes the nonce, the snapshot root and the Ticket total into the
// seed (ADR 0025), so a test derives the same seed client-side to know which
// randomness account to pass.

/** `utils::epoch_seed`: sha256("epoch" || pool || epoch_id_le || nonce || root || total_le). */
export function vrfSeed(
  pool: PublicKey,
  id: bigint,
  nonce: Uint8Array,
  root: Uint8Array,
  total: bigint,
): Uint8Array {
  return sha256(
    Buffer.concat([
      Buffer.from("epoch"),
      pool.toBuffer(),
      u64le(id),
      Buffer.from(nonce),
      Buffer.from(root),
      u64le(total),
    ]),
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

/** The Clock sysvar's unix_timestamp, what the program reads (not `Date.now()`,
 * which drifts a few seconds from it). Not `getBlockTime`: on a Surfpool fork
 * it stays at the pre-warp time after a `surfnet_timeTravel`. */
export async function onChainNowSeconds(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("no Clock sysvar");
  // slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp
  return Number(info.data.readBigInt64LE(32));
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

export async function airdrop(to: PublicKey, sol: number): Promise<void> {
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
  vrfTimeout?: number;
  minDeposit?: number;
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
  /** Reuse an existing mint instead of creating a fresh one (e.g. to test
   * two pools sharing an accepted asset). The caller must not rely on this
   * pool's operator being the mint authority when a shared mint is passed. */
  mint?: PublicKey;
}

// Spec §7 defaults.
export const DEFAULT_PARAMS = {
  epochSeconds: 86_400,
  vrfTimeout: 120,
  minDeposit: 1_000_000, // 1 hexUSDC at 6 decimals
  minJackpot: 0,
  // Strictly less than epochSeconds: set_params requires payout_timeout <
  // epoch_seconds (beta-launch-fixes ticket 03), so a pool bootstrapped here
  // has to satisfy that from the start or its very first set_params call
  // (even a no-op one, just testing who may call it) would refuse.
  payoutTimeout: 82_800,
  baseRateBps: 488, // spec §7: ~5% APY with daily compounding
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
  /** Spread into any instruction that syncs. */
  venue: VenueAccounts;
  minDeposit: bigint;
  baseRateBps: number;
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
  // create_pool wants payout_timeout < epoch_seconds, so a short-epoch test
  // that does not name one gets the longest timeout that fits.
  params.payoutTimeout = overrides.payoutTimeout ?? Math.min(DEFAULT_PARAMS.payoutTimeout, params.epochSeconds - 1);
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
  const venue = venueAccountsFor(pool);

  await program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(params.epochSeconds),
      epochAnchor: new BN(epochAnchor),
      vrfTimeout: new BN(params.vrfTimeout),
      minDeposit: new BN(params.minDeposit),
      minJackpot: new BN(params.minJackpot),
      payoutTimeout: new BN(params.payoutTimeout),
      baseRateBps: params.baseRateBps,
      venueKind: VENUE_KIND.stub,
    })
    .accountsPartial({
      // The deploy wallet is the upgrade authority, so it pays and signs.
      payer: provider.wallet.publicKey,
      programData: PROGRAM_DATA,
      pool,
      acceptedMint: mint,
      principalVault,
      jackpotVault,
      house,
      treasury,
      buybackReserve,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
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
  // rest of the tests see the pool running from the moment `setupPool`
  // returns. The program reads only the jackpot switch; the game switch is
  // the backend's.
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
    venue,
    minDeposit: BigInt(params.minDeposit),
    baseRateBps: params.baseRateBps,
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
    venueProposal: venueProposalPda(ctx.pool),
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

/**
 * The first `begin_epoch`, which has no epoch end to wait for. A deposit made in
 * epoch 0 is active Principal once epoch 1 has begun (ADR 0020), so a suite that
 * needs a queued withdrawal deposits, calls this, and then requests. In epoch 0
 * every deposit is a pending deposit, and a request refunds it.
 */
export function beginFirstEpoch(ctx: PoolCtx) {
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: ctx.operator.publicKey,
      pool: ctx.pool,
      currentEpoch: epochPda(ctx.pool, 0n),
      epochTwoBehind: epochPda(ctx.pool, 0n),
      newEpoch: epochPda(ctx.pool, 1n),
      ...ctx.venue,
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.operator])
    .rpc();
}

/** The accounts `request_withdraw` takes beyond the signer, the pool, the Player
 *  and the venue: the vault and the owner's USDC account, for a pending refund. */
export function refundAccounts(ctx: PoolCtx, owner: { tokenAccount: PublicKey }) {
  return {
    acceptedMint: ctx.mint,
    ownerToken: owner.tokenAccount,
    principalVault: ctx.principalVault,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
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
export async function assertSolvent(ctx: PoolCtx, dust = 0n): Promise<void> {
  const pool = await program.account.pool.fetch(ctx.pool);
  const vault = big(
    (await provider.connection.getTokenAccountBalance(ctx.principalVault)).value.amount,
  );
  const assets = vault + (await stubVenueValue(ctx));
  // A queued withdrawal stays inside `totalPrincipal` until it pays, so
  // `pendingWithdrawals` is not added beside it (ADR 0020).
  const claims =
    big(pool.totalPrincipal) +
    big(pool.yieldOwed) +
    big(pool.feeOwed) +
    big(pool.prizeOwed) -
    big(pool.deficit);
  if (assets + dust < claims) {
    throw new Error(`insolvent: vault ${vault} + venue ${assets - vault} < claims ${claims}`);
  }
}

// --- Venue loss and safety switches (yield-claimer ticket 10) ------------------

/** Builder for `set_deploy_pause`. Signed by `signer`, the Admin unless told
 *  otherwise. */
export function setDeployPauseMethod(ctx: PoolCtx, paused: boolean, signer: Keypair = ctx.admin) {
  return program.methods
    .setDeployPause(paused)
    .accountsPartial({ signer: signer.publicKey, pool: ctx.pool })
    .signers([signer]);
}

/** Builder for `cover_deficit`, paid by `payer` out of `payerToken`. */
export function coverDeficitMethod(
  ctx: PoolCtx,
  amount: bigint,
  payer: Keypair,
  payerToken: PublicKey,
  venue: VenueAccounts = ctx.venue,
) {
  return program.methods
    .coverDeficit(new BN(amount.toString()))
    .accountsPartial({
      payer: payer.publicKey,
      pool: ctx.pool,
      principalVault: ctx.principalVault,
      acceptedMint: ctx.mint,
      payerToken,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer]);
}

/** Every field optional: `set_venue_params` changes only what is named. */
export interface VenueParamsArgs {
  yieldFeeBps?: number;
  idleFloorBps?: number;
  idleTargetBps?: number;
  reserveShareCapBps?: number;
  reserveLiquidityFloorBps?: number;
  minVenueMove?: bigint;
  lossToleranceBps?: number;
}

/** Builder for `set_venue_params`, signed by `signer`, the Admin by default. */
export function setVenueParamsMethod(
  ctx: PoolCtx,
  params: VenueParamsArgs,
  signer: Keypair = ctx.admin,
) {
  return program.methods
    .setVenueParams({
      yieldFeeBps: params.yieldFeeBps ?? null,
      idleFloorBps: params.idleFloorBps ?? null,
      idleTargetBps: params.idleTargetBps ?? null,
      reserveShareCapBps: params.reserveShareCapBps ?? null,
      reserveLiquidityFloorBps: params.reserveLiquidityFloorBps ?? null,
      minVenueMove: params.minVenueMove === undefined ? null : new BN(params.minVenueMove.toString()),
      lossToleranceBps: params.lossToleranceBps ?? null,
    })
    .accountsPartial({ admin: signer.publicKey, pool: ctx.pool })
    .signers([signer]);
}

/** What the stub reports to the deploy caps as the reserve's supply and free
 *  liquidity. Both start at u64::MAX, so no cap binds. */
export function setReserveStats(ctx: PoolCtx, supply: bigint, available: bigint) {
  return program.methods
    .testSetReserveStats(new BN(supply.toString()), new BN(available.toString()))
    .accountsPartial({ pool: ctx.pool, reserve: ctx.venue.klendReserve });
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

/** Builder for `drain_venue` (venue-switch ticket 04). Signed by `signer`, the
 *  Admin unless told otherwise. */
export function drainVenueMethod(
  ctx: PoolCtx,
  amount: bigint,
  signer: Keypair = ctx.admin,
  venue: VenueAccounts = ctx.venue,
) {
  return program.methods
    .drainVenue(new BN(amount.toString()))
    .accountsPartial({
      signer: signer.publicKey,
      pool: ctx.pool,
      principalVault: ctx.principalVault,
      acceptedMint: ctx.mint,
      ...venue,
      venueProposal: venueProposalPda(ctx.pool),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer]);
}

/** Builder for `migrate_venue` (venue-switch ticket 05). Permissionless, so no
 *  signer; `venue` is the OLD venue, the one the pool is pinned to until it runs. */
export function migrateVenueMethod(
  ctx: PoolCtx,
  venue: VenueAccounts = ctx.venue,
  admin: PublicKey = ctx.admin.publicKey,
) {
  return program.methods.migrateVenue().accountsPartial({
    pool: ctx.pool,
    admin,
    proposal: venueProposalPda(ctx.pool),
    ...venue,
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

// --- The epoch draw (off-chain-tickets tickets 08 and 09) -----------------------
//
// Tickets live in the backend, so a test that draws keeps its own list of who
// holds what, builds the Merkle sum tree the backend would (the same builder),
// and hands `request_draw` its root, total and shape and `payout` a proof.

export interface Holding {
  owner: PublicKey;
  tickets: bigint;
}

/** What `request_draw` commits, with the tree behind it. */
export interface Snapshot {
  /** The holders sorted by wallet bytes, so a leaf's index is its position here. */
  held: Holding[];
  tree: SumTree | undefined;
  root: Buffer;
  total: bigint;
  depth: number;
  leafCount: number;
}

/** A wallet that is no Player: holds the Tickets of a draw nobody is paid for. */
export const FILLER = new PublicKey(Buffer.alloc(32, 0xfe));

/** The snapshot the backend would build over `held`. No holders commit zeros,
 *  which `request_draw` rolls over. */
export function snapshotOf(held: Holding[]): Snapshot {
  const sorted = [...held].sort((a, b) => Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()));
  if (sorted.length === 0) {
    return { held: sorted, tree: undefined, root: Buffer.alloc(32), total: 0n, depth: 0, leafCount: 0 };
  }
  const tree = buildSumTree(sorted.map((h) => ({ wallet: h.owner.toBuffer(), tickets: h.tickets })));
  return { held: sorted, tree, root: tree.root, total: tree.total, depth: tree.depth, leafCount: tree.leafCount };
}

/**
 * The Ticket total of `held` and 64 randomness bytes whose draw target falls in
 * `winner`'s range, with the holders laid out in leaf order (by wallet bytes).
 */
export function randomnessLanding(
  held: Holding[],
  winner: PublicKey,
): { total: bigint; randomness: Uint8Array } {
  let lo = 0n;
  let range: [bigint, bigint] | undefined;
  for (const { owner, tickets } of snapshotOf(held).held) {
    if (owner.equals(winner)) range = [lo, lo + tickets];
    lo += tickets;
  }
  if (!range) throw new Error(`${winner.toBase58()} holds nothing in this draw`);
  return { total: lo, randomness: randomnessForTarget(lo, range[0], range[1]) };
}

export interface DrawArgs {
  nonce: Uint8Array;
  root: Uint8Array;
  total: bigint;
  depth: number;
  leafCount: number;
}

/** Builder for `request_draw` with every argument spelled out, so a test can
 *  commit a bad shape. The seed (and so the randomness address) is read back
 *  off the Epoch account once this succeeds. */
export function requestDrawRaw(
  ctx: PoolCtx,
  epochId: bigint,
  a: DrawArgs,
  randomness?: PublicKey,
) {
  const seed = vrfSeed(ctx.pool, epochId, a.nonce, a.root, a.total);
  return program.methods
    .requestDraw(
      Array.from(a.nonce),
      Array.from(a.root),
      new BN(a.total.toString()),
      a.depth,
      a.leafCount,
    )
    .accountsPartial({
      operator: ctx.operator.publicKey,
      pool: ctx.pool,
      epoch: epochPda(ctx.pool, epochId),
      jackpotVault: ctx.jackpotVault,
      randomness: randomness ?? randomnessPda(seed),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"),
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.operator]);
}

/** Builder for `request_draw` over `draw`: the holders, or a bare Ticket total
 *  held by a `FILLER` wallet for a draw nobody is paid in. 0n rolls over. */
export function requestDrawMethod(
  ctx: PoolCtx,
  epochId: bigint,
  draw: bigint | Holding[],
  nonce: Uint8Array = testNonce(),
  randomness?: PublicKey,
) {
  const held = typeof draw === "bigint" ? (draw > 0n ? [{ owner: FILLER, tickets: draw }] : []) : draw;
  const s = snapshotOf(held);
  return requestDrawRaw(ctx, epochId, { nonce, ...s }, randomness);
}

export interface PayoutProof {
  index: number;
  tickets: bigint;
  siblings: { hash: Uint8Array; sum: bigint }[];
}

/** The proof the API would serve for `owner`'s leaf. */
export function proofFor(s: Snapshot, owner: PublicKey): PayoutProof {
  const index = s.held.findIndex((h) => h.owner.equals(owner));
  if (index < 0 || !s.tree) throw new Error(`${owner.toBase58()} holds nothing in this snapshot`);
  return { index, tickets: (s.held[index] as Holding).tickets, siblings: s.tree.proof(index) };
}

/** Builder for `payout` with the proof spelled out, so a test can break it.
 *  Permissionless: `caller` only pays the fee (the Operator unless told). */
export function payoutRaw(
  ctx: PoolCtx,
  epochId: bigint,
  winner: PublicKey,
  proof: PayoutProof,
  caller: Keypair = ctx.operator,
  remaining: AccountMeta[] = [],
) {
  return program.methods
    .payout(
      proof.index,
      new BN(proof.tickets.toString()),
      proof.siblings.map((s) => ({ hash: Array.from(s.hash), sum: new BN(s.sum.toString()) })),
    )
    .accountsPartial({
      caller: caller.publicKey,
      pool: ctx.pool,
      acceptedMint: ctx.mint,
      epoch: epochPda(ctx.pool, epochId),
      winner: playerPda(ctx.pool, winner),
      jackpotVault: ctx.jackpotVault,
      principalVault: ctx.principalVault,
      treasury: ctx.treasury,
      buybackReserve: ctx.buybackReserve,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remaining)
    .signers([caller]);
}

/** Builder for `payout` of the draw `request_draw` committed over `held`. */
export function payoutMethod(
  ctx: PoolCtx,
  epochId: bigint,
  winner: PublicKey,
  held: Holding[],
  caller: Keypair = ctx.operator,
) {
  return payoutRaw(ctx, epochId, winner, proofFor(snapshotOf(held), winner), caller);
}

/** On-chain unix time and compute units of one confirmed transaction. */
export async function txInfo(signature: string): Promise<{ time: bigint; units: number }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tx = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.blockTime != null) {
      return { time: BigInt(tx.blockTime), units: tx.meta?.computeUnitsConsumed ?? 0 };
    }
    await sleep(250);
  }
  throw new Error(`transaction ${signature} never reported a block time`);
}
