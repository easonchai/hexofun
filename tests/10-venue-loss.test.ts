// Venue loss, haircut and safety switches (yield-claimer ticket 10; spec "Venue
// loss", ADR 0017). A sync that sees the venue fall past the loss tolerance
// takes the loss from the prize share owed, then the fee owed, then records a
// deficit and sets `impaired`. While impaired every exit pays the haircut, and
// harvest and deploy are refused. Every pool runs against the test-venue stub,
// where `rate` is USDC per share scaled by 1e18. A loss is a lower rate: the
// stub keeps its USDC, but the position is worth less.
//
// Amounts are 6-decimal USDC atomic units. Defaults: a 100 USDC minimum venue
// move, a 10% idle target, a 10% Yield fee, a 1 bp loss tolerance. The rates
// below (0.8, 0.9, 1.2) turn whole-USDC amounts into whole shares, so the
// arithmetic is exact and `assertSolvent` can be strict after every
// instruction. A rate drop is only booked at the next sync, so solvency is
// checked after that sync, not straight after the drop.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  beginFirstEpoch,
  coverDeficitMethod,
  deployMethod,
  deployToVenue,
  findEvent,
  grantTicketsAsAdmin,
  harvestMethod,
  playerPda,
  program,
  provider,
  recallMethod,
  refundAccounts,
  setDeployPauseMethod,
  setReserveStats,
  setupPool,
  setVenueParamsMethod,
  setVenueRate,
  stubVenueValue,
  testSyncMethod,
  waitPastLastSync,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 180_000;
const USDC = 1_000_000n;
const SCALE = 10n ** 18n;
const RATE_08 = (8n * SCALE) / 10n;
const RATE_09 = (9n * SCALE) / 10n;
const RATE_12 = (12n * SCALE) / 10n;
const IMPAIRED_CAUSE = { gain: 0, cover: 1, withdrawal: 2 };

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const fetchPlayer = (ctx: PoolCtx, owner: Wallet) =>
  program.account.player.fetch(playerPda(ctx.pool, owner.keypair.publicKey));
const balance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

async function deposit(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await program.methods
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
  await grantTicketsAsAdmin(ctx, owner.keypair.publicKey, amount);
  await assertSolvent(ctx);
  return signature;
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

function processMethod(ctx: PoolCtx, owner: Wallet) {
  return program.methods.processWithdraw().accountsPartial({
    pool: ctx.pool,
    player: playerPda(ctx.pool, owner.keypair.publicKey),
    acceptedMint: ctx.mint,
    ownerToken: owner.tokenAccount,
    principalVault: ctx.principalVault,
    tokenProgram: TOKEN_PROGRAM_ID,
      ...ctx.venue,
  });
}

function emergencyMethod(ctx: PoolCtx, owner: Wallet) {
  return program.methods.emergencyWithdraw().accountsPartial({
    pool: ctx.pool,
    player: playerPda(ctx.pool, owner.keypair.publicKey),
    owner: owner.keypair.publicKey,
    acceptedMint: ctx.mint,
    ownerToken: owner.tokenAccount,
    principalVault: ctx.principalVault,
    ...ctx.venue,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

/** `request_withdraw` for a Player whose Principal is a pending deposit, which
 *  is every Player in epoch 0: it refunds in the same transaction (ADR 0020). */
function refundMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      ...refundAccounts(ctx, owner),
      ...ctx.venue,
    })
    .signers([owner.keypair]);
}

async function refund(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await refundMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
  return signature;
}

/** A refused call changes nothing, so solvency must still hold. */
async function refused(ctx: PoolCtx, call: Promise<unknown>, error: RegExp) {
  await expect(call).rejects.toThrow(error);
  await assertSolvent(ctx);
}

async function deploy(ctx: PoolCtx, amount: bigint) {
  await waitPastLastSync(ctx);
  await deployToVenue(ctx, amount);
  await assertSolvent(ctx);
}

/** Moves the stub's rate and books it with the next sync. Returns the sync's
 *  signature. Solvency is checked after the sync, which is what books a fall. */
async function reprice(ctx: PoolCtx, rate: bigint, dust = 0n) {
  await setVenueRate(ctx, rate).rpc();
  await waitPastLastSync(ctx);
  const signature = await testSyncMethod(ctx).rpc();
  await assertSolvent(ctx, dust);
  return signature;
}

async function shutdown(ctx: PoolCtx) {
  await program.methods
    .shutdown()
    .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
    .signers([ctx.admin])
    .rpc();
}

/** Puts the USDC a rate rise is worth into the stub vault. The operator is the
 *  mint authority. */
async function fundStub(ctx: PoolCtx, amount: bigint) {
  await mintTo(provider.connection, ctx.operator, ctx.mint, ctx.venue.klendCtoken, ctx.operator, amount);
}

/** `depositors` deposit, then 90% of the total is deployed: the vault keeps the
 *  10% idle target and the stub holds the rest. */
async function deployedPool(
  amounts: bigint[],
  overrides: Parameters<typeof setupPool>[0] = {},
) {
  const ctx = await setupPool(overrides);
  const wallets: Wallet[] = [];
  for (const amount of amounts) {
    const wallet = await ctx.fundedWallet(amount);
    await deposit(ctx, wallet, amount);
    wallets.push(wallet);
  }
  const total = amounts.reduce((a, b) => a + b, 0n);
  await deploy(ctx, (total * 9n) / 10n);
  return { ctx, wallets };
}

/** A pool with 1,000 deposited by one Player, 900 deployed, then the rate at
 *  0.8: 720 of value, a deficit of 180, impaired. */
async function impairedPool(amounts: bigint[] = [1_000n * USDC], overrides = {}) {
  const made = await deployedPool(amounts, overrides);
  await reprice(made.ctx, RATE_08);
  expect((await fetchPool(made.ctx)).impaired).toBe(true);
  return made;
}

interface ImpairedSet {
  loss: BN;
  prizeAbsorbed: BN;
  feeAbsorbed: BN;
  deficit: BN;
}
interface ImpairedCleared {
  deficit: BN;
  cause: number;
}
interface Synced {
  gain: BN;
  fee: BN;
  depositorShare: BN;
  prizeShare: BN;
  deficitRepaid: BN;
}

describe("venue loss and the haircut", () => {
  it(
    "treats a fall within the tolerance as dust: only the stored value changes",
    async () => {
      const { ctx } = await deployedPool([1_000n * USDC]);
      // 1 bp of 900 USDC is 90,000. The rate falls by exactly that much.
      const signature = await reprice(ctx, SCALE - SCALE / 10_000n, 90_000n);

      const pool = await fetchPool(ctx);
      expect(pool.impaired).toBe(false);
      expect(pool.deficit.toString()).toBe("0");
      expect(pool.venueValue.toString()).toBe((900n * USDC - 90_000n).toString());
      for (const field of ["feeOwed", "prizeOwed", "yieldOwed", "yieldIndex"] as const) {
        expect(pool[field].toString(), field).toBe("0");
      }
      expect(await findEvent(signature, "impairedSet")).toBeUndefined();

      // The tolerance is a share of the stored value, 899.91 now, so a second
      // fall of 90,000 is past it (89,991) and is a loss. The 90,000 that the
      // first fall left unbacked is the dust the solvency check is told about.
      await reprice(ctx, SCALE - (2n * SCALE) / 10_000n, 90_000n);
      const impaired = await fetchPool(ctx);
      expect(impaired.impaired).toBe(true);
      expect(big(impaired.deficit)).toBe(90_000n);
    },
    TIMEOUT,
  );

  it(
    "charges a loss to prize owed, then fee owed, then the deficit, and never moves the index",
    async () => {
      const { ctx, wallets } = await deployedPool([1_000n * USDC]);
      const [owner] = wallets as [Wallet];
      // A gain of 180 puts prize and fee owed on the books: fee 18, the rest
      // split between a sliver for depositors (the ceiling over a few
      // seconds) and the prize.
      await fundStub(ctx, 180n * USDC);
      await reprice(ctx, RATE_12);
      const gained = await fetchPool(ctx);
      expect(gained.feeOwed.toString()).toBe((18n * USDC).toString());
      expect(big(gained.prizeOwed) > 100n * USDC).toBe(true);
      const owedBefore = big(gained.prizeOwed) + big(gained.feeOwed);

      // 1,080 falls to 810: a loss of 270, over the 180 of prize and fee owed.
      const signature = await reprice(ctx, RATE_09);
      const pool = await fetchPool(ctx);
      const event = await findEvent<ImpairedSet>(signature, "impairedSet");
      expect(big(event!.loss)).toBe(270n * USDC);
      expect(big(event!.prizeAbsorbed)).toBe(big(gained.prizeOwed));
      expect(big(event!.feeAbsorbed)).toBe(big(gained.feeOwed));
      const deficit = 270n * USDC - owedBefore;
      expect(big(event!.deficit)).toBe(deficit);
      expect(big(pool.deficit)).toBe(deficit);
      expect(pool.impaired).toBe(true);
      expect(pool.prizeOwed.toString()).toBe("0");
      expect(pool.feeOwed.toString()).toBe("0");
      // Depositors' owed yield and the index are untouched by the loss.
      expect(pool.yieldOwed.toString()).toBe(gained.yieldOwed.toString());
      expect(pool.yieldIndex.toString()).toBe(gained.yieldIndex.toString());
      expect(pool.venueValue.toString()).toBe((810n * USDC).toString());
      expect(big((await fetchPlayer(ctx, owner)).principal)).toBe(1_000n * USDC);

      // A later gain repays the deficit before any split: the fee, depositor
      // and prize shares add up to what is left, and the prize and fee owed
      // that the loss consumed are not restored.
      const back = await reprice(ctx, RATE_12);
      const synced = await findEvent<Synced>(back, "synced");
      expect(big(synced!.gain)).toBe(270n * USDC);
      expect(big(synced!.deficitRepaid)).toBe(deficit);
      const split = big(synced!.fee) + big(synced!.depositorShare) + big(synced!.prizeShare);
      expect(split).toBe(270n * USDC - deficit);
      expect(big(synced!.fee)).toBe(split / 10n);
      const cleared = await findEvent<ImpairedCleared>(back, "impairedCleared");
      expect(big(cleared!.deficit)).toBe(deficit);
      expect(cleared!.cause).toBe(IMPAIRED_CAUSE.gain);

      const after = await fetchPool(ctx);
      expect(after.impaired).toBe(false);
      expect(after.deficit.toString()).toBe("0");
      expect(big(after.feeOwed)).toBe(big(synced!.fee));
      expect(big(after.prizeOwed)).toBe(big(synced!.prizeShare));
      // 270 came back, 90 + y0 of it went to the deficit, so the owed amounts
      // hold only the other 180 - y0: the 180 consumed by the loss is gone.
      expect(big(after.prizeOwed) + big(after.feeOwed)).toBeLessThan(180n * USDC);
      expect(big(after.prizeOwed) + big(after.feeOwed) + big(synced!.depositorShare)).toBe(split);
    },
    TIMEOUT,
  );

  it(
    "refuses harvest and deploy while impaired, and still takes deposits, queued requests and recalls",
    async () => {
      const { ctx, wallets } = await deployedPool([1_000n * USDC]);
      const [alice] = wallets as [Wallet];
      await beginFirstEpoch(ctx); // Alice's deposit is active, so her request queues
      // A 1 USDC floor, so a small recall is allowed. Also exercises the setter.
      await setVenueParamsMethod(ctx, { minVenueMove: 1n * USDC }).rpc();
      await reprice(ctx, RATE_08);
      expect((await fetchPool(ctx)).impaired).toBe(true);

      await refused(ctx, harvestMethod(ctx).rpc(), /PoolImpaired/);

      // Deposit still works, and pushes free idle over the target...
      const bob = await ctx.fundedWallet(500n * USDC);
      await deposit(ctx, bob, 500n * USDC);
      // ...which deploy would normally take, but not while impaired.
      await refused(ctx, deployMethod(ctx, 100n * USDC).rpc(), /PoolImpaired/);

      // A queued request still works. 540 pending leaves 60 free idle, under
      // the target of 10% of 780.
      await requestWithdraw(ctx, alice, 540n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(540n * USDC);

      // And so does a recall: up to the target.
      const vaultBefore = await balance(ctx.principalVault);
      await recallMethod(ctx, 10n * USDC).rpc();
      await assertSolvent(ctx);
      expect((await balance(ctx.principalVault)) - vaultBefore).toBe(10n * USDC);
      expect((await fetchPool(ctx)).impaired).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "pays the haircut on the refund of a pending deposit, and Principal falls by the whole amount",
    async () => {
      const { ctx, wallets } = await impairedPool();
      const [alice] = wallets as [Wallet];
      // Vault 100 + venue 720 over Principal 1,000: 0.82. Withdrawing 500
      // pays 410, redeeming 310 from the venue.
      const walletBefore = await balance(alice.tokenAccount);
      const signature = await refund(ctx, alice, 500n * USDC);

      expect((await balance(alice.tokenAccount)) - walletBefore).toBe(410n * USDC);
      const player = await fetchPlayer(ctx, alice);
      expect(big(player.principal)).toBe(500n * USDC);
      expect(big(player.pendingDeposit)).toBe(500n * USDC);
      // The refunded units held no Ticket, so none left.
      expect(big(player.entries)).toBe(1_000n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(500n * USDC);
      expect(big(pool.venueValue)).toBe(410n * USDC);
      expect(await balance(ctx.principalVault)).toBe(0n);
      // The 90 the exit gave up came off the deficit.
      expect(big(pool.deficit)).toBe(90n * USDC);
      expect(pool.impaired).toBe(true);

      const event = await findEvent<{ refunded: BN; paid: BN; redeemed: BN }>(
        signature,
        "withdrawRequested",
      );
      expect(big(event!.refunded)).toBe(500n * USDC);
      expect(big(event!.paid)).toBe(410n * USDC);
      expect(big(event!.redeemed)).toBe(310n * USDC);
    },
    TIMEOUT,
  );

  it(
    "gives every exit the same ratio, and a full unwind pays out all the assets and clears impaired",
    async () => {
      const { ctx, wallets } = await impairedPool([600n * USDC, 400n * USDC]);
      const [alice, bob] = wallets as [Wallet, Wallet];
      const aliceBefore = await balance(alice.tokenAccount);
      const bobBefore = await balance(bob.tokenAccount);

      // 0.82 for each of them, whoever goes first.
      await refund(ctx, alice, 300n * USDC);
      expect((await balance(alice.tokenAccount)) - aliceBefore).toBe(246n * USDC);
      await refund(ctx, bob, 400n * USDC);
      expect((await balance(bob.tokenAccount)) - bobBefore).toBe(328n * USDC);
      expect((await fetchPool(ctx)).impaired).toBe(true);

      const signature = await refund(ctx, alice, 300n * USDC);
      expect((await balance(alice.tokenAccount)) - aliceBefore).toBe(492n * USDC);

      const pool = await fetchPool(ctx);
      expect(pool.totalPrincipal.toString()).toBe("0");
      expect(pool.deficit.toString()).toBe("0");
      expect(pool.impaired).toBe(false);
      // Everything the pool held went out: 246 + 328 + 246 = 820.
      expect(await balance(ctx.principalVault)).toBe(0n);
      expect(await stubVenueValue(ctx)).toBe(0n);
      const cleared = await findEvent<ImpairedCleared>(signature, "impairedCleared");
      expect(cleared!.cause).toBe(IMPAIRED_CAUSE.withdrawal);
    },
    TIMEOUT,
  );

  it(
    "gives a depositor who left under the haircut nothing when the deficit later clears",
    async () => {
      const { ctx, wallets } = await impairedPool([500n * USDC, 500n * USDC]);
      const [alice, bob] = wallets as [Wallet, Wallet];
      await refund(ctx, alice, 500n * USDC);
      const aliceWallet = await balance(alice.tokenAccount);
      expect(aliceWallet).toBe(410n * USDC);
      expect(big((await fetchPool(ctx)).deficit)).toBe(90n * USDC);

      // The venue recovers. The 512.5 shares left are worth 512.5 at par.
      const signature = await reprice(ctx, SCALE);
      const synced = await findEvent<Synced>(signature, "synced");
      expect(big(synced!.deficitRepaid)).toBe(90n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.impaired).toBe(false);
      expect(pool.deficit.toString()).toBe("0");

      // Alice has no claim on it. Bob's Principal is still 500, and he leaves
      // at par, plus whatever the sync's remainder settles to him.
      expect(await balance(alice.tokenAccount)).toBe(aliceWallet);
      expect((await fetchPlayer(ctx, alice)).principal.toString()).toBe("0");
      const bobBefore = await balance(bob.tokenAccount);
      await refund(ctx, bob, 500n * USDC);
      expect((await balance(bob.tokenAccount)) - bobBefore).toBe(500n * USDC);
    },
    TIMEOUT,
  );

  it(
    "pays the haircut when a queued request is processed",
    async () => {
      const { ctx, wallets } = await deployedPool([1_000n * USDC]);
      const [alice] = wallets as [Wallet];
      await beginFirstEpoch(ctx); // the deposit is active, so the request queues
      await requestWithdraw(ctx, alice, 100n * USDC);
      await reprice(ctx, RATE_08);
      // Vault 100 + venue 720 = 820 over 1,000 of Principal, the queued 100
      // included.
      expect(big((await fetchPool(ctx)).deficit)).toBe(180n * USDC);
      await shutdown(ctx);

      const walletBefore = await balance(alice.tokenAccount);
      const signature = await processMethod(ctx, alice).rpc();
      await assertSolvent(ctx);
      expect((await balance(alice.tokenAccount)) - walletBefore).toBe(82n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.pendingWithdrawals.toString()).toBe("0");
      expect(big(pool.deficit)).toBe(162n * USDC);
      expect(pool.impaired).toBe(true);
      const event = await findEvent<{ amount: BN }>(signature, "withdrawn");
      expect(big(event!.amount)).toBe(82n * USDC);
    },
    TIMEOUT,
  );

  it(
    "pays the haircut on an emergency withdrawal of Principal, the queued amount inside it",
    async () => {
      const { ctx, wallets } = await deployedPool([1_000n * USDC]);
      const [alice] = wallets as [Wallet];
      await beginFirstEpoch(ctx);
      await requestWithdraw(ctx, alice, 100n * USDC);
      await reprice(ctx, RATE_08);
      await shutdown(ctx);
      // After Shutdown a recall has no limit: bring the position home.
      await recallMethod(ctx, 720n * USDC).rpc();
      await assertSolvent(ctx);
      expect(await balance(ctx.principalVault)).toBe(820n * USDC);

      const walletBefore = await balance(alice.tokenAccount);
      const signature = await emergencyMethod(ctx, alice).rpc();
      await assertSolvent(ctx);
      // Principal is 1,000 and holds the queued 100. At 0.82 that is 820.
      expect((await balance(alice.tokenAccount)) - walletBefore).toBe(820n * USDC);
      const player = await fetchPlayer(ctx, alice);
      expect([player.principal.toString(), player.pendingWithdraw.toString()]).toEqual(["0", "0"]);
      const pool = await fetchPool(ctx);
      expect(pool.deficit.toString()).toBe("0");
      expect(pool.impaired).toBe(false);
      const cleared = await findEvent<ImpairedCleared>(signature, "impairedCleared");
      expect(cleared!.cause).toBe(IMPAIRED_CAUSE.withdrawal);
      const event = await findEvent<{ total: BN }>(signature, "emergencyWithdrawn");
      expect(big(event!.total)).toBe(820n * USDC);
    },
    TIMEOUT,
  );

  it(
    "never sets impaired from rounding dust of a deploy or a redeem",
    async () => {
      const ctx = await setupPool();
      await setVenueParamsMethod(ctx, { minVenueMove: 1n * USDC }).rpc();
      // 1.3 does not divide a whole-USDC amount into whole shares, so the
      // deploy credits a unit less than it moved.
      await setVenueRate(ctx, (13n * SCALE) / 10n).rpc();
      const owner = await ctx.fundedWallet(1_000n * USDC);
      await deposit(ctx, owner, 1_000n * USDC);
      await waitPastLastSync(ctx);
      await deployToVenue(ctx, 900n * USDC);
      // The deploy and every redeem below can leave the pool a unit short
      // when there is no fee owed to bear it.
      const dust = 8n;
      await assertSolvent(ctx, dust);
      expect(big(await stubVenueValue(ctx)) < 900n * USDC).toBe(true);

      for (const step of [
        () => testSyncMethod(ctx).rpc(),
        () => refundMethod(ctx, owner, 333_333_333n).rpc(),
        () => recallMethod(ctx, 20n * USDC).rpc(),
        () => testSyncMethod(ctx).rpc(),
      ]) {
        await waitPastLastSync(ctx);
        await step();
        await assertSolvent(ctx, dust);
        const pool = await fetchPool(ctx);
        expect(pool.impaired).toBe(false);
        expect(pool.deficit.toString()).toBe("0");
      }
    },
    TIMEOUT,
  );
});

describe("cover deficit", () => {
  it(
    "is permissionless, caps at the deficit, and clears impaired at zero",
    async () => {
      const { ctx } = await impairedPool();
      const payer = await ctx.fundedWallet(500n * USDC);
      const vaultBefore = await balance(ctx.principalVault);

      const first = await coverDeficitMethod(ctx, 100n * USDC, payer.keypair, payer.tokenAccount).rpc();
      await assertSolvent(ctx);
      expect(await balance(payer.tokenAccount)).toBe(400n * USDC);
      expect((await balance(ctx.principalVault)) - vaultBefore).toBe(100n * USDC);
      let pool = await fetchPool(ctx);
      expect(big(pool.deficit)).toBe(80n * USDC);
      expect(pool.impaired).toBe(true);
      const covered = await findEvent<{ amount: BN; deficit: BN }>(first, "deficitCovered");
      expect([big(covered!.amount), big(covered!.deficit)]).toEqual([100n * USDC, 80n * USDC]);

      // Overpaying moves only what is owed.
      const second = await coverDeficitMethod(ctx, 300n * USDC, payer.keypair, payer.tokenAccount).rpc();
      await assertSolvent(ctx);
      expect(await balance(payer.tokenAccount)).toBe(320n * USDC);
      pool = await fetchPool(ctx);
      expect(pool.deficit.toString()).toBe("0");
      expect(pool.impaired).toBe(false);
      const cleared = await findEvent<ImpairedCleared>(second, "impairedCleared");
      expect(big(cleared!.deficit)).toBe(80n * USDC);
      expect(cleared!.cause).toBe(IMPAIRED_CAUSE.cover);

      // Nothing left to cover, and zero is refused.
      await refused(
        ctx,
        coverDeficitMethod(ctx, 1n * USDC, payer.keypair, payer.tokenAccount).rpc(),
        /NoDeficit/,
      );
      await refused(
        ctx,
        coverDeficitMethod(ctx, 0n, payer.keypair, payer.tokenAccount).rpc(),
        /ZeroAmount/,
      );
      expect(await balance(payer.tokenAccount)).toBe(320n * USDC);
    },
    TIMEOUT,
  );

  it(
    "leaves a depositor whole once covered: they leave at par",
    async () => {
      const { ctx, wallets } = await impairedPool();
      const [alice] = wallets as [Wallet];
      const payer = await ctx.fundedWallet(200n * USDC);
      await coverDeficitMethod(ctx, 180n * USDC, payer.keypair, payer.tokenAccount).rpc();
      await assertSolvent(ctx);
      expect((await fetchPool(ctx)).impaired).toBe(false);

      const walletBefore = await balance(alice.tokenAccount);
      await refund(ctx, alice, 1_000n * USDC);
      expect((await balance(alice.tokenAccount)) - walletBefore).toBe(1_000n * USDC);
    },
    TIMEOUT,
  );
});

describe("deploy pause", () => {
  it(
    "lets the Admin or the Operator turn it on, and only the Admin turn it off",
    async () => {
      const ctx = await setupPool();
      const owner = await ctx.fundedWallet(1_000n * USDC);
      await deposit(ctx, owner, 1_000n * USDC);
      const stranger = Keypair.generate();

      await expect(setDeployPauseMethod(ctx, true, stranger).rpc()).rejects.toThrow(/Unauthorized/);

      const signature = await setDeployPauseMethod(ctx, true, ctx.operator).rpc();
      expect((await fetchPool(ctx)).deployPaused).toBe(true);
      const event = await findEvent<{ paused: boolean }>(signature, "deployPauseSet");
      expect(event?.paused).toBe(true);
      await waitPastLastSync(ctx);
      await refused(ctx, deployMethod(ctx, 900n * USDC).rpc(), /DeployPaused/);

      // The hot key cannot reopen it, and neither can a stranger.
      await expect(setDeployPauseMethod(ctx, false, ctx.operator).rpc()).rejects.toThrow(/Unauthorized/);
      await expect(setDeployPauseMethod(ctx, false, stranger).rpc()).rejects.toThrow(/Unauthorized/);
      expect((await fetchPool(ctx)).deployPaused).toBe(true);

      await setDeployPauseMethod(ctx, false).rpc();
      expect((await fetchPool(ctx)).deployPaused).toBe(false);
      await deploy(ctx, 900n * USDC);
      expect(big(await stubVenueValue(ctx))).toBe(900n * USDC);

      // The Admin can pause as well.
      await setDeployPauseMethod(ctx, true).rpc();
      expect((await fetchPool(ctx)).deployPaused).toBe(true);
    },
    TIMEOUT,
  );
});

describe("deploy caps", () => {
  it(
    "refuses a deploy past the reserve-share cap or under the reserve's minimum free liquidity, and after Shutdown",
    async () => {
      const ctx = await setupPool();
      const owner = await ctx.fundedWallet(1_000n * USDC);
      await deposit(ctx, owner, 1_000n * USDC);
      await waitPastLastSync(ctx);

      // 5% share cap (default): 900 into a 10,000 reserve is 8.3% of 10,900.
      await setReserveStats(ctx, 10_000n * USDC, 1_000_000n * USDC).rpc();
      await refused(ctx, deployMethod(ctx, 900n * USDC).rpc(), /ReserveShareCapExceeded/);
      // A big reserve with little free liquidity.
      await setReserveStats(ctx, 1_000_000n * USDC, 800n * USDC).rpc();

      // The reserve keeps 800 free, and 900 in would take the pool's position to
      // 900 against 1,700 free: under twice.
      await refused(ctx, deployMethod(ctx, 900n * USDC).rpc(), /ReserveLiquidityTooLow/);
      // 800 in: position 800 against 1,600 free is exactly twice. Allowed.
      await deployToVenue(ctx, 800n * USDC);
      await assertSolvent(ctx);
      expect(big(await stubVenueValue(ctx))).toBe(800n * USDC);

      // After Shutdown the deploy is refused outright.
      await shutdown(ctx);
      await refused(ctx, deployMethod(ctx, 100n * USDC).rpc(), /PoolShutDown/);
    },
    TIMEOUT,
  );

  it(
    "takes the cap from the Admin's setting",
    async () => {
      const ctx = await setupPool();
      const owner = await ctx.fundedWallet(1_000n * USDC);
      await deposit(ctx, owner, 1_000n * USDC);
      await waitPastLastSync(ctx);
      await setReserveStats(ctx, 10_000n * USDC, 1_000_000n * USDC).rpc();
      await refused(ctx, deployMethod(ctx, 900n * USDC).rpc(), /ReserveShareCapExceeded/);

      // 10%: 900 of 10,900 is 8.3%, inside.
      await setVenueParamsMethod(ctx, { reserveShareCapBps: 1_000 }).rpc();
      await deployToVenue(ctx, 900n * USDC);
      await assertSolvent(ctx);
      expect(big(await stubVenueValue(ctx))).toBe(900n * USDC);
    },
    TIMEOUT,
  );
});

describe("set venue params", () => {
  it(
    "is Admin-only and bounded by the program constants",
    async () => {
      const ctx = await setupPool();
      const stranger = Keypair.generate();
      const before = await fetchPool(ctx);

      for (const signer of [ctx.operator, stranger]) {
        await expect(setVenueParamsMethod(ctx, { yieldFeeBps: 500 }, signer).rpc()).rejects.toThrow(
          /ConstraintHasOne|has_one|Unauthorized|A has one constraint was violated/i,
        );
      }

      const refusals: Array<[string, Parameters<typeof setVenueParamsMethod>[1]]> = [
        ["a fee over the constant", { yieldFeeBps: 2_001 }],
        ["an idle floor over the target", { idleFloorBps: 1_001 }],
        ["a target under the floor", { idleTargetBps: 499 }],
        ["a target over its bound", { idleFloorBps: 100, idleTargetBps: 5_001 }],
        ["a tolerance over its constant", { lossToleranceBps: 101 }],
        ["a share cap over its bound", { reserveShareCapBps: 2_001 }],
        ["a liquidity floor under 1x", { reserveLiquidityFloorBps: 9_999 }],
        ["a liquidity floor over its bound", { reserveLiquidityFloorBps: 60_001 }],
        ["a zero minimum size", { minVenueMove: 0n }],
        ["a minimum size over its bound", { minVenueMove: 10_000n * USDC + 1n }],
      ];
      for (const [name, args] of refusals) {
        await expect(setVenueParamsMethod(ctx, args).rpc(), name).rejects.toThrow(/InvalidParameter/);
      }
      const unchanged = await fetchPool(ctx);
      for (const field of [
        "yieldFeeBps",
        "idleFloorBps",
        "idleTargetBps",
        "reserveShareCapBps",
        "reserveLiquidityFloorBps",
        "minVenueMove",
        "lossToleranceBps",
      ] as const) {
        expect(unchanged[field].toString(), field).toBe(before[field].toString());
      }

      // The bounds themselves, both settings of a pair in one call.
      const signature = await setVenueParamsMethod(ctx, {
        yieldFeeBps: 2_000,
        idleFloorBps: 3_000,
        idleTargetBps: 5_000,
        reserveShareCapBps: 2_000,
        reserveLiquidityFloorBps: 60_000,
        minVenueMove: 10_000n * USDC,
        lossToleranceBps: 100,
      }).rpc();
      const set = await fetchPool(ctx);
      expect(set.yieldFeeBps).toBe(2_000);
      expect([set.idleFloorBps, set.idleTargetBps]).toEqual([3_000, 5_000]);
      expect(set.reserveShareCapBps).toBe(2_000);
      expect(set.reserveLiquidityFloorBps).toBe(60_000);
      expect(big(set.minVenueMove)).toBe(10_000n * USDC);
      expect(set.lossToleranceBps).toBe(100);
      const event = await findEvent<{ yieldFeeBps: number; idleTargetBps: number }>(
        signature,
        "venueParamsSet",
      );
      expect([event?.yieldFeeBps, event?.idleTargetBps]).toEqual([2_000, 5_000]);

      // Naming nothing changes nothing.
      await setVenueParamsMethod(ctx, {}).rpc();
      expect((await fetchPool(ctx)).yieldFeeBps).toBe(2_000);
    },
    TIMEOUT,
  );
});
