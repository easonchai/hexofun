// Deposits earn Tickets from the next epoch (yield-claimer ticket 20, ADR
// 0020). A deposit raises Principal and a Pending deposit and leaves Tickets
// alone. The first touch in a later epoch folds it into Tickets, and a
// depositor who never touches again is still in that epoch's root, because the
// tree resets a stale slot from `principal_sum`. Yield, Bought tickets, Granted
// tickets and the Prize credit Tickets at once.
//
// First deposits at the first and last second of an epoch, in the gap before
// `begin_epoch` and the first stub epoch are in 08-weight-tree. The yield on a
// pending deposit is in 06-yield.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  epochPda,
  fetchTree,
  fulfillRandomness,
  leafTickets,
  playerPda,
  program,
  randomnessForTarget,
  requestDrawMethod,
  retryUntilOk,
  setupPool,
  ticketsOf,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 240_000;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchPlayer = (pool: PoolCtx, owner: PublicKey) =>
  program.account.player.fetch(playerPda(pool.pool, owner));
const fetchEpoch = (pool: PoolCtx, id: bigint) => program.account.epoch.fetch(epochPda(pool.pool, id));

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      principalVault: pool.principalVault,
      ...pool.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
  await assertSolvent(pool);
  return signature;
}

async function beginEpoch(pool: PoolCtx, currentEpochId: bigint) {
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      epochTwoBehind: epochPda(pool.pool, currentEpochId > 0n ? currentEpochId - 1n : 0n),
      newEpoch: epochPda(pool.pool, currentEpochId + 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function buyTickets(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .buyTickets(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      jackpotVault: pool.jackpotVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner.keypair])
    .rpc();
}

async function grantTickets(pool: PoolCtx, owner: PublicKey, amount: bigint) {
  return program.methods
    .grantTickets(new BN(amount.toString()))
    .accountsPartial({
      signer: pool.operator.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner),
    })
    .signers([pool.operator])
    .rpc();
}

async function fundJackpot(pool: PoolCtx, source: Wallet, amount: bigint) {
  return program.methods
    .fundJackpot(new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: source.keypair.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      source: source.tokenAccount,
      jackpotVault: pool.jackpotVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([source.keypair])
    .rpc();
}

/** Pool `total_principal` is the sum of every Player's Principal, pending
 *  deposits included, and the pool stays solvent. */
async function assertPrincipalSums(pool: PoolCtx, owners: PublicKey[]) {
  let sum = 0n;
  for (const owner of owners) sum += big((await fetchPlayer(pool, owner)).principal);
  expect(big((await program.account.pool.fetch(pool.pool)).totalPrincipal)).toBe(sum);
  await assertSolvent(pool);
}

describe("deposits earn Tickets from the next epoch", () => {
  it(
    "shows zero Tickets and the full amount pending in the epoch, and the full amount active after a touch in the next",
    async () => {
      const pool = await setupPool({ epochSeconds: 8 });
      const a = await pool.fundedWallet(10_000_000n);
      const owner = a.keypair.publicKey;
      await beginEpoch(pool, 0n); // epoch 1

      await deposit(pool, a, 4_000_000n);
      let player = await fetchPlayer(pool, owner);
      expect(big(player.principal)).toBe(4_000_000n);
      expect(big(player.entries)).toBe(0n);
      expect(big(player.pendingDeposit)).toBe(4_000_000n);
      expect(big(player.pendingDepositEpoch)).toBe(1n);
      expect(await ticketsOf(pool, owner, 1n)).toBe(0n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);

      // A second deposit in the same epoch adds to the same pending amount.
      await deposit(pool, a, 1_000_000n);
      player = await fetchPlayer(pool, owner);
      expect(big(player.pendingDeposit)).toBe(5_000_000n);
      expect(big(player.entries)).toBe(0n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      // The tree already counts it, and the account has not been touched.
      expect(await ticketsOf(pool, owner, 2n)).toBe(5_000_000n);
      expect(big((await fetchPlayer(pool, owner)).entries)).toBe(0n);

      // Any touch folds it: this deposit does, and is itself pending.
      await deposit(pool, a, 1_000_000n);
      player = await fetchPlayer(pool, owner);
      expect(big(player.entries)).toBe(5_000_000n);
      expect(big(player.pendingDeposit)).toBe(1_000_000n);
      expect(big(player.pendingDepositEpoch)).toBe(2n);
      expect(big(player.principal)).toBe(6_000_000n);
      expect(await ticketsOf(pool, owner, 2n)).toBe(5_000_000n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );

  it(
    "keeps a depositor who never touches again in the root, draws them, and the Prize raises Principal and Tickets at once without touching the pending deposit",
    async () => {
      const pool = await setupPool({ epochSeconds: 8 });
      const a = await pool.fundedWallet(10_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      const owner = a.keypair.publicKey;
      await beginEpoch(pool, 0n); // epoch 1
      await deposit(pool, a, 3_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3: epoch 2 can be drawn
      await requestDrawMethod(pool, 2n).rpc();

      // `a` never acted after depositing in epoch 1, and is all of epoch 2.
      const drawing = await fetchEpoch(pool, 2n);
      expect(big(drawing.registeredWeight)).toBe(3_000_000n);
      expect(big((await fetchPlayer(pool, owner)).entries)).toBe(0n);
      const held = leafTickets(await fetchTree(pool), 2n);
      expect(held).toEqual([0n, 3_000_000n]);

      const randomness = randomnessForTarget(3_000_000n, 0n, 3_000_000n);
      await program.methods
        .draw()
        .accountsPartial({
          caller: pool.operator.publicKey,
          pool: pool.pool,
          epoch: epochPda(pool.pool, 2n),
          randomness: await fulfillRandomness(Uint8Array.from(drawing.vrfSeed), randomness),
        })
        .signers([pool.operator])
        .rpc();

      // A new deposit in epoch 3 folds the first one and is itself pending.
      await deposit(pool, a, 1_000_000n);
      const before = await fetchPlayer(pool, owner);
      expect(big(before.entries)).toBe(3_000_000n);
      expect(big(before.pendingDeposit)).toBe(1_000_000n);
      const prize = big(drawing.jackpotAmount);
      expect(prize).toBe(2_000_000n);

      await program.methods
        .payout()
        .accountsPartial({
          pool: pool.pool,
          acceptedMint: pool.mint,
          epoch: epochPda(pool.pool, 2n),
          winner: playerPda(pool.pool, owner),
          jackpotVault: pool.jackpotVault,
          principalVault: pool.principalVault,
          treasury: pool.treasury,
          buybackReserve: pool.buybackReserve,
          ...pool.venue,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const after = await fetchPlayer(pool, owner);
      expect(big(after.principal)).toBe(big(before.principal) + prize);
      expect(big(after.entries)).toBe(3_000_000n + prize);
      expect(big(after.pendingDeposit)).toBe(1_000_000n);
      // The tree agrees: this epoch holds the Tickets and not the pending deposit.
      expect(await ticketsOf(pool, owner, 3n)).toBe(3_000_000n + prize);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );

  it(
    "counts Bought and Granted tickets in the epoch they land, with both caps reading Principal including the pending deposit",
    async () => {
      const pool = await setupPool({ epochSeconds: 20, bonusCapBps: 10_000 });
      const a = await pool.fundedWallet(10_000_000n);
      const owner = a.keypair.publicKey;
      await beginEpoch(pool, 0n); // epoch 1
      await deposit(pool, a, 3_000_000n);
      expect(await ticketsOf(pool, owner, 1n)).toBe(0n);

      // The grant cap is Principal, all of it pending, and one more is refused.
      await expect(grantTickets(pool, owner, 3_000_001n)).rejects.toThrow(/DailyPlayerGrantCapExceeded/);
      await grantTickets(pool, owner, 3_000_000n);
      expect(await ticketsOf(pool, owner, 1n)).toBe(3_000_000n);

      // The buy cap is Principal too, and these Tickets count at once.
      await buyTickets(pool, a, 1_000_000n);
      const bought = 1_000_000n * BigInt(pool.ticketsPerUsdc);
      expect(await ticketsOf(pool, owner, 1n)).toBe(3_000_000n + bought);
      expect(big((await fetchPlayer(pool, owner)).entries)).toBe(3_000_000n + bought);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );
});
