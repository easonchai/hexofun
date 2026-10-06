// A Position only goes on a Round of the current epoch (audit-fixes ticket
// 02). A Round opened before epoch 1 carries epoch 0; once epoch 1 begins it
// takes no new stakes, leaves through void_round, and refunds the stake it
// already holds at settle.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  beginFirstEpoch,
  grantTicketsAsAdmin,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessPda,
  roundPda,
  setupPool,
  sleep,
  ticketsOf,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

async function chainNow(): Promise<number> {
  const slot = await provider.connection.getSlot("confirmed");
  const t = await provider.connection.getBlockTime(slot);
  if (t != null) return t;
  throw new Error("chainNow: validator has no block time yet");
}

async function waitUntil(tsSeconds: number, marginSeconds = 1): Promise<void> {
  for (;;) {
    const remaining = tsSeconds + marginSeconds - (await chainNow());
    if (remaining <= 0) return;
    await sleep(Math.max(300, remaining * 1000));
  }
}

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
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
}

async function createRound(pool: PoolCtx, roundSeconds: number) {
  const startsAt = await chainNow();
  const endsAt = startsAt + roundSeconds;
  const poolAccount = await program.account.pool.fetch(pool.pool);
  const roundId = BigInt(poolAccount.nextRoundId.toString());
  const round = roundPda(pool.pool, roundId);
  await program.methods
    .createRound(new BN(startsAt), new BN(endsAt))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: pool.pool, // no epoch open yet, any pubkey is accepted
      round,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
  return { round, endsAt };
}

async function buyPosition(pool: PoolCtx, owner: Wallet, round: PublicKey, tiles: bigint, stake: bigint) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stake.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round,
      position: positionPda(round, owner.keypair.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

describe("a Position only goes on a Round of the current epoch", () => {
  it(
    "refuses a stake once epoch 1 begins, voids the Round, and refunds the earlier stake in full",
    async () => {
      const anchor = (await chainNow()) + 100;
      const pool = await setupPool({ epochSeconds: 60, epochAnchor: anchor, roundSeconds: 8, closeBuffer: 1, vrfTimeout: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);

      await deposit(pool, alice, 5_000_000n);
      await grantTicketsAsAdmin(pool, alice.keypair.publicKey, 5_000_000n);
      await assertSolvent(pool);
      await deposit(pool, bob, 5_000_000n);
      await grantTicketsAsAdmin(pool, bob.keypair.publicKey, 5_000_000n);
      await assertSolvent(pool);

      const { round, endsAt } = await createRound(pool, 8);
      expect((await program.account.round.fetch(round)).epochId.toString()).toBe("0");
      await assertSolvent(pool);

      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      await assertSolvent(pool);

      await beginFirstEpoch(pool);
      await assertSolvent(pool);

      // Epoch 1 is open and the Round is still inside its window, so only the
      // epoch check can refuse this stake.
      expect(await chainNow()).toBeLessThan(endsAt - 1);
      await expect(buyPosition(pool, bob, round, 1n << 1n, 1_000_000n)).rejects.toThrow(
        /RoundEpochNotCurrent/,
      );
      await assertSolvent(pool);

      // Nobody requested randomness: voidable once ends_at + vrf_timeout passes.
      await waitUntil(endsAt + 2);
      await program.methods
        .voidRound()
        .accountsPartial({
          caller: pool.operator.publicKey,
          pool: pool.pool,
          round,
          randomness: randomnessPda(new Uint8Array(32)),
        })
        .signers([pool.operator])
        .rpc();
      expect((await program.account.round.fetch(round)).status).toBe(4); // Voided
      await assertSolvent(pool);

      await program.methods
        .settlePosition()
        .accountsPartial({
          pool: pool.pool,
          round,
          player: playerPda(pool.pool, alice.keypair.publicKey),
          owner: alice.keypair.publicKey,
          position: positionPda(round, alice.keypair.publicKey),
        })
        .rpc();
      await assertSolvent(pool);

      expect(await ticketsOf(pool, alice.keypair.publicKey, 1n)).toBe(5_000_000n); // stake refunded in full
    },
    TIMEOUT,
  );
});
