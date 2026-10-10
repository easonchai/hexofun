// Recall, harvest and treasury accounts (yield-claimer ticket 07; spec "New
// instructions", "Sync", "Solvency invariant"). Every pool runs against the
// test-venue stub: `rate` is USDC per share scaled by 1e18, shares go in at
// 1:1 on a fresh pool, and the stub's redeem needs the USDC in the stub vault,
// so a test that raises the rate and then redeems the gain mints the gain into
// the stub vault first (`fundStub`).
//
// Amounts are 6-decimal USDC atomic units. The defaults are a 100 USDC minimum
// venue move, a 10% idle target and a 10% Yield fee. The idle target is
// `ceil((free idle + venue value) x 10%)`, free idle being the vault balance
// minus Pending withdrawals, which is negative when the vault is short.
//
// Every deposit and every request-withdraw goes through `deposit` and
// `requestWithdraw` below, so the accounts they name change in one place.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAccount, createMint, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  beginFirstEpoch,
  deployToVenue,
  findEvent,
  harvestMethod,
  playerPda,
  program,
  provider,
  recallMethod,
  refundAccounts,
  setTreasuryAccountsMethod,
  setupPool,
  setVenueRate,
  sleepUntilOnChain,
  stubVenueValue,
  testSyncMethod,
  waitPastLastSync,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;
const USDC = 1_000_000n;
const SCALE = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const fetchPlayer = (ctx: PoolCtx, owner: Wallet) =>
  program.account.player.fetch(playerPda(ctx.pool, owner.keypair.publicKey));
const balance = async (account: PublicKey): Promise<bigint> =>
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

async function requestWithdraw(ctx: PoolCtx, owner: Wallet, amount: bigint, solvent = true) {
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
  if (solvent) await assertSolvent(ctx);
}

async function processWithdraw(ctx: PoolCtx, owner: Wallet) {
  const signature = await program.methods
    .processWithdraw()
    .accountsPartial({
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      owner: null,
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...ctx.venue,
    })
    .rpc();
  await assertSolvent(ctx);
  return signature;
}

async function shutdown(ctx: PoolCtx) {
  await program.methods
    .shutdown()
    .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
    .signers([ctx.admin])
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

/** A pool whose vault was minted `amount` USDC with no deposit, so
 *  `total_principal` is 0 and a gain splits only into fee and prize. */
async function mintedPool(amount: bigint) {
  const ctx = await setupPool();
  await mintTo(provider.connection, ctx.operator, ctx.mint, ctx.principalVault, ctx.operator, amount);
  await assertSolvent(ctx);
  return ctx;
}

async function deploy(ctx: PoolCtx, amount: bigint) {
  await waitPastLastSync(ctx);
  await deployToVenue(ctx, amount);
  await assertSolvent(ctx);
}

async function setRate(ctx: PoolCtx, rate: bigint) {
  await setVenueRate(ctx, rate).rpc();
  await assertSolvent(ctx);
}

/** Puts the USDC a rate rise is worth into the stub vault, so the stub can
 *  pay it out. The operator is the mint authority. */
async function fundStub(ctx: PoolCtx, amount: bigint) {
  await mintTo(
    provider.connection,
    ctx.operator,
    ctx.mint,
    ctx.venue.klendCtoken,
    ctx.operator,
    amount,
  );
  await assertSolvent(ctx);
}

async function recall(ctx: PoolCtx, amount: bigint, solvent = true) {
  const signature = await recallMethod(ctx, amount).rpc();
  if (solvent) await assertSolvent(ctx);
  return signature;
}

async function harvest(ctx: PoolCtx, treasury: PublicKey = ctx.treasury) {
  const signature = await harvestMethod(ctx, treasury).rpc();
  await assertSolvent(ctx);
  return signature;
}

/** A refused call changes nothing, so solvency must still hold. */
async function refused(ctx: PoolCtx, call: Promise<unknown>, error: RegExp) {
  await expect(call).rejects.toThrow(error);
  await assertSolvent(ctx);
}

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
  return { fee, depositor, prize: rest - depositor, indexDelta };
}

interface HarvestEvent {
  gain: BN;
  fee: BN;
  depositorShare: BN;
  prizeShare: BN;
  feePaid: BN;
  prizePaid: BN;
}

describe("recall", () => {
  it(
    "is refused when free idle is at or above the idle target, and for zero",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      // Nothing deployed: free idle is 1,000 against a target of 100.
      await refused(ctx, recallMethod(ctx, 100n * USDC).rpc(), /RecallNotNeeded/);

      // 900 out leaves exactly 100 idle, which is the target: still refused.
      await deploy(ctx, 900n * USDC);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);
      await refused(ctx, recallMethod(ctx, 100n * USDC).rpc(), /RecallNotNeeded/);
      await refused(ctx, recallMethod(ctx, 0n).rpc(), /ZeroAmount/);
      expect(await balance(ctx.venue.klendCtoken)).toBe(900n * USDC);
    },
    TIMEOUT,
  );

  it(
    "takes USDC back up to the target and not past it, with free idle negative",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // 300 moves to Pending: the vault holds 100 against 300 queued, so free
      // idle is -200. Total is -200 + 900 = 700, the target 70, and the most
      // a recall may take is 70 - (-200) = 270.
      await beginFirstEpoch(ctx); // the deposit is active, so a request queues
      await requestWithdraw(ctx, owner, 300n * USDC);

      await refused(ctx, recallMethod(ctx, 270n * USDC + 1n).rpc(), /RecallExceedsTarget/);
      const signature = await recall(ctx, 270n * USDC);

      expect(await balance(ctx.principalVault)).toBe(370n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(630n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe((630n * USDC).toString());
      expect(pool.pendingWithdrawals.toString()).toBe((300n * USDC).toString());
      const event = await findEvent<{ amount: BN; venueValue: BN }>(signature, "venueRecalled");
      expect(event?.amount.toString()).toBe((270n * USDC).toString());
      expect(event?.venueValue.toString()).toBe((630n * USDC).toString());

      // Free idle is 370 - 300 = 70 of a 700 total: at the target, so no more.
      await refused(ctx, recallMethod(ctx, 100n * USDC).rpc(), /RecallNotNeeded/);
    },
    TIMEOUT,
  );

  it(
    "measures the target on the synced value when free idle is positive but under it",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // The venue triples: 900 shares are worth 2,700. Once the recall's own
      // sync books that, total is 100 + 2,700 = 2,800, the target 280 and the
      // room 280 - 100 = 180.
      await setRate(ctx, 3n * SCALE);
      await waitPastLastSync(ctx);

      await refused(ctx, recallMethod(ctx, 180n * USDC + 1n).rpc(), /RecallExceedsTarget/);
      await recall(ctx, 180n * USDC);

      expect(await balance(ctx.principalVault)).toBe(280n * USDC);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((840n * USDC).toString());
      expect((await fetchPool(ctx)).venueValue.toString()).toBe((2_520n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "refuses an amount under the minimum unless it is exactly what a Pending withdrawal is short",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // Vault 100, Pending 190: the vault is short by 90, under the 100 minimum.
      // Free idle is -90, total 810, target 81, so the room is 171.
      await beginFirstEpoch(ctx);
      await requestWithdraw(ctx, owner, 190n * USDC);

      await refused(ctx, recallMethod(ctx, 89n * USDC).rpc(), /VenueMoveTooSmall/);
      await refused(ctx, recallMethod(ctx, 91n * USDC).rpc(), /VenueMoveTooSmall/);
      await recall(ctx, 90n * USDC);
      expect(await balance(ctx.principalVault)).toBe(190n * USDC);

      // Covered now: free idle is 0 of 810, the room is 81, and an amount that
      // is not what a Pending withdrawal needs must be the minimum or more.
      await refused(ctx, recallMethod(ctx, 81n * USDC).rpc(), /VenueMoveTooSmall/);
      await refused(ctx, recallMethod(ctx, 100n * USDC).rpc(), /RecallExceedsTarget/);
    },
    TIMEOUT,
  );

  it(
    "has no limit after Shutdown and brings the whole position home",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      await refused(ctx, recallMethod(ctx, 900n * USDC).rpc(), /RecallNotNeeded/);

      await shutdown(ctx);
      // Under the minimum, and past the target: both fine now.
      await recall(ctx, 50n * USDC);
      await recall(ctx, 850n * USDC);

      expect(await balance(ctx.principalVault)).toBe(1_000n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(0n);
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("0");
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe("0");
      // The position is empty, so there is nothing left to ask for.
      await refused(ctx, recallMethod(ctx, 1n).rpc(), /VenueIlliquid/);
    },
    TIMEOUT,
  );

  it(
    "is not a gain or a loss at the next sync",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      await beginFirstEpoch(ctx);
      await requestWithdraw(ctx, owner, 300n * USDC);
      await recall(ctx, 270n * USDC);
      const before = await fetchPool(ctx);

      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);

      const after = await fetchPool(ctx);
      expect(big(after.lastSyncAt) > big(before.lastSyncAt)).toBe(true);
      expect(after.venueValue.toString()).toBe(before.venueValue.toString());
      expect(after.venueValue.toString()).toBe((await stubVenueValue(ctx)).toString());
      for (const field of ["feeOwed", "yieldOwed", "prizeOwed", "yieldIndex"] as const) {
        expect(after[field].toString(), field).toBe("0");
      }
    },
    TIMEOUT,
  );

  it(
    "charges the rounding dust of a redeem to the fee owed",
    async () => {
      // A rate of 4/3 less 1e-18 never divides evenly. 9,000 USDC of shares
      // are worth floor(9e9 x r / 1e18) = 11,999,999,999 at that rate, a gain of
      // 2,999,999,999 and a 10% fee of 299,999,999.
      const rate = 1_333_333_333_333_333_333n;
      const { ctx } = await fundedPool(10_000n * USDC);
      await deploy(ctx, 9_000n * USDC);
      await setRate(ctx, rate);
      await waitPastLastSync(ctx);

      // Free idle 1,000 of a 12,999,999,999 total: target 1,300,000,000, room
      // 300. Redeeming 100 USDC burns ceil(1e8 x 1e18 / r) = 75,000,001 shares,
      // leaving 8,924,999,999 worth floor(4/3 x that) = 11,899,999,998. The
      // value fell by 100,000,001: one unit more than arrived.
      await recall(ctx, 100n * USDC);

      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("11899999998");
      expect(pool.feeOwed.toString()).toBe("299999998");
      expect(await balance(ctx.principalVault)).toBe(1_100n * USDC);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe("8924999999");

      // And it is booked: the next sync finds nothing new.
      const owedBefore = [pool.feeOwed, pool.yieldOwed, pool.prizeOwed, pool.yieldIndex].map(String);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);
      const after = await fetchPool(ctx);
      expect([after.feeOwed, after.yieldOwed, after.prizeOwed, after.yieldIndex].map(String)).toEqual(
        owedBefore,
      );
      expect(after.venueValue.toString()).toBe("11899999998");
    },
    TIMEOUT,
  );

  it(
    "floors the dust charge at zero when no fee is owed",
    async () => {
      const rate = 1_333_333_333_333_333_333n;
      const { ctx, owner } = await fundedPool(10_000n * USDC);
      // Priced before any shares exist, so the deploy itself is lossy and
      // there is no gain: 9e9 USDC units buy floor(9e27 / r) = 6,750,000,000
      // shares, worth floor(4/3 x 6.75e9 less a hair) = 8,999,999,999.
      //
      // The venue is a unit short of the claims from the deploy on. The spec
      // books that as rounding dust, which the strict `assertSolvent` does not
      // forgive, so this test skips it after the deploy.
      await setRate(ctx, rate);
      await waitPastLastSync(ctx);
      await deployToVenue(ctx, 9_000n * USDC);
      await beginFirstEpoch(ctx);
      await requestWithdraw(ctx, owner, 1_000n * USDC, false);
      let pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("8999999999");
      expect(pool.feeOwed.toString()).toBe("0");

      // Free idle 0 of 8,999,999,999: target 900,000,000. Redeeming 100 USDC
      // burns 75,000,001 shares, leaving 6,674,999,999 worth 8,899,999,998.
      await recall(ctx, 100n * USDC, false);

      pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("8899999998");
      expect(pool.feeOwed.toString()).toBe("0");
      expect(pool.prizeOwed.toString()).toBe("0");
      expect(pool.yieldOwed.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "makes a Pending withdrawal the vault could not cover payable",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC, { epochSeconds: 5 });
      await deploy(ctx, 900n * USDC);
      // Vault 100 against 450 queued: short by 350. Free idle is -350, total
      // 550, target 55, so up to 405 may come back.
      await beginFirstEpoch(ctx);
      await requestWithdraw(ctx, owner, 450n * USDC);
      const player = await fetchPlayer(ctx, owner);
      await sleepUntilOnChain(Number(player.requestedAt.toString()) + 5 + 1);

      await refused(ctx, processWithdraw(ctx, owner), /InsufficientVaultLiquidity/);
      expect((await fetchPlayer(ctx, owner)).pendingWithdraw.toString()).toBe(
        (450n * USDC).toString(),
      );

      await recall(ctx, 350n * USDC);
      const before = await balance(owner.tokenAccount);
      await processWithdraw(ctx, owner);

      expect((await balance(owner.tokenAccount)) - before).toBe(450n * USDC);
      expect((await fetchPlayer(ctx, owner)).pendingWithdraw.toString()).toBe("0");
      const pool = await fetchPool(ctx);
      expect(pool.pendingWithdrawals.toString()).toBe("0");
      expect(pool.totalPrincipal.toString()).toBe((550n * USDC).toString());
      expect(await balance(ctx.principalVault)).toBe(0n);
    },
    TIMEOUT,
  );
});

describe("harvest", () => {
  it(
    "pays the fee owed to the Treasury and the prize owed to the jackpot vault, and zeroes both",
    async () => {
      // No Principal, so the gain splits only into fee and prize.
      const ctx = await mintedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // 900 shares at 2.0 are worth 1,800: a gain of 900, a 90 fee, a 810 prize.
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      const [treasury, jackpot, vault] = [
        await balance(ctx.treasury),
        await balance(ctx.jackpotVault),
        await balance(ctx.principalVault),
      ];

      const signature = await harvest(ctx);

      expect((await balance(ctx.treasury)) - treasury).toBe(90n * USDC);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(810n * USDC);
      // The 100 of free idle pays first; the other 800 is redeemed. 900 paid out.
      expect(await balance(ctx.principalVault)).toBe(vault - 100n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.feeOwed.toString()).toBe("0");
      expect(pool.prizeOwed.toString()).toBe("0");
      expect(pool.yieldOwed.toString()).toBe("0");
      // 500 shares left at 2.0.
      expect(pool.venueValue.toString()).toBe((1_000n * USDC).toString());
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((500n * USDC).toString());

      const event = await findEvent<HarvestEvent>(signature, "harvested");
      expect(event?.gain.toString()).toBe((900n * USDC).toString());
      expect(event?.fee.toString()).toBe((90n * USDC).toString());
      expect(event?.depositorShare.toString()).toBe("0");
      expect(event?.prizeShare.toString()).toBe((810n * USDC).toString());
      expect(event?.feePaid.toString()).toBe((90n * USDC).toString());
      expect(event?.prizePaid.toString()).toBe((810n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "with nothing owed fails and moves no USDC, and the next event covers only the new gain",
    async () => {
      const ctx = await mintedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // Nothing booked yet.
      await refused(ctx, harvestMethod(ctx).rpc(), /NothingToHarvest/);

      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      await harvest(ctx);

      const snapshot = () =>
        Promise.all(
          [ctx.treasury, ctx.jackpotVault, ctx.principalVault, ctx.venue.klendCtoken].map(balance),
        );
      const before = await snapshot();
      await refused(ctx, harvestMethod(ctx).rpc(), /NothingToHarvest/);
      expect(await snapshot()).toEqual(before);

      // 500 shares at 2.5 are worth 1,250: a gain of 250 over the 1,000 booked.
      // Fee 25, prize 225, redeemed as 100 shares (the vault is empty). The
      // totals were zeroed by the first harvest, so the event shows 250.
      await setRate(ctx, 25n * 10n ** 17n);
      await fundStub(ctx, 250n * USDC);
      await waitPastLastSync(ctx);
      const treasury = await balance(ctx.treasury);
      const jackpot = await balance(ctx.jackpotVault);
      const signature = await harvest(ctx);

      expect((await balance(ctx.treasury)) - treasury).toBe(25n * USDC);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(225n * USDC);
      const event = await findEvent<HarvestEvent>(signature, "harvested");
      expect(event?.gain.toString()).toBe((250n * USDC).toString());
      expect(event?.fee.toString()).toBe((25n * USDC).toString());
      expect(event?.prizeShare.toString()).toBe((225n * USDC).toString());
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((400n * USDC).toString());
      expect((await fetchPool(ctx)).venueValue.toString()).toBe((1_000n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "is permissionless, cannot be pointed at another account, and leaves Principal, yield owed and the index alone",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      const before = await fetchPool(ctx);
      const playerBefore = await fetchPlayer(ctx, owner);
      const [treasury, jackpot, vault] = [
        await balance(ctx.treasury),
        await balance(ctx.jackpotVault),
        await balance(ctx.principalVault),
      ];

      // The owner's own token account is a valid USDC account, but not the
      // Pool's Treasury.
      await refused(ctx, harvestMethod(ctx, owner.tokenAccount).rpc(), /ConstraintHasOne/);

      // The provider wallet is no role on the pool.
      const signature = await harvest(ctx);
      const after = await fetchPool(ctx);

      // The gain is 900. Fee 90, then the rest against the ceiling over the
      // seconds since the last sync.
      const elapsed = big(after.lastSyncAt) - big(before.lastSyncAt);
      const split = expectedSplit(
        900n * USDC,
        BigInt(before.yieldFeeBps),
        big(before.totalPrincipal),
        BigInt(before.baseRateBps),
        elapsed,
      );
      expect(split.fee).toBe(90n * USDC);
      expect(split.depositor > 0n && split.prize > 0n).toBe(true);

      // The 100 of free idle pays first. Redeeming the `gap` burns ceil(gap / 2)
      // shares at 2.0 and the value falls by twice that, so the venue costs one
      // unit too many when `gap` is odd. The fee bears it.
      const owed = split.fee + split.prize;
      const gap = owed - 100n * USDC;
      const fall = 2n * ((gap + 1n) / 2n);
      const dust = fall - gap;
      expect((await balance(ctx.treasury)) - treasury).toBe(split.fee - dust);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(split.prize);
      expect((await balance(ctx.principalVault)) - vault).toBe(dust - 100n * USDC);

      expect(after.feeOwed.toString()).toBe("0");
      expect(after.prizeOwed.toString()).toBe("0");
      expect(after.venueValue.toString()).toBe((1_800n * USDC - fall).toString());
      // What harvest must not touch: depositors' share and the index it paid.
      expect(after.yieldOwed.toString()).toBe(split.depositor.toString());
      expect(after.yieldIndex.toString()).toBe(split.indexDelta.toString());
      expect(after.totalPrincipal.toString()).toBe(before.totalPrincipal.toString());
      const player = await fetchPlayer(ctx, owner);
      expect(player.principal.toString()).toBe(playerBefore.principal.toString());
      expect(player.yieldIndex.toString()).toBe(playerBefore.yieldIndex.toString());
      expect(player.pendingWithdraw.toString()).toBe(playerBefore.pendingWithdraw.toString());

      const event = await findEvent<HarvestEvent>(signature, "harvested");
      expect(event?.gain.toString()).toBe((900n * USDC).toString());
      expect(event?.fee.toString()).toBe(split.fee.toString());
      expect(event?.depositorShare.toString()).toBe(split.depositor.toString());
      expect(event?.prizeShare.toString()).toBe(split.prize.toString());
      expect(event?.feePaid.toString()).toBe((split.fee - dust).toString());
      expect(event?.prizePaid.toString()).toBe(split.prize.toString());
    },
    TIMEOUT,
  );

  it(
    "pays from the vault when a full recall after Shutdown left nothing at the venue",
    async () => {
      const { ctx } = await fundedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      await shutdown(ctx);
      // The recall's sync books the 900 gain, then all 1,800 of the position
      // comes home. The fee and prize owed now sit in the vault.
      await recall(ctx, 1_800n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe("0");
      expect(await balance(ctx.principalVault)).toBe(1_900n * USDC);
      expect(pool.feeOwed.toString()).toBe((90n * USDC).toString());

      const treasury = await balance(ctx.treasury);
      const jackpot = await balance(ctx.jackpotVault);
      await harvest(ctx);

      const prize = big(pool.prizeOwed);
      expect((await balance(ctx.treasury)) - treasury).toBe(90n * USDC);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(prize);
      // What is left is exactly Principal plus the depositors' unsettled yield.
      expect(await balance(ctx.principalVault)).toBe(1_000n * USDC + big(pool.yieldOwed));
      const after = await fetchPool(ctx);
      expect(after.feeOwed.toString()).toBe("0");
      expect(after.prizeOwed.toString()).toBe("0");
    },
    TIMEOUT,
  );
});

describe("harvest redeems only the gap free idle leaves", () => {
  it(
    "pays from free idle without a redeem when it covers what is owed",
    async () => {
      const ctx = await mintedPool(1_000n * USDC);
      await deploy(ctx, 900n * USDC);
      // 900 shares at 1.1 are worth 990: a gain of 90, a 9 fee, an 81 prize.
      // The vault holds 100, so no redeem runs.
      await setRate(ctx, 11n * 10n ** 17n);
      await waitPastLastSync(ctx);
      const reserveBefore = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      const [treasury, jackpot, vault] = [
        await balance(ctx.treasury),
        await balance(ctx.jackpotVault),
        await balance(ctx.principalVault),
      ];

      await harvest(ctx);

      expect((await balance(ctx.treasury)) - treasury).toBe(9n * USDC);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(81n * USDC);
      expect(await balance(ctx.principalVault)).toBe(vault - 90n * USDC);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe(reserveBefore.shares.toString());
      expect(await stubVenueValue(ctx)).toBe(990n * USDC);
      expect((await fetchPool(ctx)).venueValue.toString()).toBe((990n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "fails with HarvestBelowMinimum and changes nothing when the gap is under the minimum venue move",
    async () => {
      const ctx = await mintedPool(1_000n * USDC);
      await deploy(ctx, 400n * USDC);
      // 400 shares at 2.625 are worth 1,050: a gain of 650 against 600 idle,
      // a gap of 50 under the 100 minimum.
      await setRate(ctx, 2_625n * 10n ** 15n);
      await fundStub(ctx, 650n * USDC);
      await waitPastLastSync(ctx);
      const poolBefore = await fetchPool(ctx);
      const snapshot = () =>
        Promise.all(
          [ctx.treasury, ctx.jackpotVault, ctx.principalVault, ctx.venue.klendCtoken].map(balance),
        );
      const before = await snapshot();

      await refused(ctx, harvestMethod(ctx).rpc(), /HarvestBelowMinimum/);

      expect(await snapshot()).toEqual(before);
      const poolAfter = await fetchPool(ctx);
      expect(poolAfter.feeOwed.toString()).toBe(poolBefore.feeOwed.toString());
      expect(poolAfter.venueValue.toString()).toBe(poolBefore.venueValue.toString());
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((400n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "redeems the gap and pays both destinations when it is at least the minimum venue move",
    async () => {
      const ctx = await mintedPool(1_000n * USDC);
      await deploy(ctx, 800n * USDC);
      // 800 shares at 2.0 are worth 1,600: a gain of 800 against 200 idle, a
      // gap of 600. The fee is 80 and the prize 720.
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 800n * USDC);
      await waitPastLastSync(ctx);
      const [treasury, jackpot] = [await balance(ctx.treasury), await balance(ctx.jackpotVault)];

      await harvest(ctx);

      expect((await balance(ctx.treasury)) - treasury).toBe(80n * USDC);
      expect((await balance(ctx.jackpotVault)) - jackpot).toBe(720n * USDC);
      // 200 of free idle plus 600 redeemed, 800 paid out.
      expect(await balance(ctx.principalVault)).toBe(0n);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((500n * USDC).toString());
      expect((await fetchPool(ctx)).venueValue.toString()).toBe((1_000n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "does not count a Pending withdrawal as free idle",
    async () => {
      const { ctx, owner } = await fundedPool(1_000n * USDC, { baseRateBps: 0 });
      await deploy(ctx, 900n * USDC);
      await beginFirstEpoch(ctx);
      // The vault holds 100; 60 of it is queued, so free idle is 40.
      await requestWithdraw(ctx, owner, 60n * USDC);
      expect((await fetchPool(ctx)).pendingWithdrawals.toString()).toBe((60n * USDC).toString());

      // 900 shares at 1.1 are worth 990: owed 90. The vault holds that much, but
      // 40 free idle leaves a gap of 50, under the minimum.
      await setRate(ctx, 11n * 10n ** 17n);
      await waitPastLastSync(ctx);
      await refused(ctx, harvestMethod(ctx).rpc(), /HarvestBelowMinimum/);

      // At 2.0 the owed 900 leaves a gap of 860, redeemed from the venue, and
      // the 60 queued stays in the vault.
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      await harvest(ctx);

      expect(await balance(ctx.principalVault)).toBe(60n * USDC);
      expect((await fetchPlayer(ctx, owner)).pendingWithdraw.toString()).toBe(
        (60n * USDC).toString(),
      );
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe((470n * USDC).toString());
    },
    TIMEOUT,
  );
});

describe("set_treasury_accounts", () => {
  it(
    "is Admin-only and takes only token accounts of the pool's mint",
    async () => {
      const ctx = await setupPool();
      const other = await createMint(provider.connection, ctx.operator, ctx.operator.publicKey, null, 6);
      const foreign = await createAccount(
        provider.connection,
        ctx.operator,
        other,
        ctx.operator.publicKey,
        Keypair.generate(),
      );
      const fresh = await createAccount(
        provider.connection,
        ctx.operator,
        ctx.mint,
        ctx.operator.publicKey,
        Keypair.generate(),
      );

      await expect(
        setTreasuryAccountsMethod(ctx, fresh, fresh, ctx.operator).rpc(),
      ).rejects.toThrow(/ConstraintHasOne/);
      await expect(setTreasuryAccountsMethod(ctx, foreign, fresh).rpc()).rejects.toThrow(
        /MintMismatch/,
      );
      await expect(setTreasuryAccountsMethod(ctx, fresh, foreign).rpc()).rejects.toThrow(
        /MintMismatch/,
      );

      const pool = await fetchPool(ctx);
      expect(pool.treasury.toBase58()).toBe(ctx.treasury.toBase58());
      expect(pool.buybackReserve.toBase58()).toBe(ctx.buybackReserve.toBase58());
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "sets both addresses, and the next harvest pays the new Treasury",
    async () => {
      const ctx = await mintedPool(1_000n * USDC);
      const make = () =>
        createAccount(
          provider.connection,
          ctx.operator,
          ctx.mint,
          ctx.operator.publicKey,
          Keypair.generate(),
        );
      const [treasury, buyback] = [await make(), await make()];

      const signature = await setTreasuryAccountsMethod(ctx, treasury, buyback).rpc();
      const pool = await fetchPool(ctx);
      expect(pool.treasury.toBase58()).toBe(treasury.toBase58());
      expect(pool.buybackReserve.toBase58()).toBe(buyback.toBase58());
      const event = await findEvent<{ treasury: PublicKey; buybackReserve: PublicKey }>(
        signature,
        "treasuryAccountsSet",
      );
      expect(event?.treasury.toBase58()).toBe(treasury.toBase58());
      expect(event?.buybackReserve.toBase58()).toBe(buyback.toBase58());

      await deploy(ctx, 900n * USDC);
      await setRate(ctx, 2n * SCALE);
      await fundStub(ctx, 900n * USDC);
      await waitPastLastSync(ctx);
      const oldTreasury = await balance(ctx.treasury);

      // The old account is no longer the Pool's.
      await refused(ctx, harvestMethod(ctx, ctx.treasury).rpc(), /ConstraintHasOne/);
      await harvest(ctx, treasury);
      expect(await balance(treasury)).toBe(90n * USDC);
      expect(await balance(ctx.treasury)).toBe(oldTreasury);
    },
    TIMEOUT,
  );
});
