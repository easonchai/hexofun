// Depositors earn through the Yield index (yield-claimer ticket 06; spec
// "Settle", "Instructions that change"). Deposit, request withdraw and
// emergency withdraw each run sync, then settle, before their own work.
// `payout` does too, but it refuses every winner until ticket 08's tree, so
// it has no integration test here; `sync::settle` itself is unit-tested.
//
// Every pool runs against the test-venue stub, which only earns on USDC that
// was deployed. Gains are made exact: a rate step of 2e10 on S shares is
// S x 2e10 / 1e18 USDC atomic units, so the expected index rise is worked out
// in bigint from the fee rate (default 1,000 bps) and the Principal at the
// time the gain is booked.
//
// The depositor ceiling is total_principal x base_rate x seconds since the
// last sync. These pools hold 1e12 atomic units (1M USDC) at 100% APR, a
// ceiling of 31,709 units per second, and every gain below pays depositors at
// most 32,400, so the ceiling never binds and the split is exact whatever the
// gap between syncs. The one test that needs the ceiling to bind says so.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { SystemProgram } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  deployToVenue,
  epochPda,
  findEvent,
  playerPda,
  program,
  provider,
  retryUntilOk,
  setupPool,
  setVenueRate,
  sleepUntilOnChain,
  stubVenueValue,
  testSyncMethod,
  waitPastLastSync,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 120_000;
const SCALE = 10n ** 18n;
/** 1,000,000 USDC in atomic units. */
const MILLION = 10n ** 12n;
/** Default yield fee: 1,000 bps. */
const FEE_BPS = 1_000n;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const fetchPlayer = (ctx: PoolCtx, w: Wallet) =>
  program.account.player.fetch(playerPda(ctx.pool, w.keypair.publicKey));
const balance = async (account: Wallet["tokenAccount"]): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

/** The stub earns 100% APR ceilings so the split below is exact. */
const newPool = (overrides: Parameters<typeof setupPool>[0] = {}) =>
  setupPool({ baseRateBps: 10_000, ...overrides });

function depositMethod(ctx: PoolCtx, owner: Wallet, amount: bigint, venue = ctx.venue) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair]);
}

/** Waits past the last sync first, so this deposit's sync is not swallowed by
 *  the same-second no-op and books any gain made since. */
async function deposit(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await waitPastLastSync(ctx);
  const signature = await depositMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
  return signature;
}

function requestWithdrawMethod(ctx: PoolCtx, owner: Wallet, amount: bigint, venue = ctx.venue) {
  return program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      ...venue,
    })
    .signers([owner.keypair]);
}

async function requestWithdraw(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await waitPastLastSync(ctx);
  await requestWithdrawMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
}

async function deploy(ctx: PoolCtx, amount: bigint) {
  await waitPastLastSync(ctx);
  await deployToVenue(ctx, amount);
  await assertSolvent(ctx);
}

/** Raises the stub's rate by `delta` (scaled 1e18) and returns the gain in
 *  atomic units, read from the stub's own value before and after. */
async function bump(ctx: PoolCtx, delta: bigint): Promise<bigint> {
  const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
  const before = await stubVenueValue(ctx);
  await setVenueRate(ctx, big(reserve.rate) + delta).rpc();
  const gain = (await stubVenueValue(ctx)) - before;
  await assertSolvent(ctx);
  return gain;
}

/** Fee first, the rest to depositors (the ceiling does not bind here). */
const depositorShare = (gain: bigint) => gain - (gain * FEE_BPS) / 10_000n;
const indexRise = (depositor: bigint, totalPrincipal: bigint) => (depositor * SCALE) / totalPrincipal;
const owedFor = (principal: bigint, rise: bigint) => (principal * rise) / SCALE;

/** One Player with `amount` deposited and 90% of it deployed, then a gain of
 *  18,000 atomic units on the 9e11 shares that deploy buys at rate 1. */
async function earningPool(amount = MILLION) {
  const ctx = await newPool();
  const a = await ctx.fundedWallet(amount * 3n);
  await deposit(ctx, a, amount);
  await deploy(ctx, (amount * 9n) / 10n);
  const gain = await bump(ctx, 2n * 10n ** 10n);
  return { ctx, a, gain };
}

describe("settle through deposit, request withdraw and emergency withdraw", () => {
  it(
    "a late depositor gets none of an earlier gain, and the early one gets all of it",
    async () => {
      const { ctx, a, gain } = await earningPool();
      expect(gain).toBe(18_000n);
      const depositor = depositorShare(gain);
      expect(depositor).toBe(16_200n);
      const b = await ctx.fundedWallet(MILLION * 3n);

      // B's deposit syncs first, so the gain lands in the index at 1M total
      // Principal, and B is then stamped at that index.
      await deposit(ctx, b, MILLION);
      const rise = indexRise(depositor, MILLION);
      expect(rise).toBe(16_200_000_000n);
      let pool = await fetchPool(ctx);
      expect(big(pool.yieldIndex)).toBe(rise);
      expect(big(pool.yieldOwed)).toBe(depositor);
      expect(big(pool.feeOwed)).toBe(gain - depositor);
      let player = await fetchPlayer(ctx, b);
      expect(big(player.yieldIndex)).toBe(rise);
      expect(big(player.principal)).toBe(MILLION);

      // B touches the pool again: nothing to settle, nothing earned.
      await deposit(ctx, b, 1_000_000n);
      player = await fetchPlayer(ctx, b);
      expect(big(player.principal)).toBe(MILLION + 1_000_000n);
      expect(big(player.entries)).toBe(MILLION + 1_000_000n);
      expect(big((await fetchPool(ctx)).yieldOwed)).toBe(depositor);

      // A settles all of it.
      await deposit(ctx, a, 1_000_000n);
      player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(MILLION + depositor + 1_000_000n);
      pool = await fetchPool(ctx);
      expect(big(pool.yieldOwed)).toBe(0n);
      expect(big(player.yieldIndex)).toBe(big(pool.yieldIndex));
    },
    TIMEOUT,
  );

  it(
    "two depositors earn in proportion to Principal and time held",
    async () => {
      // A holds 600k USDC from the start. B arrives with 400k after the first
      // gain. A second gain, equal to the first, then splits 60:40.
      const ctx = await newPool();
      const a = await ctx.fundedWallet(MILLION);
      const b = await ctx.fundedWallet(MILLION);
      const aStake = 6n * 10n ** 11n;
      const bStake = 4n * 10n ** 11n;
      await deposit(ctx, a, aStake);
      await deploy(ctx, 54n * 10n ** 10n); // 540k, leaving the 10% idle target
      const gain1 = await bump(ctx, 2n * 10n ** 10n);
      expect(gain1).toBe(10_800n); // 5.4e11 shares x 2e10 / 1e18

      await deposit(ctx, b, bStake);
      const gain2 = await bump(ctx, 2n * 10n ** 10n);
      expect(gain2).toBe(10_800n);

      // Settle both with a dust deposit. The first one books gain 2 at 1M
      // total Principal, before either Player has settled.
      const dust = 1_000_000n;
      await deposit(ctx, a, dust);
      await deposit(ctx, b, dust);

      const rise1 = indexRise(depositorShare(gain1), aStake); // A alone
      const rise2 = indexRise(depositorShare(gain2), aStake + bStake);
      const aOwed = owedFor(aStake, rise1 + rise2);
      const bOwed = owedFor(bStake, rise2);
      expect(aOwed).toBe(15_552n); // 9,720 + 60% of 9,720
      expect(bOwed).toBe(3_888n); // 40% of 9,720

      const aPlayer = await fetchPlayer(ctx, a);
      const bPlayer = await fetchPlayer(ctx, b);
      expect(big(aPlayer.principal)).toBe(aStake + aOwed + dust);
      expect(big(bPlayer.principal)).toBe(bStake + bOwed + dust);
      const pool = await fetchPool(ctx);
      expect(big(pool.yieldOwed)).toBe(depositorShare(gain1) + depositorShare(gain2) - aOwed - bOwed);
      expect(big(pool.yieldOwed)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "settled yield lands in Principal, total Principal and Tickets, and leaves the Pool's total claims unchanged",
    async () => {
      const { ctx, a, gain } = await earningPool();
      const owed = depositorShare(gain); // A is the only holder: all of it

      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc(); // books the gain, settles no one
      const before = await fetchPool(ctx);
      const playerBefore = await fetchPlayer(ctx, a);
      expect(big(before.yieldOwed)).toBe(owed);
      expect(big(playerBefore.principal)).toBe(MILLION);

      // A request that moves one unit settles first.
      await requestWithdraw(ctx, a, 1n);
      const after = await fetchPool(ctx);
      const playerAfter = await fetchPlayer(ctx, a);
      expect(big(playerAfter.principal)).toBe(MILLION + owed - 1n);
      expect(big(playerAfter.entries)).toBe(MILLION + owed - 1n);
      expect(big(playerAfter.pendingWithdraw)).toBe(1n);
      expect(big(after.totalPrincipal)).toBe(MILLION + owed - 1n);
      expect(big(after.yieldOwed)).toBe(0n);
      expect(big(after.pendingWithdrawals)).toBe(1n);
    },
    TIMEOUT,
  );

  it(
    "a deposit left idle lowers the rate for everyone and a deploy restores it",
    async () => {
      const { ctx, gain: gain1 } = await earningPool();
      const b = await ctx.fundedWallet(MILLION * 2n);
      const step = 2n * 10n ** 10n;

      // Gain 1 is booked by B's deposit, at 1M total Principal.
      await deposit(ctx, b, MILLION);
      const rise1 = indexRise(depositorShare(gain1), MILLION);
      expect(big((await fetchPool(ctx)).yieldIndex)).toBe(rise1);

      // B's 1M sits idle. The same rate step earns the same 18,000 on the
      // same 9e11 deployed shares, now spread over 2M of Principal.
      const gain2 = await bump(ctx, step);
      expect(gain2).toBe(gain1);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      let index = big((await fetchPool(ctx)).yieldIndex);
      const rise2 = index - rise1;
      expect(rise2).toBe(indexRise(depositorShare(gain2), 2n * MILLION));
      expect(rise2 * 2n).toBe(rise1);

      // Deploying B's money puts it to work: the same step now earns on twice
      // the shares and the rate per unit of Principal comes back.
      await deploy(ctx, 89n * 10n ** 10n); // 890k, inside the 10% idle target
      const gain3 = await bump(ctx, step);
      expect(gain3 > gain1 * 19n / 10n).toBe(true);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      const pool = await fetchPool(ctx);
      const rise3 = big(pool.yieldIndex) - index;
      expect(rise3).toBe(indexRise(depositorShare(gain3), 2n * MILLION));
      expect(rise3 > rise2 * 19n / 10n).toBe(true);
      // Within 2% of the rate before B arrived (890k of B's 1M went out, not 900k).
      expect(rise3 * 100n >= rise1 * 98n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a settle that rounds to zero leaves the stored index alone, so a small balance accumulates",
    async () => {
      // C holds 1 USDC next to A's 1M at 100% APR: about 0.032 atomic units a
      // second. The gains here are large so the ceiling binds and every
      // second of elapsed time pays depositors exactly its share.
      const { ctx } = await earningPool();
      const c = await ctx.fundedWallet(10_000_000n);
      await deposit(ctx, c, 1_000_000n);
      const start = await fetchPlayer(ctx, c);
      const startIndex = big(start.yieldIndex);
      const stamped = big((await fetchPool(ctx)).lastSyncAt);

      // First settle, a few seconds on: owed is 1e6 x rise / 1e18, under one
      // unit. The request moves one unit, so Principal falls to 999,999 and
      // nothing else changes, the index included.
      await bump(ctx, 2n * 10n ** 12n);
      await requestWithdraw(ctx, c, 1n);
      let pool = await fetchPool(ctx);
      let player = await fetchPlayer(ctx, c);
      expect(owedFor(1_000_000n, big(pool.yieldIndex) - startIndex)).toBe(0n);
      expect(big(player.principal)).toBe(999_999n);
      expect(big(player.entries)).toBe(999_999n);
      expect(big(player.yieldIndex)).toBe(startIndex);

      // Let the rise add up past one unit (999,999 units at 100% APR earn 1
      // unit in about 32 s), then settle again: the fraction that was held
      // back is paid now.
      await sleepUntilOnChain(Number(stamped) + 40);
      await bump(ctx, 2n * 10n ** 12n);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      pool = await fetchPool(ctx);
      const owed = owedFor(999_999n, big(pool.yieldIndex) - startIndex);
      expect(owed >= 1n).toBe(true);
      const yieldOwedBefore = big(pool.yieldOwed);
      await requestWithdraw(ctx, c, 1n);
      player = await fetchPlayer(ctx, c);
      pool = await fetchPool(ctx);
      expect(big(player.principal)).toBe(999_999n + owed - 1n);
      expect(big(player.yieldIndex)).toBe(big(pool.yieldIndex));
      expect(big(pool.yieldOwed)).toBe(yieldOwedBefore - owed);
    },
    TIMEOUT,
  );

  it(
    "a deposit after a zero-rounding settle does not earn the yield that came before it",
    async () => {
      // C is left holding 1 unit, so every settle rounds to zero and C's index
      // goes stale. C then deposits 100k USDC. Without the rebase at deposit
      // time, the next settle would pay that Principal for the whole stale
      // period.
      const { ctx } = await earningPool();
      const c = await ctx.fundedWallet(10n ** 12n);
      const d = 100_000n * 1_000_000n;
      await deposit(ctx, c, 1_000_000n);
      await bump(ctx, 2n * 10n ** 12n);
      await requestWithdraw(ctx, c, 999_999n);
      const stale = await fetchPlayer(ctx, c);
      expect(big(stale.principal)).toBe(1n);
      expect(big(stale.yieldIndex) < big((await fetchPool(ctx)).yieldIndex)).toBe(true);

      await deposit(ctx, c, d);
      const pool = await fetchPool(ctx);
      const player = await fetchPlayer(ctx, c);
      expect(big(player.principal)).toBe(1n + d);
      expect(big(player.yieldIndex)).toBe(big(pool.yieldIndex));

      // No new gain since: a settle now owes nothing, so Principal only
      // falls by what is requested.
      await requestWithdraw(ctx, c, 1n);
      expect(big((await fetchPlayer(ctx, c)).principal)).toBe(d);
    },
    TIMEOUT,
  );

  it(
    "the House never earns",
    async () => {
      const { ctx, a } = await earningPool();
      await deposit(ctx, a, 1_000_000n); // books and settles the gain for A
      const pool = await fetchPool(ctx);
      const house = await program.account.player.fetch(ctx.house);

      // The House holds no Principal and no instruction can give it any:
      // `deposit` refuses it and `settle` skips it outright.
      expect(house.isHouse).toBe(true);
      expect(big(house.principal)).toBe(0n);
      expect(big(house.yieldIndex)).toBe(0n);
      const aPlayer = await fetchPlayer(ctx, a);
      expect(big(pool.totalPrincipal)).toBe(big(aPlayer.principal));

      // Asking to withdraw runs sync and settle on the House before it fails
      // on the empty balance, and the failed call leaves it untouched.
      await waitPastLastSync(ctx);
      await expect(
        program.methods
          .requestWithdraw(new BN(1))
          .accountsPartial({
            owner: ctx.operator.publicKey,
            pool: ctx.pool,
            player: ctx.house,
            ...ctx.venue,
          })
          .signers([ctx.operator])
          .rpc(),
      ).rejects.toThrow(/InsufficientPrincipal/);
      const after = await program.account.player.fetch(ctx.house);
      expect(big(after.principal)).toBe(0n);
      expect(big(after.entries)).toBe(0n);
      expect(big(after.yieldIndex)).toBe(0n);
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "request withdraw settles first, so earned yield can be withdrawn in the same call",
    async () => {
      const { ctx, a, gain } = await earningPool();
      const owed = depositorShare(gain);
      await waitPastLastSync(ctx);
      // MILLION + owed exceeds the stored Principal until settle adds `owed`.
      await requestWithdrawMethod(ctx, a, MILLION + owed).rpc();
      await assertSolvent(ctx);
      const player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(0n);
      expect(big(player.entries)).toBe(0n);
      expect(big(player.pendingWithdraw)).toBe(MILLION + owed);
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(0n);
      expect(big(pool.pendingWithdrawals)).toBe(MILLION + owed);
      expect(big(pool.yieldOwed)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "after an epoch boundary, touch resets Tickets to Principal and the settled yield joins both",
    async () => {
      const ctx = await newPool({ epochSeconds: 5 });
      const a = await ctx.fundedWallet(MILLION * 2n);
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, MILLION);
      await deploy(ctx, 9n * 10n ** 11n);
      const gain = await bump(ctx, 2n * 10n ** 10n);
      const owed = depositorShare(gain);

      await retryUntilOk(() => beginEpoch(ctx, 1n)); // epoch 2
      await deposit(ctx, a, 1_000_000n);
      const player = await fetchPlayer(ctx, a);
      expect(big(player.epochId)).toBe(2n);
      expect(big(player.principal)).toBe(MILLION + owed + 1_000_000n);
      expect(big(player.entries)).toBe(big(player.principal));
    },
    TIMEOUT,
  );

  it(
    "emergency withdraw pays Principal including the yield settled in the same call",
    async () => {
      const { ctx, a, gain } = await earningPool();
      const owed = depositorShare(gain);
      // Not yet booked: the call's own sync books it.
      expect(big((await fetchPool(ctx)).yieldOwed)).toBe(0n);

      await program.methods
        .shutdown()
        .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
        .signers([ctx.admin])
        .rpc();

      const accounts = {
        pool: ctx.pool,
        player: playerPda(ctx.pool, a.keypair.publicKey),
        owner: a.keypair.publicKey,
        acceptedMint: ctx.mint,
        ownerToken: a.tokenAccount,
        principalVault: ctx.principalVault,
        ...ctx.venue,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      await waitPastLastSync(ctx);
      // 90% of the pool is deployed and recall is ticket 07, so the vault
      // cannot cover the exit: the call fails and changes nothing.
      await expect(program.methods.emergencyWithdraw().accountsPartial(accounts).rpc()).rejects.toThrow(
        /InsufficientVault/,
      );
      expect(big((await fetchPlayer(ctx, a)).principal)).toBe(MILLION);

      // Stand in for a recall: mint 1M USDC straight into the principal vault.
      await mintTo(provider.connection, ctx.operator, ctx.mint, ctx.principalVault, ctx.operator, MILLION);
      await assertSolvent(ctx);

      const walletBefore = await balance(a.tokenAccount);
      await waitPastLastSync(ctx);
      const signature = await program.methods.emergencyWithdraw().accountsPartial(accounts).rpc();
      await assertSolvent(ctx);

      expect((await balance(a.tokenAccount)) - walletBefore).toBe(MILLION + owed);
      const event = await findEvent<{ principal: BN; pending: BN; total: BN }>(
        signature,
        "emergencyWithdrawn",
      );
      expect(event?.principal.toString()).toBe((MILLION + owed).toString());
      expect(event?.total.toString()).toBe((MILLION + owed).toString());
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(0n);
      expect(big(pool.yieldOwed)).toBe(0n);
      expect(big((await fetchPlayer(ctx, a)).principal)).toBe(0n);
    },
    TIMEOUT,
  );
});

describe("venue accounts on the syncing instructions", () => {
  it(
    "deposit and request withdraw refuse a reserve that is not the pinned one",
    async () => {
      const ctx = await newPool();
      const other = await newPool();
      const a = await ctx.fundedWallet(MILLION);
      await deposit(ctx, a, 1_000_000n);
      const wrong = { ...ctx.venue, klendReserve: other.venue.klendReserve };
      await waitPastLastSync(ctx);
      await expect(depositMethod(ctx, a, 1_000_000n, wrong).rpc()).rejects.toThrow(/VenueMismatch/);
      await expect(requestWithdrawMethod(ctx, a, 1n, wrong).rpc()).rejects.toThrow(/VenueMismatch/);
      expect(big((await fetchPlayer(ctx, a)).principal)).toBe(1_000_000n);
    },
    TIMEOUT,
  );
});

/** `currentEpochId` is `pool.currentEpochId` before this call (same as the
 *  custody suite's helper). */
async function beginEpoch(ctx: PoolCtx, currentEpochId: bigint) {
  const twoBehindId = currentEpochId > 0n ? currentEpochId - 1n : 0n;
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: ctx.operator.publicKey,
      pool: ctx.pool,
      currentEpoch: epochPda(ctx.pool, currentEpochId),
      epochTwoBehind: epochPda(ctx.pool, twoBehindId),
      newEpoch: epochPda(ctx.pool, currentEpochId + 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.operator])
    .rpc();
}
