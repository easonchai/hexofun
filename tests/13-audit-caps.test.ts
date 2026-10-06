// Bought and Granted ticket caps count locked Principal (audit-fixes ticket
// 01): Principal less the Pending deposit. A Pending deposit refunds on
// request, so it cannot back Tickets. The pool-wide Operator grant cap reads
// `epoch_start_principal`, fixed when the epoch begins.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  epochPda,
  playerPda,
  program,
  provider,
  refundAccounts,
  retryUntilOk,
  setupPool,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 240_000;
const M = 1_000_000n;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const bn = (n: bigint) => new BN(n.toString());
const fetchPool = (ctx: PoolCtx) => program.account.pool.fetch(ctx.pool);
const fetchPlayer = (ctx: PoolCtx, owner: Wallet) =>
  program.account.player.fetch(playerPda(ctx.pool, owner.keypair.publicKey));

function depositMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .deposit(bn(amount))
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
    .signers([owner.keypair]);
}

function buyMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .buyTickets(bn(amount))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      jackpotVault: ctx.jackpotVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner.keypair]);
}

function requestMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(bn(amount))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      ...refundAccounts(ctx, owner),
      ...ctx.venue,
    })
    .signers([owner.keypair]);
}

function grantMethod(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .grantTickets(bn(amount))
    .accountsPartial({
      signer: ctx.operator.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
    })
    .signers([ctx.operator]);
}

async function deposit(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await depositMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
}

async function buy(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await buyMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
}

async function grant(ctx: PoolCtx, owner: Wallet, amount: bigint) {
  await grantMethod(ctx, owner, amount).rpc();
  await assertSolvent(ctx);
}

async function beginEpoch(ctx: PoolCtx, currentEpochId: bigint) {
  await program.methods
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
    .rpc();
  await assertSolvent(ctx);
}

/** A refused call changes nothing, so solvency must still hold. */
async function refused(ctx: PoolCtx, call: Promise<unknown>, error: RegExp) {
  await expect(call).rejects.toThrow(error);
  await assertSolvent(ctx);
}

describe("buy and grant caps count locked Principal", () => {
  it(
    "refuses deposit, buy, request in one transaction at the buy, and lets Principal from an earlier epoch buy after a deposit today",
    async () => {
      const ctx = await setupPool({ epochSeconds: 8 });
      const a = await ctx.fundedWallet(20n * M);
      const attacker = await ctx.fundedWallet(20n * M);
      await beginEpoch(ctx, 0n); // epoch 1

      // The audit's sequence, as one transaction, on an empty Player.
      const flash = new Transaction().add(
        await depositMethod(ctx, attacker, 5n * M).instruction(),
        await buyMethod(ctx, attacker, 5n * M).instruction(),
        await requestMethod(ctx, attacker, 5n * M).instruction(),
      );
      await refused(ctx, provider.sendAndConfirm(flash, [attacker.keypair]), /DailyBuyCapExceeded/);

      // Deposit in epoch 1, then more in epoch 2: only the first is locked.
      await deposit(ctx, a, 4n * M);
      await retryUntilOk(() => beginEpoch(ctx, 1n)); // epoch 2
      await deposit(ctx, a, 3n * M);
      const player = await fetchPlayer(ctx, a);
      expect(big(player.principal)).toBe(7n * M);
      expect(big(player.pendingDeposit)).toBe(3n * M);

      await refused(ctx, buyMethod(ctx, a, 4n * M + 1n).rpc(), /DailyBuyCapExceeded/);
      await buy(ctx, a, 4n * M);
      await refused(ctx, buyMethod(ctx, a, 1n).rpc(), /DailyBuyCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "refuses an Operator grant for a Player whose only Principal is pending, and the pool-wide cap does not move when another wallet deposits mid-epoch",
    async () => {
      const ctx = await setupPool({ epochSeconds: 8, bonusCapBps: 5_000 });
      const a = await ctx.fundedWallet(20n * M);
      const b = await ctx.fundedWallet(20n * M);
      const c = await ctx.fundedWallet(20n * M);
      await beginEpoch(ctx, 0n); // epoch 1
      expect(big((await fetchPool(ctx)).epochStartPrincipal)).toBe(0n);

      await deposit(ctx, a, 4n * M);
      await deposit(ctx, c, 4n * M);
      await refused(ctx, grantMethod(ctx, a, 1n).rpc(), /DailyPlayerGrantCapExceeded/);

      await retryUntilOk(() => beginEpoch(ctx, 1n)); // epoch 2
      const start = big((await fetchPool(ctx)).totalPrincipal);
      expect(big((await fetchPool(ctx)).epochStartPrincipal)).toBe(start);

      // A deposit now widens total_principal and nothing else.
      await deposit(ctx, b, 8n * M);
      const pool = await fetchPool(ctx);
      expect(big(pool.totalPrincipal)).toBe(start + 8n * M);
      expect(big(pool.epochStartPrincipal)).toBe(start);
      await refused(ctx, grantMethod(ctx, b, 1n).rpc(), /DailyPlayerGrantCapExceeded/);

      // The pool cap is half the epoch-start total. `a` takes 4M of it, so one
      // past the rest is refused, though half the live total would allow it.
      const cap = start / 2n;
      await grant(ctx, a, 4n * M);
      await refused(ctx, grantMethod(ctx, c, cap - 4n * M + 1n).rpc(), /DailyPoolGrantCapExceeded/);    },
    TIMEOUT,
  );
});
