// Redeem dust (audit ticket 04). Dust is the value a redeem made vanish beyond
// what the vault received, floored at zero, and the fee owed bears it. Recall,
// harvest and the refund in request_withdraw all redeem. At the stub's
// overshoot rate a redeem of `n` delivers `n + 1`, as klend's does, and the
// value falls by that same `n + 1`: no value vanished, so no dust. Charging
// `fall - n` instead would take a unit off the fee owed for nothing.
//
// The asked amounts are odd, so `n + 1` is even and splits evenly into shares
// at a rate of 2.0: the value falls by exactly what arrives.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  deployToVenue,
  harvestMethod,
  playerPda,
  program,
  provider,
  recallMethod,
  refundAccounts,
  setupPool,
  setVenueRate,
  testSyncMethod,
  waitPastLastSync,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;
const USDC = 1_000_000n;
const OVERSHOOT_RATE = 2n * 10n ** 18n + 1n; // the stub's OVERSHOOT_RATE

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const balance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

/** 10,000 USDC deposited (all Pending, epoch 0), 9,000 deployed, then the rate
 *  doubles so a fee is owed and booked. The stub vault is funded for the gain. */
async function gainedPool() {
  // Base rate 0: no Depositor share, so the fee and the prize split the gain.
  const ctx = await setupPool({ baseRateBps: 0 });
  const owner = await ctx.fundedWallet(10_000n * USDC);
  await program.methods
    .deposit(new BN((10_000n * USDC).toString()))
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
  await waitPastLastSync(ctx);
  await deployToVenue(ctx, 9_000n * USDC - 1n); // an odd gain, so an odd owed
  await setVenueRate(ctx, OVERSHOOT_RATE).rpc();
  await mintTo(
    provider.connection,
    ctx.operator,
    ctx.mint,
    ctx.venue.klendCtoken,
    ctx.operator,
    9_000n * USDC,
  );
  await waitPastLastSync(ctx);
  await testSyncMethod(ctx).rpc();
  await assertSolvent(ctx);
  await waitPastLastSync(ctx);
  return { ctx, owner };
}

describe("redeem dust", () => {
  it(
    "recall charges no dust when the vault received what the value fell by",
    async () => {
      const { ctx } = await gainedPool();
      const pool = await fetchPool(ctx);
      const vault = await balance(ctx.principalVault);
      expect(big(pool.feeOwed) > 0n).toBe(true);

      await recallMethod(ctx, 100n * USDC + 1n).rpc();
      await assertSolvent(ctx);

      const received = (await balance(ctx.principalVault)) - vault;
      expect(received).toBe(100n * USDC + 2n);
      const after = await fetchPool(ctx);
      expect(big(pool.venueValue) - big(after.venueValue)).toBe(received);
      expect(after.feeOwed.toString()).toBe(pool.feeOwed.toString());
    },
    TIMEOUT,
  );

  it(
    "harvest pays the whole fee when the vault received what the value fell by",
    async () => {
      const { ctx } = await gainedPool();
      const pool = await fetchPool(ctx);
      const owed = big(pool.feeOwed) + big(pool.prizeOwed);
      // Odd, so `owed + 1` is even and the fall equals what arrives.
      expect(owed % 2n).toBe(1n);
      const treasury = await balance(ctx.treasury);

      await harvestMethod(ctx, ctx.treasury).rpc();
      await assertSolvent(ctx);

      expect((await balance(ctx.treasury)) - treasury).toBe(big(pool.feeOwed));
    },
    TIMEOUT,
  );

  it(
    "a refund that redeems charges no dust when the vault received what the value fell by",
    async () => {
      const { ctx, owner } = await gainedPool();
      const fee = (await fetchPool(ctx)).feeOwed.toString();
      const wallet = await balance(owner.tokenAccount);

      // Vault 1,000 and a unit, so the refund redeems an odd gap.
      await program.methods
        .requestWithdraw(new BN((1_500n * USDC).toString()))
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

      expect((await balance(owner.tokenAccount)) - wallet).toBe(1_500n * USDC);
      expect((await fetchPool(ctx)).feeOwed.toString()).toBe(fee);
    },
    TIMEOUT,
  );
});
