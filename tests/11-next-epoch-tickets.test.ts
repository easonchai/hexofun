// The pending deposit (ADR 0020). A deposit raises Principal and a Pending
// deposit, which holds no Ticket and refunds on request. The first touch in a
// later epoch folds it. The Tickets themselves are the backend's (ADR 0025),
// so this suite checks the program's half of the rule: the Pending deposit, the
// fold, what a Prize does to it, and the Bought ticket cap that reads locked
// Principal. The yield on a pending deposit is in 06-yield.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  epochPda,
  fulfillRandomness,
  payoutMethod,
  playerPda,
  program,
  requestDrawMethod,
  retryUntilOk,
  setupPool,
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
      ...pool.venue,
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

describe("the pending deposit", () => {
  it(
    "stays pending through its own epoch, and the first touch in the next epoch folds it",
    async () => {
      const pool = await setupPool({ epochSeconds: 8 });
      const a = await pool.fundedWallet(10_000_000n);
      const owner = a.keypair.publicKey;
      await beginEpoch(pool, 0n); // epoch 1

      await deposit(pool, a, 4_000_000n);
      let player = await fetchPlayer(pool, owner);
      expect(big(player.principal)).toBe(4_000_000n);
      expect(big(player.pendingDeposit)).toBe(4_000_000n);
      expect(big(player.pendingDepositEpoch)).toBe(1n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);

      // A second deposit in the same epoch adds to the same pending amount.
      await deposit(pool, a, 1_000_000n);
      player = await fetchPlayer(pool, owner);
      expect(big(player.pendingDeposit)).toBe(5_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      // Not touched yet: the account still says pending.
      expect(big((await fetchPlayer(pool, owner)).pendingDeposit)).toBe(5_000_000n);

      // Any touch folds it: this deposit does, and is itself pending.
      await deposit(pool, a, 1_000_000n);
      player = await fetchPlayer(pool, owner);
      expect(big(player.pendingDeposit)).toBe(1_000_000n);
      expect(big(player.pendingDepositEpoch)).toBe(2n);
      expect(big(player.epochId)).toBe(2n);
      expect(big(player.principal)).toBe(6_000_000n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );

  it(
    "a Prize raises Principal at once and leaves the pending deposit alone",
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
      // `a` never acted after depositing in epoch 1, and holds all of epoch 2.
      const held = [{ owner, tickets: 3_000_000n }];
      await requestDrawMethod(pool, 2n, held).rpc();
      const drawing = await fetchEpoch(pool, 2n);
      expect(big(drawing.totalTickets)).toBe(3_000_000n);

      await program.methods
        .draw()
        .accountsPartial({
          caller: pool.operator.publicKey,
          pool: pool.pool,
          epoch: epochPda(pool.pool, 2n),
          randomness: await fulfillRandomness(Uint8Array.from(drawing.vrfSeed)),
        })
        .signers([pool.operator])
        .rpc();

      // A new deposit in epoch 3 folds the first one and is itself pending.
      await deposit(pool, a, 1_000_000n);
      const before = await fetchPlayer(pool, owner);
      expect(big(before.pendingDeposit)).toBe(1_000_000n);
      const prize = big(drawing.jackpotAmount);
      expect(prize).toBe(2_000_000n);

      await payoutMethod(pool, 2n, owner, held).rpc();

      const after = await fetchPlayer(pool, owner);
      expect(big(after.principal)).toBe(big(before.principal) + prize);
      expect(big(after.pendingDeposit)).toBe(1_000_000n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );

  it(
    "the Bought ticket cap reads locked Principal, and refuses a pending deposit",
    async () => {
      const pool = await setupPool({ epochSeconds: 8 });
      const a = await pool.fundedWallet(10_000_000n);
      const owner = a.keypair.publicKey;
      await beginEpoch(pool, 0n); // epoch 1
      await deposit(pool, a, 3_000_000n);

      // All of it is pending, so nothing is locked to buy against.
      await expect(buyTickets(pool, a, 1n)).rejects.toThrow(/DailyBuyCapExceeded/);

      // From epoch 2 the deposit is locked.
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await expect(buyTickets(pool, a, 3_000_001n)).rejects.toThrow(/DailyBuyCapExceeded/);
      await buyTickets(pool, a, 1_000_000n);
      expect(big((await fetchPlayer(pool, owner)).boughtAmount)).toBe(1_000_000n);
      await assertPrincipalSums(pool, [owner, pool.operator.publicKey]);
    },
    TIMEOUT,
  );
});
