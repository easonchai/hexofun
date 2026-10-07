// One withdraw path (yield-claimer ticket 22, ADR 0020). `request_withdraw`
// splits its amount. The part that is still a pending deposit never held a
// Ticket and refunds in the same transaction, from free idle or with a redeem
// from the venue. The rest queues, stays in the draw, the game and the yield,
// and `process_withdraw` pays it once the next epoch has begun. A queued amount
// is a sub-balance of Principal, so it is counted once everywhere: the solvency
// check in `assertSolvent` adds no Pending withdrawals beside `total_principal`.
//
// Every pool runs against the test-venue stub, where `rate` is USDC per share
// scaled by 1e18. Amounts are 6-decimal USDC atomic units. Defaults: a 100 USDC
// minimum venue move, a 10% idle target, a 10% Yield fee. `assertSolvent` runs
// after every instruction here, refused ones included.
//
// In epoch 0 every deposit is a pending deposit, which is how the refund
// suites below get a pending part without waiting for an epoch to turn. A
// queued amount needs Principal that held a Ticket, so those suites begin
// epochs; `begin_epoch` is gated on the wall clock, hence the retries.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  deployMethod,
  deployToVenue,
  epochPda,
  fetchTree,
  findEvent,
  fulfillRandomness,
  leafTickets,
  onChainNowSeconds,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessFor,
  randomnessPda,
  recallMethod,
  refundAccounts,
  retryUntilOk,
  roundPda,
  setupPool,
  setVenueRate,
  stubVenueValue,
  testNonce,
  testSyncMethod,
  txInfo,
  vrfSeed,
  waitPastLastSync,
  ticketsOf,
  type PoolCtx,
} from "./helpers/hx.js";
import idl from "../target/idl/hex_vault.json";

const TIMEOUT = 300_000;
const USDC = 1_000_000n;
const SCALE = 10n ** 18n;
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const fetchPlayer = (ctx: PoolCtx, owner: Wallet) =>
  program.account.player.fetch(playerPda(ctx.pool, owner.keypair.publicKey));
const balance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

interface WithdrawRequestedEvent {
  amount: BN;
  pending: BN;
  pendingEpoch: BN;
  refunded: BN;
  paid: BN;
  redeemed: BN;
}

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
  await assertSolvent(ctx);
  return signature;
}

/** Builder for `request_withdraw`. */
function requestMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
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

async function request(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await requestMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
  return signature;
}

/** Builder for `process_withdraw`. Signed by nobody unless `signed`, which adds
 *  the owner as the optional signer an impaired pool needs. */
function processMethod(ctx: PoolCtx, owner: Wallet, signed = false) {
  return program.methods
    .processWithdraw()
    .accountsPartial({
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      owner: signed ? owner.keypair.publicKey : null,
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers(signed ? [owner.keypair] : []);
}

async function processWithdraw(ctx: PoolCtx, owner: Wallet, signed = false) {
  const signature = await processMethod(ctx, owner, signed).rpc();
  await assertSolvent(ctx);
  return signature;
}

function emergencyMethod(ctx: PoolCtx, owner: Wallet, signed = false) {
  return program.methods
    .emergencyWithdraw()
    .accountsPartial({
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      owner: signed ? owner.keypair.publicKey : null,
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers(signed ? [owner.keypair] : []);
}

/** A refused call changes nothing, so solvency must still hold. */
async function refused(ctx: PoolCtx, call: Promise<unknown>, error: RegExp) {
  await expect(call).rejects.toThrow(error);
  await assertSolvent(ctx);
}

/** `currentEpochId` is `pool.currentEpochId` before this call. Polled, because
 *  the epoch's end is a wall-clock time. */
async function beginEpoch(ctx: PoolCtx, currentEpochId: bigint) {
  await retryUntilOk(() =>
    program.methods
      .beginEpoch()
      .accountsPartial({
        operator: ctx.operator.publicKey,
        pool: ctx.pool,
        currentEpoch: epochPda(ctx.pool, currentEpochId),
        epochTwoBehind: epochPda(ctx.pool, currentEpochId > 0n ? currentEpochId - 1n : 0n),
        newEpoch: epochPda(ctx.pool, currentEpochId + 1n),
        systemProgram: SystemProgram.programId,
      })
      .signers([ctx.operator])
      .rpc(),
  );
}

async function shutdown(ctx: PoolCtx) {
  await program.methods
    .shutdown()
    .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
    .signers([ctx.admin])
    .rpc();
}

async function deploy(ctx: PoolCtx, amount: bigint) {
  await waitPastLastSync(ctx);
  await deployToVenue(ctx, amount);
  await assertSolvent(ctx);
}

/** Moves the stub's rate and books it with the next sync. Solvency is checked
 *  after the sync, which is what books a fall. */
async function reprice(ctx: PoolCtx, rate: bigint) {
  await setVenueRate(ctx, rate).rpc();
  await waitPastLastSync(ctx);
  await testSyncMethod(ctx).rpc();
  await assertSolvent(ctx);
}

/** Puts the USDC a rate rise is worth into the stub vault. */
async function fundStub(ctx: PoolCtx, amount: bigint) {
  await mintTo(provider.connection, ctx.operator, ctx.mint, ctx.venue.klendCtoken, ctx.operator, amount);
}

/** The root of epoch `e`: every Player's Tickets. */
async function root(ctx: PoolCtx, e: bigint): Promise<bigint> {
  return leafTickets(await fetchTree(ctx), e).reduce((a, b) => a + b, 0n);
}

/** What the tree holds as `principal_sum` for `owner`'s leaf. */
async function treePrincipal(ctx: PoolCtx, owner: Wallet): Promise<bigint> {
  const player = await fetchPlayer(ctx, owner);
  return (await fetchTree(ctx)).nodes[player.leafIndex - 1]!.principalSum;
}

/** One Player with `amount` deposited in epoch 0 (all of it a pending deposit),
 *  90% of it deployed: the vault keeps the 10% idle target and the stub holds
 *  the rest. */
async function deployedPool(amount: bigint, overrides: Parameters<typeof setupPool>[0] = {}) {
  const ctx = await setupPool(overrides);
  const owner = await ctx.fundedWallet(amount);
  await deposit(ctx, owner, amount);
  await deploy(ctx, (amount * 9n) / 10n);
  return { ctx, owner };
}

/** A pool in epoch 2 with `amount` deposited in epoch 1 by one Player, whose
 *  whole Principal is therefore active, and `deployed` of it at the venue. */
async function activePool(
  amount: bigint,
  deployed: bigint,
  overrides: Parameters<typeof setupPool>[0] = {},
) {
  const ctx = await setupPool({ epochSeconds: 8, ...overrides });
  // Twice the deposit, so a test can deposit again in epoch 2.
  const owner = await ctx.fundedWallet(amount * 2n);
  await beginEpoch(ctx, 0n);
  await deposit(ctx, owner, amount);
  if (deployed > 0n) await deploy(ctx, deployed);
  await beginEpoch(ctx, 1n);
  return { ctx, owner };
}

/** Yield that `settle` would add to `player` at the pool's current index. */
function unsettled(
  pool: { yieldIndex: { toString(): string } },
  player: { principal: { toString(): string }; yieldIndex: { toString(): string } },
): bigint {
  return (big(player.principal) * (big(pool.yieldIndex) - big(player.yieldIndex))) / SCALE;
}

describe("the refund of a pending deposit", () => {
  it(
    "pays from free idle in one transaction, lowers Principal, the pending deposit, the pool total and the tree, and leaves Tickets alone",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);
      const walletBefore = await balance(owner.tokenAccount);
      const sharesBefore = (await program.account.testReserve.fetch(ctx.venue.klendReserve)).shares;
      expect(await treePrincipal(ctx, owner)).toBe(1_000n * USDC);

      const signature = await request(ctx, owner, 60n * USDC);

      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(60n * USDC);
      expect(await balance(ctx.principalVault)).toBe(40n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(900n * USDC);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe(sharesBefore.toString());

      const player = await fetchPlayer(ctx, owner);
      expect(big(player.principal)).toBe(940n * USDC);
      expect(big(player.pendingDeposit)).toBe(940n * USDC);
      expect(big(player.entries)).toBe(0n);
      expect(big(player.pendingWithdraw)).toBe(0n);
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(940n * USDC);
      expect(big(pool.pendingWithdrawals)).toBe(0n);
      expect(big(pool.venueValue)).toBe(900n * USDC);
      expect(await treePrincipal(ctx, owner)).toBe(940n * USDC);

      const event = await findEvent<WithdrawRequestedEvent>(signature, "withdrawRequested");
      expect(big(event!.amount)).toBe(60n * USDC);
      expect(big(event!.refunded)).toBe(60n * USDC);
      expect(big(event!.paid)).toBe(60n * USDC);
      expect(big(event!.redeemed)).toBe(0n);
      expect(big(event!.pending)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "redeems the gap from the venue when free idle is short and pays in the same transaction",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      const walletBefore = await balance(owner.tokenAccount);

      // 100 idle, 300 asked: the other 200 comes out of the venue.
      const signature = await request(ctx, owner, 300n * USDC);

      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(300n * USDC);
      expect(await balance(ctx.principalVault)).toBe(0n);
      expect(await balance(ctx.venue.klendCtoken)).toBe(700n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.venueValue)).toBe(700n * USDC);
      expect(big(pool.venueValue)).toBe(await stubVenueValue(ctx));
      expect(big(pool.totalPrincipal)).toBe(700n * USDC);
      const event = await findEvent<WithdrawRequestedEvent>(signature, "withdrawRequested");
      expect(big(event!.redeemed)).toBe(200n * USDC);
      expect(big(event!.paid)).toBe(300n * USDC);

      // The redeem was booked, so the next sync sees neither a gain nor a loss.
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);
      const after = await fetchPool(ctx);
      expect(big(after.venueValue)).toBe(big(pool.venueValue));
      for (const field of ["feeOwed", "yieldOwed", "prizeOwed", "yieldIndex"] as const) {
        expect(after[field].toString(), field).toBe("0");
      }

      const units = (await txInfo(signature)).units;
      console.log(`COMPUTE request_withdraw(refund with a redeem, small tree)=${units}`);
      expect(units).toBeLessThan(200_000);
    },
    TIMEOUT,
  );

  it(
    "fails with a named error and changes nothing when the venue cannot cover the gap, and never spends USDC held for a queued withdrawal",
    async () => {
      // A holds 1,000 of active Principal and has queued all of it, so the 100
      // USDC in the vault is nowhere near what is reserved.
      const { ctx, owner: a } = await activePool(1_000n * USDC, 900n * USDC);
      await request(ctx, a, 1_000n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(1_000n * USDC);

      // B deposits 800 into epoch 2, so the vault holds 900, all of it
      // reserved for A (1,000 queued). Free idle is nothing. A pool that is
      // impaired takes no deposit, so B comes in first.
      const b = await ctx.fundedWallet(800n * USDC);
      await deposit(ctx, b, 800n * USDC);
      expect(await balance(ctx.principalVault)).toBe(900n * USDC);

      // The venue loses half its value: 900 becomes 450, impaired, deficit 450.
      await reprice(ctx, SCALE / 2n);
      expect((await fetchPool(ctx)).impaired).toBe(true);

      // The Haircut is 900 + 450 over 1,800 of Principal: 800 refunds as 600.
      // None of it can come from the vault, and the venue is worth 450.
      const before = await fetchPool(ctx);
      const playerBefore = await fetchPlayer(ctx, b);
      await waitPastLastSync(ctx);
      await refused(ctx, requestMethod(ctx, b, 800n * USDC).rpc(), /VenueIlliquid/);
      const after = await fetchPool(ctx);
      for (const field of [
        "totalPrincipal",
        "venueValue",
        "pendingWithdrawals",
        "deficit",
        "yieldIndex",
        "lastSyncAt",
      ] as const) {
        expect(after[field].toString(), field).toBe(before[field].toString());
      }
      const playerAfter = await fetchPlayer(ctx, b);
      expect(big(playerAfter.principal)).toBe(big(playerBefore.principal));
      expect(big(playerAfter.pendingDeposit)).toBe(800n * USDC);
      expect(await balance(ctx.principalVault)).toBe(900n * USDC);
      expect(await balance(b.tokenAccount)).toBe(0n);

      // A smaller refund the venue can cover goes through: 100 pays 75, and all
      // 75 comes from the venue. The 900 held for A does not move.
      const signature = await request(ctx, b, 100n * USDC);
      const event = await findEvent<WithdrawRequestedEvent>(signature, "withdrawRequested");
      expect(big(event!.refunded)).toBe(100n * USDC);
      expect(big(event!.paid)).toBe(75n * USDC);
      expect(big(event!.redeemed)).toBe(75n * USDC);
      expect(await balance(b.tokenAccount)).toBe(75n * USDC);
      expect(await balance(ctx.principalVault)).toBe(900n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.pendingWithdrawals)).toBe(1_000n * USDC);
      // The 25 the refund gave up came off the deficit.
      expect(big(pool.deficit)).toBe(425n * USDC);
      expect(big(pool.totalPrincipal)).toBe(1_700n * USDC);
    },
    TIMEOUT,
  );
});

describe("the split and the queue", () => {
  it(
    "refunds the pending part, queues the rest, leaves the root and the Tickets unchanged, merges requests, and pays after the next epoch begins",
    async () => {
      const ctx = await setupPool({ epochSeconds: 8 });
      const a = await ctx.fundedWallet(200n * USDC);
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, 100n * USDC);
      await beginEpoch(ctx, 1n); // epoch 2
      // 100 is active, and this 50 is pending: Principal 150, Tickets 100.
      await deposit(ctx, a, 50n * USDC);
      let player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(150n * USDC);
      expect(big(player.entries)).toBe(100n * USDC);
      expect(big(player.pendingDeposit)).toBe(50n * USDC);
      const rootBefore = await root(ctx, 2n);
      expect(rootBefore).toBe(100n * USDC);
      expect(await treePrincipal(ctx, a)).toBe(150n * USDC);
      const walletBefore = await balance(a.tokenAccount);

      // 120 asked: 50 refunds now, 70 queues.
      const signature = await request(ctx, a, 120n * USDC);
      expect((await balance(a.tokenAccount)) - walletBefore).toBe(50n * USDC);
      player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(100n * USDC);
      expect(big(player.pendingDeposit)).toBe(0n);
      expect(big(player.pendingWithdraw)).toBe(70n * USDC);
      expect(big(player.pendingEpoch)).toBe(2n);
      // The request moved no Ticket and no tree weight but the refund's.
      expect(big(player.entries)).toBe(100n * USDC);
      expect(await root(ctx, 2n)).toBe(rootBefore);
      expect(await treePrincipal(ctx, a)).toBe(100n * USDC);
      let pool = await fetchPool(ctx);
      // The queued 70 is still inside the pool's Principal.
      expect(big(pool.totalPrincipal)).toBe(100n * USDC);
      expect(big(pool.pendingWithdrawals)).toBe(70n * USDC);
      const event = await findEvent<WithdrawRequestedEvent>(signature, "withdrawRequested");
      expect(big(event!.amount)).toBe(120n * USDC);
      expect(big(event!.refunded)).toBe(50n * USDC);
      expect(big(event!.pending)).toBe(70n * USDC);

      // A request with no pending part refunds nothing and merges into the queue,
      // and the later request stamps the maturity again.
      const stampedAt = big(player.requestedAt);
      const walletMid = await balance(a.tokenAccount);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const merged = await request(ctx, a, 20n * USDC);
      expect(await balance(a.tokenAccount)).toBe(walletMid);
      player = await fetchPlayer(ctx, a);
      expect(big(player.pendingWithdraw)).toBe(90n * USDC);
      expect(big(player.requestedAt) > stampedAt).toBe(true);
      expect(big((await findEvent<WithdrawRequestedEvent>(merged, "withdrawRequested"))!.paid)).toBe(0n);
      expect(await root(ctx, 2n)).toBe(rootBefore);

      // What one request can take is Principal less what is queued: 10 is left.
      await refused(ctx, requestMethod(ctx, a, 10n * USDC + 1n).rpc(), /InsufficientPrincipal/);
      await refused(ctx, requestMethod(ctx, a, 0n).rpc(), /ZeroAmount/);
      await request(ctx, a, 10n * USDC);
      expect(big((await fetchPlayer(ctx, a)).pendingWithdraw)).toBe(100n * USDC);
      await refused(ctx, requestMethod(ctx, a, 1n).rpc(), /InsufficientPrincipal/);

      // A request the pending part covers whole queues nothing and leaves the
      // maturity alone.
      await deposit(ctx, a, 20n * USDC);
      const before = await fetchPlayer(ctx, a);
      expect(big(before.pendingDeposit)).toBe(20n * USDC);
      await request(ctx, a, 20n * USDC);
      const covered = await fetchPlayer(ctx, a);
      expect(big(covered.pendingDeposit)).toBe(0n);
      expect(big(covered.pendingWithdraw)).toBe(100n * USDC);
      expect(big(covered.requestedAt)).toBe(big(before.requestedAt));
      expect(big(covered.pendingEpoch)).toBe(big(before.pendingEpoch));
      expect(big(covered.principal)).toBe(100n * USDC);
      expect(await root(ctx, 2n)).toBe(rootBefore);

      // Not due while the epoch it was requested in is current.
      await refused(ctx, processMethod(ctx, a).rpc(), /WithdrawalNotDue/);

      // After the next epoch begins, it pays the whole 100 and lowers Principal,
      // Tickets, the pool total and the tree together.
      await beginEpoch(ctx, 2n); // epoch 3
      const vaultBefore = await balance(ctx.principalVault);
      const walletBeforePay = await balance(a.tokenAccount);
      const paid = await processWithdraw(ctx, a);
      expect((await balance(a.tokenAccount)) - walletBeforePay).toBe(100n * USDC);
      expect(vaultBefore - (await balance(ctx.principalVault))).toBe(100n * USDC);
      player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(0n);
      expect(big(player.entries)).toBe(0n);
      expect(big(player.pendingWithdraw)).toBe(0n);
      pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(0n);
      expect(big(pool.pendingWithdrawals)).toBe(0n);
      expect(await treePrincipal(ctx, a)).toBe(0n);
      expect(await root(ctx, 3n)).toBe(0n);
      const withdrawn = await findEvent<{ amount: BN; principal: BN }>(paid, "withdrawn");
      expect(big(withdrawn!.amount)).toBe(100n * USDC);
      expect(big(withdrawn!.principal)).toBe(0n);
      await refused(ctx, processMethod(ctx, a).rpc(), /NothingPending/);

      const units = (await txInfo(paid)).units;
      console.log(`COMPUTE process_withdraw(sync, settle, touch, tree, small tree)=${units}`);
      expect(units).toBeLessThan(200_000);
    },
    TIMEOUT,
  );

  it(
    "keeps a queued withdrawal earning yield until it pays, and process_withdraw syncs the venue itself",
    async () => {
      const { ctx, owner } = await activePool(1_000n * USDC, 500n * USDC, { baseRateBps: 10_000 });
      await request(ctx, owner, 400n * USDC);
      const queuedAt = await fetchPlayer(ctx, owner);
      expect(big(queuedAt.principal)).toBe(1_000n * USDC);
      expect(big(queuedAt.entries)).toBe(1_000n * USDC);

      // The venue gains 100 after the request, and nothing has synced it.
      await setVenueRate(ctx, (12n * SCALE) / 10n).rpc();
      await fundStub(ctx, 100n * USDC);
      expect(big((await fetchPool(ctx)).yieldIndex)).toBe(0n);

      await beginEpoch(ctx, 2n); // epoch 3
      await waitPastLastSync(ctx);
      const walletBefore = await balance(owner.tokenAccount);
      await processWithdraw(ctx, owner);

      // It paid the queued 400 and not a unit of the yield. The sync inside
      // process_withdraw booked the gain, and the Player's Principal and Tickets
      // took their share of it, less the 400.
      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(400n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.yieldIndex) > 0n).toBe(true);
      const player = await fetchPlayer(ctx, owner);
      const settled = big(player.principal) - 600n * USDC;
      expect(settled > 0n).toBe(true);
      expect(big(player.entries)).toBe(big(player.principal));
      expect(big(player.pendingWithdraw)).toBe(0n);
      expect(await root(ctx, 3n)).toBe(big(player.principal));
      expect(big(pool.totalPrincipal)).toBe(big(player.principal));
    },
    TIMEOUT,
  );
});

describe("the Haircut while the pool is impaired", () => {
  it(
    "pays a refund the Haircut, and Principal falls by the whole refund",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      await reprice(ctx, (8n * SCALE) / 10n); // 900 becomes 720, deficit 180
      expect((await fetchPool(ctx)).impaired).toBe(true);

      // Vault 100 + venue 720 over Principal 1,000: 0.82. Refunding 500 pays
      // 410, redeeming 310.
      const walletBefore = await balance(owner.tokenAccount);
      const signature = await request(ctx, owner, 500n * USDC);
      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(410n * USDC);
      const player = await fetchPlayer(ctx, owner);
      expect(big(player.principal)).toBe(500n * USDC);
      expect(big(player.pendingDeposit)).toBe(500n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(500n * USDC);
      expect(big(pool.venueValue)).toBe(410n * USDC);
      // The 90 the exit gave up came off the deficit.
      expect(big(pool.deficit)).toBe(90n * USDC);
      expect(pool.impaired).toBe(true);
      const event = await findEvent<WithdrawRequestedEvent>(signature, "withdrawRequested");
      expect(big(event!.refunded)).toBe(500n * USDC);
      expect(big(event!.paid)).toBe(410n * USDC);
      expect(big(event!.redeemed)).toBe(310n * USDC);
    },
    TIMEOUT,
  );

  it(
    "pays a queued withdrawal the Haircut as of the moment it pays, and the loss it realises comes off the deficit",
    async () => {
      const { ctx, owner } = await activePool(1_000n * USDC, 900n * USDC);
      await request(ctx, owner, 500n * USDC); // queued while the pool is whole
      await reprice(ctx, (8n * SCALE) / 10n);
      expect(big((await fetchPool(ctx)).deficit)).toBe(180n * USDC);

      // The vault holds 100 against 500 queued. A recall brings 310 home, which
      // moves assets from the venue to the vault and does not change the
      // ratio: 410 + 410 over 1,000 of Principal.
      await waitPastLastSync(ctx);
      await recallMethod(ctx, 310n * USDC).rpc();
      await assertSolvent(ctx);
      expect(await balance(ctx.principalVault)).toBe(410n * USDC);

      await beginEpoch(ctx, 2n);
      const walletBefore = await balance(owner.tokenAccount);
      const signature = await processWithdraw(ctx, owner, true);

      // 500 at 0.82. The queued amount is inside Principal, so the ratio is
      // over 1,000 and not over 1,500.
      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(410n * USDC);
      const pool = await fetchPool(ctx);
      expect(big(pool.pendingWithdrawals)).toBe(0n);
      expect(big(pool.totalPrincipal)).toBe(500n * USDC);
      expect(big(pool.deficit)).toBe(90n * USDC);
      expect(pool.impaired).toBe(true);
      const player = await fetchPlayer(ctx, owner);
      expect(big(player.principal)).toBe(500n * USDC);
      const event = await findEvent<{ amount: BN }>(signature, "withdrawn");
      expect(big(event!.amount)).toBe(410n * USDC);
    },
    TIMEOUT,
  );
});

describe("emergency withdraw", () => {
  it(
    "pays the Haircut of Principal once, the queued amount included",
    async () => {
      const { ctx, owner } = await activePool(1_000n * USDC, 900n * USDC);
      await request(ctx, owner, 100n * USDC);
      await reprice(ctx, (8n * SCALE) / 10n);
      await shutdown(ctx);
      // After Shutdown a recall has no limit: bring the position home.
      await recallMethod(ctx, 720n * USDC).rpc();
      await assertSolvent(ctx);
      expect(await balance(ctx.principalVault)).toBe(820n * USDC);

      const walletBefore = await balance(owner.tokenAccount);
      const signature = await emergencyMethod(ctx, owner, true).rpc();
      await assertSolvent(ctx);
      // Principal is 1,000 and holds the queued 100. At 0.82 that is 820.
      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(820n * USDC);
      const player = await fetchPlayer(ctx, owner);
      for (const field of ["principal", "entries", "pendingDeposit", "pendingWithdraw"] as const) {
        expect(player[field].toString(), field).toBe("0");
      }
      const pool = await fetchPool(ctx);
      expect(pool.totalPrincipal.toString()).toBe("0");
      expect(pool.pendingWithdrawals.toString()).toBe("0");
      expect(pool.deficit.toString()).toBe("0");
      expect(pool.impaired).toBe(false);
      const event = await findEvent<{ total: BN; principal: BN; pending: BN }>(
        signature,
        "emergencyWithdrawn",
      );
      expect(big(event!.total)).toBe(820n * USDC);
      expect(big(event!.principal)).toBe(1_000n * USDC);
      expect(big(event!.pending)).toBe(100n * USDC);
    },
    TIMEOUT,
  );

  it(
    "pays active Principal, a pending deposit and a pending withdrawal together, and pays the queued part once",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await request(ctx, owner, 40n * USDC); // queued
      await deposit(ctx, owner, 50n * USDC); // pending
      const player = await fetchPlayer(ctx, owner);
      expect(big(player.principal)).toBe(150n * USDC);
      expect(big(player.pendingDeposit)).toBe(50n * USDC);
      expect(big(player.pendingWithdraw)).toBe(40n * USDC);

      await shutdown(ctx);
      const walletBefore = await balance(owner.tokenAccount);
      await emergencyMethod(ctx, owner).rpc();
      await assertSolvent(ctx);

      // 150, not 190: the 40 queued is part of the 150.
      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(150n * USDC);
      expect(await balance(ctx.principalVault)).toBe(0n);
      const after = await fetchPlayer(ctx, owner);
      for (const field of ["principal", "entries", "pendingDeposit", "pendingWithdraw"] as const) {
        expect(after[field].toString(), field).toBe("0");
      }
      const pool = await fetchPool(ctx);
      expect(pool.totalPrincipal.toString()).toBe("0");
      expect(pool.pendingWithdrawals.toString()).toBe("0");
    },
    TIMEOUT,
  );
});

describe("Tickets lost in the game", () => {
  it(
    "pays a Player who queued everything and then lost Tickets in a round their full Principal, and a re-deposit never lifts the pool's Tickets past the next reset",
    async () => {
      const ctx = await setupPool({ epochSeconds: 30, roundSeconds: 5, closeBuffer: 1 });
      const a = await ctx.fundedWallet(10n * USDC);
      const owner = a.keypair.publicKey;
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, 5n * USDC);
      await beginEpoch(ctx, 1n); // epoch 2: the 5 is active Tickets

      // A stakes 1 USDC of Tickets on tile 0 and loses it.
      const startsAt = await onChainNowSeconds();
      await program.methods
        .createRound(new BN(startsAt), new BN(startsAt + 5))
        .accountsPartial({
          operator: ctx.operator.publicKey,
          pool: ctx.pool,
          currentEpoch: epochPda(ctx.pool, 2n),
          round: roundPda(ctx.pool, 1n),
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.operator])
        .rpc();
      await program.methods
        .buyPosition(new BN(1), new BN((1n * USDC).toString()))
        .accountsPartial({
          owner,
          pool: ctx.pool,
          player: playerPda(ctx.pool, owner),
          round: roundPda(ctx.pool, 1n),
          position: positionPda(roundPda(ctx.pool, 1n), owner),
          systemProgram: SystemProgram.programId,
        })
        .signers([a.keypair])
        .rpc();
      expect(big((await fetchPlayer(ctx, a)).entries)).toBe(4n * USDC);

      // The Player queues all 5 while 4 of it is in Tickets. No Tickets rule.
      await request(ctx, a, 5n * USDC);

      const nonce = testNonce();
      const seed = vrfSeed("round", ctx.pool, 1n, nonce);
      await retryUntilOk(() =>
        program.methods
          .requestRoundRandomness(Array.from(nonce))
          .accountsPartial({
            payer: ctx.operator.publicKey,
            pool: ctx.pool,
            round: roundPda(ctx.pool, 1n),
            randomness: randomnessPda(seed),
            vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
            vrfTreasury: DEVNET_VRF_TREASURY,
            vrfProgram: ORAO_VRF_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([ctx.operator])
          .rpc(),
      );
      // Tile 7 wins, tile 0 does not.
      await program.methods
        .settleRound()
        .accountsPartial({
          caller: ctx.operator.publicKey,
          pool: ctx.pool,
          round: roundPda(ctx.pool, 1n),
          randomness: await fulfillRandomness(seed, randomnessFor(7)),
          house: ctx.house,
        })
        .signers([ctx.operator])
        .rpc();
      await program.methods
        .settlePosition()
        .accountsPartial({
          pool: ctx.pool,
          round: roundPda(ctx.pool, 1n),
          player: playerPda(ctx.pool, owner),
          owner,
          position: positionPda(roundPda(ctx.pool, 1n), owner),
        })
        .rpc();
      await assertSolvent(ctx);
      let player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(5n * USDC);
      expect(big(player.entries)).toBe(4n * USDC);
      expect(big(player.pendingWithdraw)).toBe(5n * USDC);

      // A deposits 5 more, a pending deposit that earns no Ticket today.
      // Tickets in the epoch stay at 4, under the 10 of Principal that the next
      // epoch's reset would give, so the loss was not refilled.
      await deposit(ctx, a, 5n * USDC);
      player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(10n * USDC);
      expect(big(player.entries)).toBe(4n * USDC);
      expect(await ticketsOf(ctx, owner, 2n)).toBe(4n * USDC);

      // Shutdown lets the request pay in this epoch. The queued 5 pays in full
      // although the Player holds 4 Tickets, and Tickets floor at zero.
      await shutdown(ctx);
      const walletBefore = await balance(a.tokenAccount);
      await processWithdraw(ctx, a);
      expect((await balance(a.tokenAccount)) - walletBefore).toBe(5n * USDC);
      player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(5n * USDC);
      expect(big(player.entries)).toBe(0n);
      expect(big(player.pendingWithdraw)).toBe(0n);
      expect(big(player.pendingDeposit)).toBe(5n * USDC);
      // A's Tickets never passed what the next reset gives: Principal.
      expect(await ticketsOf(ctx, owner, 2n)).toBe(0n);
      expect(await treePrincipal(ctx, a)).toBe(5n * USDC);

      // And the pending deposit leaves through emergency withdraw.
      const walletMid = await balance(a.tokenAccount);
      await emergencyMethod(ctx, a).rpc();
      await assertSolvent(ctx);
      expect((await balance(a.tokenAccount)) - walletMid).toBe(5n * USDC);
    },
    TIMEOUT,
  );
});

const ALL_TILES = (1n << 36n) - 1n;

/** A round that starts now and ends in 5 seconds, in epoch `epochId`. */
async function openRound(ctx: PoolCtx, roundId: bigint, epochId: bigint) {
  const startsAt = await onChainNowSeconds();
  await program.methods
    .createRound(new BN(startsAt), new BN(startsAt + 5))
    .accountsPartial({
      operator: ctx.operator.publicKey,
      pool: ctx.pool,
      currentEpoch: epochPda(ctx.pool, epochId),
      round: roundPda(ctx.pool, roundId),
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.operator])
    .rpc();
}

/** Stakes `stakePerTile` on every tile. */
async function stakeAll(ctx: PoolCtx, owner: Wallet, roundId: bigint, stakePerTile: bigint) {
  const key = owner.keypair.publicKey;
  await program.methods
    .buyPosition(new BN(ALL_TILES.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: key,
      pool: ctx.pool,
      player: playerPda(ctx.pool, key),
      round: roundPda(ctx.pool, roundId),
      position: positionPda(roundPda(ctx.pool, roundId), key),
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
  await assertSolvent(ctx);
}

/** Requests randomness once the round closes and settles it on `tile`. */
async function settleRoundOn(ctx: PoolCtx, roundId: bigint, tile: number) {
  const nonce = testNonce();
  const seed = vrfSeed("round", ctx.pool, roundId, nonce);
  await retryUntilOk(() =>
    program.methods
      .requestRoundRandomness(Array.from(nonce))
      .accountsPartial({
        payer: ctx.operator.publicKey,
        pool: ctx.pool,
        round: roundPda(ctx.pool, roundId),
        randomness: randomnessPda(seed),
        vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
        vrfTreasury: DEVNET_VRF_TREASURY,
        vrfProgram: ORAO_VRF_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([ctx.operator])
      .rpc(),
  );
  await program.methods
    .settleRound()
    .accountsPartial({
      caller: ctx.operator.publicKey,
      pool: ctx.pool,
      round: roundPda(ctx.pool, roundId),
      randomness: await fulfillRandomness(seed, randomnessFor(tile)),
      house: ctx.house,
    })
    .signers([ctx.operator])
    .rpc();
  await assertSolvent(ctx);
}

/** Anyone can settle a finished Position: the provider wallet pays, not the owner. */
async function settlePositionOf(ctx: PoolCtx, owner: Wallet, roundId: bigint) {
  const key = owner.keypair.publicKey;
  await program.methods
    .settlePosition()
    .accountsPartial({
      pool: ctx.pool,
      round: roundPda(ctx.pool, roundId),
      player: playerPda(ctx.pool, key),
      owner: key,
      position: positionPda(roundPda(ctx.pool, roundId), key),
    })
    .rpc();
  await assertSolvent(ctx);
}

describe("open Positions block the queued payout", () => {
  it(
    "refuses process_withdraw while a stake is on the board, pays after the settle, and leaves no Tickets behind",
    async () => {
      const ctx = await setupPool({ epochSeconds: 20, roundSeconds: 5, closeBuffer: 1 });
      const a = await ctx.fundedWallet(36n * USDC);
      const owner = a.keypair.publicKey;
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, 36n * USDC);
      await beginEpoch(ctx, 1n); // epoch 2: the 36 is active Tickets
      await request(ctx, a, 36n * USDC); // queue all
      await beginEpoch(ctx, 2n); // epoch 3: the request is due

      // Stake every Tile in epoch 3: the Tickets leave the Player and the tree.
      await openRound(ctx, 1n, 3n);
      await stakeAll(ctx, a, 1n, 1n * USDC);
      let player = await fetchPlayer(ctx, a);
      expect(big(player.entries)).toBe(0n);
      expect(player.openPositions).toBe(1);

      // Due, but refused with nothing changed, before and after the round settles.
      const poolBefore = await fetchPool(ctx);
      await refused(ctx, processMethod(ctx, a).rpc(), /OpenPositions/);
      await settleRoundOn(ctx, 1n, 7);
      await refused(ctx, processMethod(ctx, a).rpc(), /OpenPositions/);
      const poolAfter = await fetchPool(ctx);
      expect(big(poolAfter.totalPrincipal)).toBe(big(poolBefore.totalPrincipal));
      expect(big(poolAfter.pendingWithdrawals)).toBe(36n * USDC);
      expect(big((await fetchPlayer(ctx, a)).pendingWithdraw)).toBe(36n * USDC);

      // Anyone can settle it, and the stake comes home.
      await settlePositionOf(ctx, a, 1n);
      player = await fetchPlayer(ctx, a);
      expect(player.openPositions).toBe(0);
      // The stake and the winners' share of the pot, less the House cut.
      expect(big(player.entries) > 0n).toBe(true);

      const walletBefore = await balance(a.tokenAccount);
      await processWithdraw(ctx, a);
      expect((await balance(a.tokenAccount)) - walletBefore).toBe(36n * USDC);
      player =await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(0n);
      expect(big(player.entries)).toBe(0n);
      // No Tickets without Principal, in the Player or in the epoch's root.
      expect(await ticketsOf(ctx, owner, 3n)).toBe(0n);
      // What is left in the root is the House's cut of the round, not the Player's.
      const cut = big((await program.account.round.fetch(roundPda(ctx.pool, 1n))).houseCut);
      expect(await root(ctx, 3n)).toBe(cut);
      expect(await treePrincipal(ctx, a)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "keeps a Position left open from an earlier epoch blocking the payout until anyone settles it",
    async () => {
      const ctx = await setupPool({ epochSeconds: 20, roundSeconds: 5, closeBuffer: 1 });
      const a = await ctx.fundedWallet(36n * USDC);
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, 36n * USDC);
      await beginEpoch(ctx, 1n); // epoch 2
      await request(ctx, a, 36n * USDC);
      await beginEpoch(ctx, 2n); // epoch 3
      await openRound(ctx, 1n, 3n);
      await stakeAll(ctx, a, 1n, 1n * USDC);
      await settleRoundOn(ctx, 1n, 7);

      // Nobody settles it, and the epoch rolls on. The request is long due.
      await beginEpoch(ctx, 3n); // epoch 4
      expect((await fetchPlayer(ctx, a)).openPositions).toBe(1);
      await refused(ctx, processMethod(ctx, a).rpc(), /OpenPositions/);

      // A stranger's settle clears it. The stake is already back from the epoch
      // reset, so the settle credits only the winners' share of the pot.
      await settlePositionOf(ctx, a, 1n);
      const player = await fetchPlayer(ctx, a);
      expect(player.openPositions).toBe(0);
      expect(big(player.entries) > 36n * USDC).toBe(true);

      const walletBefore = await balance(a.tokenAccount);
      await processWithdraw(ctx, a);
      expect((await balance(a.tokenAccount)) - walletBefore).toBe(36n * USDC);
      const paid = await fetchPlayer(ctx, a);
      expect(big(paid.principal)).toBe(0n);
      expect(big(paid.pendingWithdraw)).toBe(0n);
      expect(paid.openPositions).toBe(0);
    },
    TIMEOUT,
  );
});

/** Builder for `cancel_withdraw`: `signer` signs, `playerOwner` picks the Player. */
function cancelMethod(ctx: PoolCtx, signer: Wallet, playerOwner: Wallet = signer) {
  return program.methods
    .cancelWithdraw()
    .accountsPartial({
      owner: signer.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, playerOwner.keypair.publicKey),
    })
    .signers([signer.keypair]);
}

async function cancel(ctx: PoolCtx, owner: Wallet) {
  const signature = await cancelMethod(ctx, owner).rpc();
  await assertSolvent(ctx);
  return signature;
}

interface WithdrawCancelledEvent {
  owner: PublicKey;
  amount: BN;
  pendingEpoch: BN;
}

/** Everything a cancel must leave alone. */
async function untouched(ctx: PoolCtx, owner: Wallet) {
  const player = await fetchPlayer(ctx, owner);
  const pool = await fetchPool(ctx);
  const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
  return {
    principal: big(player.principal),
    entries: big(player.entries),
    pendingDeposit: big(player.pendingDeposit),
    pendingEpoch: big(player.pendingEpoch),
    leaf: await treePrincipal(ctx, owner),
    root: await root(ctx, big(pool.currentEpochId)),
    totalPrincipal: big(pool.totalPrincipal),
    venueValue: big(pool.venueValue),
    deficit: big(pool.deficit),
    vault: await balance(ctx.principalVault),
    venueUsdc: await balance(ctx.venue.klendCtoken),
    shares: reserve.shares.toString(),
  };
}

/** Cancels `queued` and checks the Player's flag, the pool's reserve and that
 *  nothing else moved. Returns the event. */
async function cancelAndCheck(ctx: PoolCtx, owner: Wallet, queued: bigint, epoch: bigint) {
  expect(big((await fetchPlayer(ctx, owner)).pendingWithdraw)).toBe(queued);
  const reservedBefore = big((await fetchPool(ctx)).pendingWithdrawals);
  const before = await untouched(ctx, owner);
  const signature = await cancel(ctx, owner);
  expect(await untouched(ctx, owner)).toEqual(before);
  expect(big((await fetchPlayer(ctx, owner)).pendingWithdraw)).toBe(0n);
  expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(reservedBefore - queued);
  const event = await findEvent<WithdrawCancelledEvent>(signature, "withdrawCancelled");
  expect(event!.owner.toBase58()).toBe(owner.keypair.publicKey.toBase58());
  expect(big(event!.amount)).toBe(queued);
  expect(big(event!.pendingEpoch)).toBe(epoch);
  return event!;
}

describe("cancel_withdraw", () => {
  it(
    "refuses anyone but the owner, then zeroes the flag, lowers the reserve by exactly that amount and moves nothing else",
    async () => {
      const { ctx, owner } = await activePool(1_000n * USDC, 900n * USDC);
      await request(ctx, owner, 400n * USDC);
      const stranger = await ctx.fundedWallet(1n);

      // A stranger signing for the owner's Player fails the Player's seeds.
      const before = await untouched(ctx, owner);
      await refused(ctx, cancelMethod(ctx, stranger, owner).rpc(), /ConstraintSeeds/);
      expect(await untouched(ctx, owner)).toEqual(before);
      expect(big((await fetchPlayer(ctx, owner)).pendingWithdraw)).toBe(400n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(400n * USDC);

      await cancelAndCheck(ctx, owner, 400n * USDC, 2n);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "fails with NothingPending when nothing is queued, before any request and after a cancel",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await refused(ctx, cancelMethod(ctx, owner).rpc(), /NothingPending/);
      await request(ctx, owner, 40n * USDC);
      await cancel(ctx, owner);
      await refused(ctx, cancelMethod(ctx, owner).rpc(), /NothingPending/);
    },
    TIMEOUT,
  );

  it(
    "cancels one merged amount for two requests in an epoch",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await request(ctx, owner, 30n * USDC);
      await request(ctx, owner, 20n * USDC);
      await cancelAndCheck(ctx, owner, 50n * USDC, 2n);
    },
    TIMEOUT,
  );

  it(
    "lets the Player request the full Principal in the same epoch afterwards, and leaves nothing for process_withdraw to pay",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await request(ctx, owner, 60n * USDC);
      await cancelAndCheck(ctx, owner, 60n * USDC, 2n);

      // Same epoch, and the whole Principal is askable again.
      await request(ctx, owner, 100n * USDC);
      const player = await fetchPlayer(ctx, owner);
      expect(big(player.pendingWithdraw)).toBe(100n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(100n * USDC);
      await cancel(ctx, owner);

      // The cancelled request pays nothing, even once it would have been due.
      await beginEpoch(ctx, 2n);
      const walletBefore = await balance(owner.tokenAccount);
      await refused(ctx, processMethod(ctx, owner).rpc(), /NothingPending/);
      expect(await balance(owner.tokenAccount)).toBe(walletBefore);
      expect(big((await fetchPlayer(ctx, owner)).principal)).toBe(100n * USDC);
    },
    TIMEOUT,
  );

  it(
    "gives the cancelled amount back to free idle, so a deploy the reservation blocked goes through",
    async () => {
      // 1,000 in the vault, all of it queued: free idle is nothing.
      const { ctx, owner } = await activePool(1_000n * USDC, 0n);
      await request(ctx, owner, 1_000n * USDC);
      await waitPastLastSync(ctx);
      await refused(ctx, deployMethod(ctx, 100n * USDC).rpc(), /DeployExceedsIdle/);

      await cancel(ctx, owner);
      // Vault 1,000 and nothing reserved: free idle is the whole 1,000, so 900
      // can leave above the 10% idle target.
      await waitPastLastSync(ctx);
      await deployMethod(ctx, 900n * USDC).rpc();
      await assertSolvent(ctx);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);
      expect(big((await fetchPool(ctx)).venueValue)).toBe(900n * USDC);
    },
    TIMEOUT,
  );

  it(
    "works while the pool is paused",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await request(ctx, owner, 40n * USDC);
      await program.methods
        .setPause(true)
        .accountsPartial({ signer: ctx.admin.publicKey, pool: ctx.pool })
        .signers([ctx.admin])
        .rpc();
      expect((await fetchPool(ctx)).paused).toBe(true);
      await cancelAndCheck(ctx, owner, 40n * USDC, 2n);
    },
    TIMEOUT,
  );

  it(
    "works while the pool is shut down",
    async () => {
      const { ctx, owner } = await activePool(100n * USDC, 0n);
      await request(ctx, owner, 40n * USDC);
      await shutdown(ctx);
      expect((await fetchPool(ctx)).shutdown).toBe(true);
      await cancelAndCheck(ctx, owner, 40n * USDC, 2n);
    },
    TIMEOUT,
  );

  it(
    "works while the pool is impaired, and the Player keeps the same Principal and exposure",
    async () => {
      const { ctx, owner } = await activePool(1_000n * USDC, 900n * USDC);
      await request(ctx, owner, 500n * USDC);
      await reprice(ctx, (8n * SCALE) / 10n);
      expect((await fetchPool(ctx)).impaired).toBe(true);
      await cancelAndCheck(ctx, owner, 500n * USDC, 2n);
      const pool = await fetchPool(ctx);
      expect(pool.impaired).toBe(true);
      expect(big(pool.deficit)).toBe(180n * USDC);
      expect(big((await fetchPlayer(ctx, owner)).principal)).toBe(1_000n * USDC);
    },
    TIMEOUT,
  );

  it(
    "works with a Position open",
    async () => {
      const ctx = await setupPool({ epochSeconds: 30, roundSeconds: 5, closeBuffer: 1 });
      const a = await ctx.fundedWallet(36n * USDC);
      await beginEpoch(ctx, 0n); // epoch 1
      await deposit(ctx, a, 36n * USDC);
      await beginEpoch(ctx, 1n); // epoch 2: the 36 is active Tickets
      await request(ctx, a, 36n * USDC);
      await openRound(ctx, 1n, 2n);
      await stakeAll(ctx, a, 1n, 1n * USDC);
      expect((await fetchPlayer(ctx, a)).openPositions).toBe(1);

      await cancelAndCheck(ctx, a, 36n * USDC, 2n);
      const player = await fetchPlayer(ctx, a);
      expect(player.openPositions).toBe(1);
      expect(big(player.principal)).toBe(36n * USDC);
    },
    TIMEOUT,
  );
});

describe("the instruction set", () => {
  it("has no instant_withdraw", () => {
    // The raw IDL: `Program` camel-cases the names it keeps.
    const names = idl.instructions.map((ix) => ix.name);
    expect(names).toContain("request_withdraw");
    expect(names).toContain("process_withdraw");
    expect(names).toContain("cancel_withdraw");
    expect(names).not.toContain("instant_withdraw");
  });
});
