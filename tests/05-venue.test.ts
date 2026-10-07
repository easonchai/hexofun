// Stub venue, deploy and sync (yield-claimer ticket 05; spec "Sync", "Venue
// module", "Solvency invariant"). Every pool here runs against the test-venue
// stub: `rate` is USDC per share scaled by 1e18, and a test moves it with
// `test_set_venue_rate`. `test_sync` runs sync and nothing else, because in
// this ticket only `deploy_to_venue` syncs.
//
// The depositor ceiling depends on the seconds between two syncs, so each
// gain test reads `last_sync_at` before and after from the Pool and works out
// the expected split in bigint from those two numbers.
//
// Amounts are 6-decimal USDC atomic units. The default minimum deploy is 100
// USDC and the idle target is 10%, so deposits are sized in the thousands.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  beginFirstEpoch,
  deployMethod,
  deployToVenue,
  findEvent,
  playerPda,
  refundAccounts,
  program,
  provider,
  setupPool,
  setVenueRate,
  stubVenueValue,
  testSyncMethod,
  waitPastLastSync,
  VENUE_KIND,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;
const USDC = 1_000_000n;
const SCALE = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const balance = async (account: Wallet["tokenAccount"]): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

async function deposit(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
  await assertSolvent(ctx);
}

async function requestWithdraw(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      ...ctx.venue,
      ...refundAccounts(ctx, owner),
    })
    .signers([owner.keypair])
    .rpc();
  await assertSolvent(ctx);
}

/** A pool with `amount` USDC deposited by one Player. */
async function fundedPool(amount: bigint, overrides: Parameters<typeof setupPool>[0] = {}) {
  const ctx = await setupPool(overrides);
  const owner = await ctx.fundedWallet(amount);
  await deposit(ctx, owner, amount);
  return { ctx, owner };
}

async function deploy(ctx: PoolCtx, amount: bigint) {
  await waitPastLastSync(ctx);
  const signature = await deployToVenue(ctx, amount);
  await assertSolvent(ctx);
  return signature;
}

async function setRate(ctx: PoolCtx, rate: bigint) {
  await setVenueRate(ctx, rate).rpc();
  await assertSolvent(ctx);
}

interface Owed {
  fee: bigint;
  yieldOwed: bigint;
  prize: bigint;
  index: bigint;
}

const owedOf = (pool: Awaited<ReturnType<typeof fetchPool>>): Owed => ({
  fee: big(pool.feeOwed),
  yieldOwed: big(pool.yieldOwed),
  prize: big(pool.prizeOwed),
  index: big(pool.yieldIndex),
});

/** The spec's split, worked out by hand: fee first, the rest capped at the
 *  depositor ceiling, whatever is left to the prize. */
function expectedSplit(
  gain: bigint,
  feeBps: bigint,
  principal: bigint,
  baseRateBps: bigint,
  elapsed: bigint,
) {
  const fee = (gain * feeBps) / 10_000n;
  const rest = gain - fee;
  const ceiling = (principal * baseRateBps * elapsed) / (10_000n * SECONDS_PER_YEAR);
  const depositor = principal === 0n ? 0n : rest < ceiling ? rest : ceiling;
  const indexDelta = principal === 0n ? 0n : (depositor * SCALE) / principal;
  return { fee, depositor, prize: rest - depositor, ceiling, rest, indexDelta };
}

/**
 * Runs `test_sync` after the rate has moved, and checks the Pool's owed
 * amounts and index against the split computed from the two `last_sync_at`
 * values and the stub's own value. Returns the split for case-specific checks.
 */
async function syncAndCheck(ctx: PoolCtx) {
  await waitPastLastSync(ctx);
  const before = await fetchPool(ctx);
  const valueNow = await stubVenueValue(ctx);
  await testSyncMethod(ctx).rpc();
  await assertSolvent(ctx);
  const after = await fetchPool(ctx);

  const elapsed = big(after.lastSyncAt) - big(before.lastSyncAt);
  expect(elapsed > 0n).toBe(true);
  const gain = valueNow - big(before.venueValue);
  expect(gain > 0n).toBe(true);
  const split = expectedSplit(
    gain,
    BigInt(before.yieldFeeBps),
    big(before.totalPrincipal),
    BigInt(before.baseRateBps),
    elapsed,
  );

  const was = owedOf(before);
  const now = owedOf(after);
  expect(now.fee).toBe(was.fee + split.fee);
  expect(now.yieldOwed).toBe(was.yieldOwed + split.depositor);
  expect(now.prize).toBe(was.prize + split.prize);
  expect(now.index).toBe(was.index + split.indexDelta);
  expect(big(after.venueValue)).toBe(valueNow);
  expect(split.fee + split.depositor + split.prize).toBe(gain);
  return split;
}

describe("pinned venue accounts", () => {
  it(
    "create_pool pins the four addresses and the default venue parameters",
    async () => {
      const ctx = await setupPool();
      const pool = await fetchPool(ctx);

      expect(pool.klendProgram.toBase58()).toBe(ctx.venue.klendProgram.toBase58());
      expect(pool.klendMarket.toBase58()).toBe(ctx.venue.klendMarket.toBase58());
      expect(pool.klendReserve.toBase58()).toBe(ctx.venue.klendReserve.toBase58());
      expect(pool.klendCtoken.toBase58()).toBe(ctx.venue.klendCtoken.toBase58());
      expect(pool.venueKind).toBe(VENUE_KIND.stub);

      expect(pool.yieldFeeBps).toBe(1_000);
      expect(pool.idleFloorBps).toBe(500);
      expect(pool.idleTargetBps).toBe(1_000);
      expect(pool.minVenueMove.toString()).toBe("100000000");
      expect(pool.lossToleranceBps).toBe(1);
      expect(pool.deficit.toString()).toBe("0");
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "deploy_to_venue and test_sync refuse a reserve, cToken account, market or program that is not the pinned one",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      // A second, fully valid pool supplies real accounts that are simply not
      // this pool's.
      const other = await setupPool();
      const wrongs = {
        klendReserve: other.venue.klendReserve,
        klendCtoken: other.venue.klendCtoken,
        klendMarket: other.pool,
        klendProgram: SystemProgram.programId,
      };

      await waitPastLastSync(ctx);
      for (const [name, wrong] of Object.entries(wrongs)) {
        const venue = { ...ctx.venue, [name]: wrong };
        await expect(deployToVenue(ctx, 200n * USDC, venue), `deploy ${name}`).rejects.toThrow(
          /VenueMismatch/,
        );
        await expect(testSyncMethod(ctx, venue).rpc(), `sync ${name}`).rejects.toThrow(
          /VenueMismatch/,
        );
      }
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("0");
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );
});

describe("deploy_to_venue", () => {
  it(
    "is permissionless and moves USDC from the principal vault to the stub vault",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      const stranger = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(stranger.publicKey, 1_000_000_000);
      await provider.connection.confirmTransaction(sig, "confirmed");

      await waitPastLastSync(ctx);
      // No signer account on the instruction: a fresh wallet just pays the fee.
      const ix = await deployMethod(ctx, 500n * USDC).instruction();
      const signature = await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(ix),
        [stranger],
        { commitment: "confirmed" },
      );
      await assertSolvent(ctx);

      expect(await balance(ctx.principalVault)).toBe(500n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(500n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe((500n * USDC).toString());
      expect(pool.totalPrincipal.toString()).toBe((1_000n * USDC).toString());
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((500n * USDC).toString());

      const event = await findEvent<{ amount: BN; venueValue: BN }>(signature, "venueDeployed");
      expect(event?.amount.toString()).toBe((500n * USDC).toString());
      expect(event?.venueValue.toString()).toBe((500n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "refuses an amount under the minimum size and one past the idle target, and takes the largest allowed",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await waitPastLastSync(ctx);

      await expect(deployToVenue(ctx, 100n * USDC - 1n)).rejects.toThrow(/VenueMoveTooSmall/);
      // 10% of 1,000 USDC stays idle, so 900 is the most that can leave.
      await expect(deployToVenue(ctx, 900n * USDC + 1n)).rejects.toThrow(/DeployExceedsIdle/);
      await assertSolvent(ctx);
      expect(await balance(ctx.principalVault)).toBe(1_000n * USDC);

      await deploy(ctx, 900n * USDC);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(900n * USDC);

      // The target now covers the whole pool (100 idle + 900 deployed), so
      // nothing more may go.
      await expect(deployToVenue(ctx, 100n * USDC)).rejects.toThrow(/DeployExceedsIdle/);
    },
    TIMEOUT,
  );

  it(
    "leaves a Pending withdrawal out of free idle",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC);
      await beginFirstEpoch(ctx); // the deposit is active, so a request queues
      // 400 is queued: the vault still holds 1,000, but only 600 of it is
      // free, so the target is 60 and 540 may go (900 with no withdrawal
      // queued).
      await requestWithdraw(ctx, owner, 400n * USDC);
      await waitPastLastSync(ctx);

      await expect(deployToVenue(ctx, 540n * USDC + 1n)).rejects.toThrow(/DeployExceedsIdle/);
      await deploy(ctx, 540n * USDC);

      expect(await balance(ctx.principalVault)).toBe(460n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.pendingWithdrawals.toString()).toBe((400n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "does not register as a gain at the next sync",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 500n * USDC);
      const before = await fetchPool(ctx);

      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);

      const after = await fetchPool(ctx);
      expect(big(after.lastSyncAt) > big(before.lastSyncAt)).toBe(true);
      expect(owedOf(after)).toEqual(owedOf(before));
      expect(owedOf(after)).toEqual({ fee: 0n, yieldOwed: 0n, prize: 0n, index: 0n });
      expect(after.venueValue.toString()).toBe(before.venueValue.toString());
    },
    TIMEOUT,
  );
});

describe("sync", () => {
  it(
    "splits a gain into fee, depositor share up to the ceiling, and prize share (ceiling binds)",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 500n * USDC);

      // 500 shares at 1.2 is 600 USDC: a 100 USDC gain over a few seconds,
      // against a ceiling of 488 bps a year on 1,000 USDC.
      await setRate(ctx, 12n * 10n ** 17n);
      const split = await syncAndCheck(ctx);

      expect(split.fee).toBe(10n * USDC);
      expect(split.rest > split.ceiling).toBe(true);
      expect(split.depositor).toBe(split.ceiling);
      expect(split.prize).toBe(split.rest - split.ceiling);
      expect(split.indexDelta > 0n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "gives the depositors the whole remainder when the ceiling does not bind",
    async () => {
      // A 100% APR ceiling on 1,000 USDC lets at least 31 atomic units
      // through per second, and the gain below is 20 whatever the gap.
      const { ctx } = await fundedPool(1_000n * USDC, { baseRateBps: 10_000 });
      await deploy(ctx, 500n * USDC);

      // 500 USDC of shares x 4e-8 = 20 atomic units of gain.
      await setRate(ctx, SCALE + 40_000_000_000n);
      const split = await syncAndCheck(ctx);

      expect(split.fee).toBe(2n);
      expect(split.rest < split.ceiling).toBe(true);
      expect(split.depositor).toBe(18n);
      expect(split.prize).toBe(0n);
      expect(split.indexDelta).toBe((18n * SCALE) / (1_000n * USDC));
    },
    TIMEOUT,
  );

  it(
    "sends the whole gain after the fee to the prize share when Principal is zero",
    async () => {
      // Setup choice: mint USDC straight into the principal vault, with no
      // deposit, so `total_principal` stays 0 and the vault still has idle
      // USDC to deploy. Cheaper and less fragile than a deposit, a deploy and
      // a queued withdrawal back out.
      const ctx = await setupPool();
      await mintTo(
        provider.connection,
        ctx.operator,
        ctx.mint,
        ctx.principalVault,
        ctx.operator,
        1_000n * USDC,
      );
      await assertSolvent(ctx);
      await deploy(ctx, 500n * USDC);

      await setRate(ctx, 12n * 10n ** 17n);
      const split = await syncAndCheck(ctx);

      expect(split.depositor).toBe(0n);
      expect(split.fee).toBe(10n * USDC);
      expect(split.prize).toBe(90n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.yieldOwed.toString()).toBe("0");
      expect(pool.yieldIndex.toString()).toBe("0");
      expect(pool.totalPrincipal.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "a second sync in the same second changes nothing",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 500n * USDC);
      await waitPastLastSync(ctx);
      const before = await fetchPool(ctx);
      const valueBefore = big(before.venueValue);

      // One transaction, so both syncs see one timestamp. The rate moves
      // between them: if the second sync ran it would book the second gain.
      const gainFirst = 50n * USDC;
      const rateFirst = SCALE + (gainFirst * SCALE) / (500n * USDC);
      const sync = await testSyncMethod(ctx).instruction();
      const move = async (rate: bigint) => setVenueRate(ctx, rate).instruction();
      const tx = new Transaction().add(
        await move(rateFirst),
        sync,
        await move(rateFirst * 2n - SCALE),
        sync,
      );
      await provider.sendAndConfirm(tx);
      await assertSolvent(ctx);

      const after = await fetchPool(ctx);
      const elapsed = big(after.lastSyncAt) - big(before.lastSyncAt);
      const split = expectedSplit(
        gainFirst,
        BigInt(before.yieldFeeBps),
        big(before.totalPrincipal),
        BigInt(before.baseRateBps),
        elapsed,
      );
      expect(big(after.venueValue)).toBe(valueBefore + gainFirst);
      expect(owedOf(after)).toEqual({
        fee: split.fee,
        yieldOwed: split.depositor,
        prize: split.prize,
        index: split.indexDelta,
      });

      // The second rate is still pending: the next second's sync books it.
      await syncAndCheck(ctx);
    },
    TIMEOUT,
  );
});
