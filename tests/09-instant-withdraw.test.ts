// Instant withdraw (yield-claimer ticket 09; spec "Withdraw (instant)", ADR
// 0017). The owner is paid in the same transaction. Free idle is the vault
// balance minus Pending withdrawals; a gap above it is redeemed from the venue
// inside the instruction. Every pool runs against the test-venue stub, where
// `rate` is USDC per share scaled by 1e18.
//
// Amounts are 6-decimal USDC atomic units. Defaults: a 100 USDC minimum venue
// move, a 10% idle target, a 10% Yield fee. `assertSolvent` runs after every
// instruction here, refused ones included.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  deployToVenue,
  epochPda,
  fetchTree,
  findEvent,
  grantTicketsAsAdmin,
  fulfillRandomness,
  onChainNowSeconds,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessFor,
  randomnessPda,
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
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 120_000;
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

// A deposit earns no Ticket until the next epoch (ADR 0020), and an instant
// withdraw needs Tickets of at least the amount, so `deposit` has the Admin
// grant the Tickets a player would hold from yesterday. `depositOnly` is the
// bare instruction. Ticket 22 removes the instant withdraw and this suite.
async function deposit(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await depositOnly(ctx, owner, amount);
  await grantTicketsAsAdmin(ctx, owner.keypair.publicKey, amount);
  return signature;
}

async function depositOnly(ctx: PoolCtx, owner: Wallet, amount: bigint) {
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

async function requestWithdraw(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      ...ctx.venue,
    })
    .signers([owner.keypair])
    .rpc();
  await assertSolvent(ctx);
}

async function processWithdraw(ctx: PoolCtx, owner: Wallet) {
  await program.methods
    .processWithdraw()
    .accountsPartial({
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  await assertSolvent(ctx);
}

/** Builder for `instant_withdraw`. `signer` and `owner` differ only in the
 *  wrong-signer test. */
function instantMethod(ctx: PoolCtx, owner: Wallet, amount: bigint, signer: Wallet = owner) {
  return program.methods
    .instantWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: signer.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: signer.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer.keypair]);
}

async function instantWithdraw(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await instantMethod(ctx, owner, amount).rpc();
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

async function setRate(ctx: PoolCtx, rate: bigint) {
  await setVenueRate(ctx, rate).rpc();
  await assertSolvent(ctx);
}

/** Puts the USDC a rate rise is worth into the stub vault. The operator is the
 *  mint authority. */
async function fundStub(ctx: PoolCtx, amount: bigint) {
  await mintTo(provider.connection, ctx.operator, ctx.mint, ctx.venue.klendCtoken, ctx.operator, amount);
  await assertSolvent(ctx);
}

/** One Player with `amount` deposited, 90% of it deployed: the vault keeps the
 *  10% idle target and the stub holds the rest. */
async function deployedPool(amount: bigint, overrides: Parameters<typeof setupPool>[0] = {}) {
  const ctx = await setupPool(overrides);
  const owner = await ctx.fundedWallet(amount);
  await deposit(ctx, owner, amount);
  await deploy(ctx, (amount * 9n) / 10n);
  return { ctx, owner };
}

/** Yield that `settle` would add to `player` at the pool's current index. */
function unsettled(
  pool: { yieldIndex: { toString(): string } },
  player: { principal: { toString(): string }; yieldIndex: { toString(): string } },
): bigint {
  return (big(player.principal) * (big(pool.yieldIndex) - big(player.yieldIndex))) / SCALE;
}

interface InstantEvent {
  amount: BN;
  redeemed: BN;
  settled: BN;
  principal: BN;
  entries: BN;
}

describe("instant withdraw", () => {
  it(
    "pays from free idle in one transaction and does not touch the venue",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);
      const walletBefore = await balance(owner.tokenAccount);
      const sharesBefore = (await program.account.testReserve.fetch(ctx.venue.klendReserve)).shares;

      const signature = await instantWithdraw(ctx, owner, 60n * USDC);

      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(60n * USDC);
      expect(await balance(ctx.principalVault)).toBe(40n * USDC);
      expect(await balance(ctx.venue.klendCtoken)).toBe(900n * USDC);
      const reserve = await program.account.testReserve.fetch(ctx.venue.klendReserve);
      expect(reserve.shares.toString()).toBe(sharesBefore.toString());

      const player = await fetchPlayer(ctx, owner);
      expect(player.principal.toString()).toBe((940n * USDC).toString());
      expect(player.entries.toString()).toBe((940n * USDC).toString());
      const pool = await fetchPool(ctx);
      expect(pool.totalPrincipal.toString()).toBe((940n * USDC).toString());
      expect(pool.venueValue.toString()).toBe((900n * USDC).toString());

      const event = await findEvent<InstantEvent>(signature, "instantWithdrawn");
      expect(event?.amount.toString()).toBe((60n * USDC).toString());
      expect(event?.redeemed.toString()).toBe("0");
      expect(event?.principal.toString()).toBe((940n * USDC).toString());
    },
    TIMEOUT,
  );

  it(
    "redeems the gap from the venue when free idle is short and pays in the same transaction",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      const walletBefore = await balance(owner.tokenAccount);

      // 100 idle, 300 asked: the other 200 comes out of the venue.
      const signature = await instantWithdraw(ctx, owner, 300n * USDC);

      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(300n * USDC);
      expect(await balance(ctx.principalVault)).toBe(0n);
      expect(await balance(ctx.venue.klendCtoken)).toBe(700n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.venueValue.toString()).toBe((700n * USDC).toString());
      expect(pool.venueValue.toString()).toBe((await stubVenueValue(ctx)).toString());
      expect(pool.totalPrincipal.toString()).toBe((700n * USDC).toString());
      const event = await findEvent<InstantEvent>(signature, "instantWithdrawn");
      expect(event?.redeemed.toString()).toBe((200n * USDC).toString());

      // The redeem was booked, so the next sync sees neither a gain nor a loss.
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);
      const after = await fetchPool(ctx);
      expect(after.venueValue.toString()).toBe(pool.venueValue.toString());
      for (const field of ["feeOwed", "yieldOwed", "prizeOwed", "yieldIndex"] as const) {
        expect(after[field].toString(), field).toBe("0");
      }
    },
    TIMEOUT,
  );

  it(
    "fails with a named error when the venue cannot cover the gap, changes nothing, and leaves the queued request open",
    async () => {
      // 100% APR so a couple of seconds of yield is a few dozen units.
      const { ctx, owner } = await deployedPool(1_000n * USDC, { baseRateBps: 10_000 });
      // The venue triples on paper but its USDC stays at 900: the position is
      // worth 2,700 and can return 900.
      await setRate(ctx, 3n * SCALE);
      await waitPastLastSync(ctx);
      const before = await fetchPool(ctx);
      const playerBefore = await fetchPlayer(ctx, owner);
      const vaultBefore = await balance(ctx.principalVault);
      const walletBefore = await balance(owner.tokenAccount);

      // Settled yield lifts the Principal past 1,000, so this is 900 plus a
      // few units after the 100 idle: more than the stub holds.
      await refused(ctx, instantMethod(ctx, owner, 1_000n * USDC + 1n).rpc(), /VenueIlliquid/);

      const after = await fetchPool(ctx);
      for (const field of ["totalPrincipal", "venueValue", "yieldIndex", "yieldOwed", "lastSyncAt"] as const) {
        expect(after[field].toString(), field).toBe(before[field].toString());
      }
      expect((await fetchPlayer(ctx, owner)).principal.toString()).toBe(playerBefore.principal.toString());
      expect(await balance(ctx.principalVault)).toBe(vaultBefore);
      expect(await balance(owner.tokenAccount)).toBe(walletBefore);

      // What a smaller instant withdrawal can cover still goes through, and
      // the queued request is open for the rest.
      await instantWithdraw(ctx, owner, 500n * USDC);
      await requestWithdraw(ctx, owner, 400n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(400n * USDC);
    },
    TIMEOUT,
  );

  it(
    "never spends USDC held for Pending withdrawals",
    async () => {
      const ctx = await setupPool();
      const a = await ctx.fundedWallet(1_000n * USDC);
      const b = await ctx.fundedWallet(500n * USDC);
      await deposit(ctx, a, 1_000n * USDC);
      await deposit(ctx, b, 500n * USDC);
      await deploy(ctx, 1_350n * USDC);
      // Vault 150. B queues 100: free idle is 50.
      await requestWithdraw(ctx, b, 100n * USDC);
      expect(await balance(ctx.principalVault)).toBe(150n * USDC);

      // 300 asked against 50 free idle: 250 redeemed, and the vault ends at
      // exactly what is queued.
      await instantWithdraw(ctx, a, 300n * USDC);
      const pool = await fetchPool(ctx);
      expect(pool.pendingWithdrawals.toString()).toBe((100n * USDC).toString());
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);

      // B's queued payout is still there to be made.
      await program.methods
        .shutdown()
        .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
        .signers([ctx.admin])
        .rpc();
      const walletBefore = await balance(b.tokenAccount);
      await processWithdraw(ctx, b);
      expect((await balance(b.tokenAccount)) - walletBefore).toBe(100n * USDC);
    },
    TIMEOUT,
  );

  it(
    "pays yield earned up to that second, and a Player who never played leaves with their whole Principal",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC, { baseRateBps: 10_000 });
      await setRate(ctx, (12n * SCALE) / 10n); // 900 shares are now worth 1,080
      await fundStub(ctx, 180n * USDC);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);

      // The sync booked the gain. The rate does not move with time, so the
      // withdrawal's own sync adds nothing and the figure below is exact.
      const pool = await fetchPool(ctx);
      const player = await fetchPlayer(ctx, owner);
      const owed = unsettled(pool, player);
      expect(owed > 0n).toBe(true);
      const whole = big(player.principal) + owed;
      expect(whole > 1_000n * USDC).toBe(true);

      const walletBefore = await balance(owner.tokenAccount);
      const signature = await instantWithdraw(ctx, owner, whole);

      expect((await balance(owner.tokenAccount)) - walletBefore).toBe(whole);
      const event = await findEvent<InstantEvent>(signature, "instantWithdrawn");
      expect(event?.settled.toString()).toBe(owed.toString());
      const after = await fetchPlayer(ctx, owner);
      expect(after.principal.toString()).toBe("0");
      expect(after.entries.toString()).toBe("0");
      expect((await fetchPool(ctx)).totalPrincipal.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "needs Tickets of at least the amount, and a Player who lost Tickets cannot refill them by withdrawing and depositing again",
    async () => {
      const ctx = await setupPool({ roundSeconds: 5, closeBuffer: 1 });
      const a = await ctx.fundedWallet(10n * USDC);
      await deposit(ctx, a, 5n * USDC);

      // A stakes 1 USDC of Tickets on tile 0 in epoch 0.
      const startsAt = await onChainNowSeconds();
      await program.methods
        .createRound(new BN(startsAt), new BN(startsAt + 5))
        .accountsPartial({
          operator: ctx.operator.publicKey,
          pool: ctx.pool,
          currentEpoch: epochPda(ctx.pool, 0n),
          round: roundPda(ctx.pool, 1n),
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.operator])
        .rpc();
      await program.methods
        .buyPosition(new BN(1), new BN((1n * USDC).toString()))
        .accountsPartial({
          owner: a.keypair.publicKey,
          pool: ctx.pool,
          player: playerPda(ctx.pool, a.keypair.publicKey),
          round: roundPda(ctx.pool, 1n),
          position: positionPda(roundPda(ctx.pool, 1n), a.keypair.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([a.keypair])
        .rpc();
      expect(big((await fetchPlayer(ctx, a)).entries)).toBe(4n * USDC);

      // 5 of Principal, 4 of Tickets: all 5 is refused with the named error and
      // changes nothing, and the Player's balances stay as they were.
      await refused(ctx, instantMethod(ctx, a, 5n * USDC).rpc(), /InsufficientTickets/);
      const stuck = await fetchPlayer(ctx, a);
      expect(big(stuck.principal)).toBe(5n * USDC);
      expect(big(stuck.entries)).toBe(4n * USDC);

      // Tile 0 does not win, so the stake is lost.
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
          player: playerPda(ctx.pool, a.keypair.publicKey),
          owner: a.keypair.publicKey,
          position: positionPda(roundPda(ctx.pool, 1n), a.keypair.publicKey),
        })
        .rpc();
      await assertSolvent(ctx);
      const lost = await fetchPlayer(ctx, a);
      expect(big(lost.principal)).toBe(5n * USDC);
      expect(big(lost.entries)).toBe(4n * USDC);

      // The Tickets A has leave with 4 of the Principal. The 5th unit of
      // Principal has no Ticket behind it.
      await instantWithdraw(ctx, a, 4n * USDC);
      await refused(ctx, instantMethod(ctx, a, 1n * USDC).rpc(), /InsufficientTickets/);

      // Depositing the 4 back gives no Ticket today (it is pending until the
      // next epoch), so A holds none against the 4 it just took out.
      await depositOnly(ctx, a, 4n * USDC);
      const again = await fetchPlayer(ctx, a);
      expect(big(again.principal)).toBe(5n * USDC);
      expect(big(again.entries)).toBe(0n);
      // The first deposit's pending amount is still there, clamped to what
      // Principal the instant exit left (1), plus these 4.
      expect(big(again.pendingDeposit)).toBe(5n * USDC);

      // The queued request still takes the Principal that has no Ticket.
      await requestWithdraw(ctx, a, 1n * USDC);
      expect(big((await fetchPool(ctx)).pendingWithdrawals)).toBe(1n * USDC);
    },
    TIMEOUT,
  );

  it(
    "refuses zero, more than the Principal, and a signer who does not own the Player",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      const other = await ctx.fundedWallet(10n * USDC);

      await refused(ctx, instantMethod(ctx, owner, 0n).rpc(), /ZeroAmount/);
      await refused(ctx, instantMethod(ctx, owner, 1_000n * USDC + 1n).rpc(), /InsufficientPrincipal/);
      // `other` signs for `owner`'s Player: the Player PDA is seeded by the signer.
      await refused(ctx, instantMethod(ctx, owner, 10n * USDC, other).rpc(), /ConstraintSeeds|AccountNotInitialized/);
      expect(big((await fetchPlayer(ctx, owner)).principal)).toBe(1_000n * USDC);
    },
    TIMEOUT,
  );

  it(
    "leaves no Tickets in the tree when a deposit and an instant exit fall inside one epoch",
    async () => {
      const ctx = await setupPool({ epochSeconds: 120 });
      const a = await ctx.fundedWallet(10n * USDC);
      await program.methods
        .beginEpoch()
        .accountsPartial({
          operator: ctx.operator.publicKey,
          pool: ctx.pool,
          currentEpoch: epochPda(ctx.pool, 0n),
          epochTwoBehind: epochPda(ctx.pool, 0n),
          newEpoch: epochPda(ctx.pool, 1n),
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.operator])
        .rpc();

      await deposit(ctx, a, 5n * USDC);
      await instantWithdraw(ctx, a, 5n * USDC);

      expect(await ticketsOf(ctx, a.keypair.publicKey, 1n)).toBe(0n);
      expect(big((await fetchPlayer(ctx, a)).principal)).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "is allowed while the pool is paused and refused after Shutdown",
    async () => {
      const { ctx, owner } = await deployedPool(1_000n * USDC);
      await program.methods
        .setPause(true)
        .accountsPartial({ signer: ctx.admin.publicKey, pool: ctx.pool })
        .signers([ctx.admin])
        .rpc();
      // Paused: a deposit is refused, an instant exit is not.
      await refused(ctx, deposit(ctx, owner, 1n * USDC), /PoolPaused|insufficient funds/);
      await instantWithdraw(ctx, owner, 150n * USDC);

      await program.methods
        .shutdown()
        .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
        .signers([ctx.admin])
        .rpc();
      await refused(ctx, instantMethod(ctx, owner, 10n * USDC).rpc(), /PoolShutDown/);
    },
    TIMEOUT,
  );

  it(
    "leaves another depositor's Principal, unsettled yield and the index unchanged",
    async () => {
      const ctx = await setupPool({ baseRateBps: 10_000 });
      const a = await ctx.fundedWallet(1_000n * USDC);
      const b = await ctx.fundedWallet(500n * USDC);
      await deposit(ctx, a, 1_000n * USDC);
      await deposit(ctx, b, 500n * USDC);
      await deploy(ctx, 1_350n * USDC);
      await setRate(ctx, (11n * SCALE) / 10n);
      await fundStub(ctx, 135n * USDC);
      await waitPastLastSync(ctx);
      await testSyncMethod(ctx).rpc();
      await assertSolvent(ctx);

      const poolBefore = await fetchPool(ctx);
      const bBefore = await fetchPlayer(ctx, b);
      const owedBefore = unsettled(poolBefore, bBefore);
      expect(owedBefore > 0n).toBe(true);

      // A's exit redeems from the venue and settles A. B is untouched.
      await instantWithdraw(ctx, a, 400n * USDC);

      const poolAfter = await fetchPool(ctx);
      const bAfter = await fetchPlayer(ctx, b);
      expect(poolAfter.yieldIndex.toString()).toBe(poolBefore.yieldIndex.toString());
      for (const field of ["principal", "entries", "yieldIndex", "leafIndex"] as const) {
        expect(bAfter[field].toString(), field).toBe(bBefore[field].toString());
      }
      expect(unsettled(poolAfter, bAfter)).toBe(owedBefore);
    },
    TIMEOUT,
  );
});

describe("instant withdraw compute", () => {
  it(
    "measures an instant withdraw with a redeem against a small tree and a 16,384-node tree",
    async () => {
      const TARGET = 16_384;
      const units = async (signature: string) => (await txInfo(signature)).units;

      // Small tree: 1,000 USDC in, 900 deployed. 60 is paid from free idle; 300
      // then finds 40 idle and redeems 260.
      const small = await deployedPool(1_000n * USDC);
      const smallIdle = await units(await instantWithdraw(small.ctx, small.owner, 60n * USDC));
      const smallRedeem = await units(await instantWithdraw(small.ctx, small.owner, 300n * USDC));

      // 16,384 leaves, and the Player on leaf 2, whose update path is the longest
      // (14 entries). Once an epoch turns every slot on it is stale, so the
      // debit resets all of them.
      const ctx = await setupPool({ epochSeconds: 20 });
      const a = await ctx.fundedWallet(1_000n * USDC);
      const filler = Keypair.generate();
      for (let i = 0; i < 2; i += 1) {
        const sig = await provider.connection.requestAirdrop(filler.publicKey, 10_000_000_000);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }
      const beginEpoch = (current: bigint) =>
        program.methods
          .beginEpoch()
          .accountsPartial({
            operator: ctx.operator.publicKey,
            pool: ctx.pool,
            currentEpoch: epochPda(ctx.pool, current),
            epochTwoBehind: epochPda(ctx.pool, current > 0n ? current - 1n : 0n),
            newEpoch: epochPda(ctx.pool, current + 1n),
            systemProgram: SystemProgram.programId,
          })
          .signers([ctx.operator])
          .rpc();
      await beginEpoch(0n);
      await deposit(ctx, a, 1_000n * USDC);
      await deploy(ctx, 900n * USDC);

      // House and a are leaves 1 and 2; fillers bring it to 16,384.
      let nodes = (await fetchTree(ctx)).nodes.length;
      while (nodes < TARGET) {
        const count = Math.min(142, TARGET - nodes);
        await program.methods
          .testTreeFill(count)
          .accountsPartial({
            payer: filler.publicKey,
            pool: ctx.pool,
            weightTree: ctx.weightTree,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
          .signers([filler])
          .rpc();
        nodes += count;
      }
      expect((await fetchTree(ctx)).nodes.length).toBe(TARGET);

      await retryUntilOk(() => beginEpoch(1n));
      await retryUntilOk(() => beginEpoch(2n));
      // 100 idle, 200 asked: 100 comes out of the stub.
      const bigRedeem = await units(await instantWithdraw(ctx, a, 200n * USDC));

      console.log(
        `COMPUTE instant_withdraw(free idle only, small tree)=${smallIdle} ` +
          `instant_withdraw(redeem, small tree)=${smallRedeem} ` +
          `instant_withdraw(redeem, ${TARGET} nodes, leaf 2, first write of epoch)=${bigRedeem}`,
      );
      expect(smallRedeem).toBeLessThan(200_000);
      expect(bigRedeem).toBeLessThan(200_000);
    },
    900_000,
  );
});
