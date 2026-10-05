// Round lifecycle: a stake leaves the draw and returns with its reward, pro-rata settlement,
// forfeit-to-House, void-and-refund, and the buy_position guard rails (spec
// §2.3 "Rounds", §2.4 invariant 5).
//
// Every test runs against a real localnet validator, so give it room: a
// round has to actually elapse in wall-clock time before it can be settled.
// Round/close-buffer/vrf-timeout params are kept small per test to bound how
// long that takes.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  fetchTree,
  fulfillRandomness,
  grantTicketsAsAdmin,
  leafTickets,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessFor,
  randomnessPda,
  roundPda,
  setupPool,
  sleep,
  testNonce,
  findEvent,
  vrfSeed,
  ticketsOf,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;

// Pinned in vrf.rs; not exported from hx.ts since only this file's real (not
// test-vrf) CPI-shaped accounts need it.
const ORAO_VRF_PROGRAM_ID = new PublicKey(
  "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y",
);

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

function depositAccounts(pool: PoolCtx, owner: Wallet) {
  return {
    owner: owner.keypair.publicKey,
    pool: pool.pool,
    player: playerPda(pool.pool, owner.keypair.publicKey),
    acceptedMint: pool.mint,
    ownerToken: owner.tokenAccount,
    principalVault: pool.principalVault,
    ...pool.venue,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

// A deposit earns no Ticket until the next epoch (ADR 0020), and every test
// here stakes on the day it deposits, so the Admin grants the Tickets a player
// needs. Principal and Tickets then match one for one, as they did before.
async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  const signature = await program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial(depositAccounts(pool, owner))
    .signers([owner.keypair])
    .rpc();
  await grantTicketsAsAdmin(pool, owner.keypair.publicKey, amount);
  return signature;
}

async function setHouseCutBps(pool: PoolCtx, houseCutBps: number) {
  return program.methods
    .setParams({
      epochSeconds: null,
      epochAnchor: null,
      roundSeconds: null,
      closeBuffer: null,
      vrfTimeout: null,
      minDeposit: null,
      houseCutBps,
    })
    .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

async function setPause(pool: PoolCtx, paused: boolean) {
  return program.methods
    .setPause(paused)
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

async function setGamePaused(pool: PoolCtx, paused: boolean) {
  return program.methods
    .setFeaturePause({ game: {} }, paused)
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

/**
 * The validator's own Clock sysvar time. `solana-test-validator` derives
 * `unix_timestamp` from slot count, not wall time, and slots can run well
 * behind real time under load -- so every "now" a test reasons about (round
 * bounds, how long to sleep) has to come from here, not `Date.now()`, or it
 * drifts out of sync with what `utils::now()` reads on-chain.
 */
async function chainNow(): Promise<number> {
  const slot = await provider.connection.getSlot("confirmed");
  const t = await provider.connection.getBlockTime(slot);
  if (t != null) return t;
  const prev = await provider.connection.getBlockTime(Math.max(0, slot - 1));
  if (prev != null) return prev;
  throw new Error("chainNow: validator has no block time yet");
}

/** Opens epoch 1, which the Weight tree needs to credit anything. */
async function beginFirstEpoch(pool: PoolCtx) {
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, 0n),
      // Never read at current_epoch_id 0 (< 2); the address still has to be
      // supplied.
      epochTwoBehind: epochPda(pool.pool, 0n),
      newEpoch: epochPda(pool.pool, 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

/** Creates a round starting now (validator time). `currentEpoch` only
 * matters once an epoch is open (`pool.currentEpochId != 0`); before that
 * any pubkey is accepted. */
async function createRound(
  pool: PoolCtx,
  roundSeconds: number,
  currentEpoch: PublicKey = pool.pool,
) {
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
      currentEpoch,
      round,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();

  return { roundId, round, startsAt, endsAt };
}

async function buyPosition(
  pool: PoolCtx,
  owner: Wallet,
  round: PublicKey,
  tiles: bigint,
  stakePerTile: bigint,
) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
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

/**
 * `nonce` is mixed into the seed (beta-launch-fixes ticket 02); a fixed test
 * nonce is fine, since tests need no real unpredictability. Returns the seed
 * actually used, since `round.vrfSeed` is `[0; 32]` until this succeeds.
 */
async function requestRandomness(
  pool: PoolCtx,
  round: PublicKey,
  roundId: bigint,
  nonce: Uint8Array = testNonce(),
): Promise<Uint8Array> {
  const seed = vrfSeed("round", pool.pool, roundId, nonce);
  await program.methods
    .requestRoundRandomness(Array.from(nonce))
    .accountsPartial({
      payer: provider.wallet.publicKey,
      pool: pool.pool,
      round,
      randomness: randomnessPda(seed),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return seed;
}

async function settleRound(pool: PoolCtx, round: PublicKey, seed: Uint8Array) {
  return program.methods
    .settleRound()
    .accountsPartial({
      caller: pool.operator.publicKey,
      pool: pool.pool,
      round,
      randomness: randomnessPda(seed),
      house: pool.house,
    })
    .signers([pool.operator])
    .rpc();
}

async function settlePosition(
  pool: PoolCtx,
  round: PublicKey,
  owner: PublicKey,
) {
  return program.methods
    .settlePosition()
    .accountsPartial({
      pool: pool.pool,
      round,
      player: playerPda(pool.pool, owner),
      owner,
      position: positionPda(round, owner),
    })
    .rpc();
}

/**
 * `seed` is the Round's own `vrfSeed` once requested (unused, any value
 * works, when voiding a still-OPEN round that was never requested at all).
 * The program checks the randomness account against it and refuses to void a
 * request that was fulfilled. Permissionless (production-hardening ticket
 * 01): the first account is `caller`, not `operator`.
 */
async function voidRound(
  pool: PoolCtx,
  round: PublicKey,
  seed: Uint8Array,
  caller: Keypair = pool.operator,
) {
  return program.methods
    .voidRound()
    .accountsPartial({
      caller: caller.publicKey,
      pool: pool.pool,
      round,
      randomness: randomnessPda(seed),
    })
    .signers([caller])
    .rpc();
}

/** Runs the round to its end, requests randomness, and settles it with
 * `winningTile` as the drawn tile. Returns the fetched, settled Round. */
async function playToSettlement(
  pool: PoolCtx,
  round: PublicKey,
  endsAt: number,
  winningTile: number,
) {
  await waitUntil(endsAt);
  const roundBefore = await program.account.round.fetch(round);
  const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));
  await fulfillRandomness(seed, randomnessFor(winningTile));
  await settleRound(pool, round, seed);
  return program.account.round.fetch(round);
}

/** Sleeps until `tsSeconds` (unix seconds) has passed, plus a margin for
 * clock skew between this process and the validator. */
/** Polls the validator's own clock (see `chainNow`) until it has passed
 * `tsSeconds` by at least `marginSeconds`, sleeping between checks. */
async function waitUntil(tsSeconds: number, marginSeconds = 1): Promise<void> {
  for (;;) {
    const now = await chainNow();
    const remaining = tsSeconds + marginSeconds - now;
    if (remaining <= 0) return;
    await sleep(Math.max(300, remaining * 1000));
  }
}

async function expectClosed(pda: PublicKey) {
  await expect(program.account.position.fetch(pda)).rejects.toThrow();
}

describe("rounds", () => {
  it(
    "winner takes the pot net of the House cut, loser's entries are gone, total entries conserved",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n); // tile 0
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n); // tile 1

      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const bobPositionPda = positionPda(round, bob.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(
        alicePositionPda,
      ))!.lamports;
      const bobRentBefore = (await provider.connection.getAccountInfo(
        bobPositionPda,
      ))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(
        alice.keypair.publicKey,
      );
      const bobBalBefore = await provider.connection.getBalance(
        bob.keypair.publicKey,
      );

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 0); // tile 0 wins
      expect(settled.status).toBe(2); // Settled
      // The pot stays gross; the House's share is recorded beside it.
      expect(settled.pot.toString()).toBe("2000000");
      // 6% of the losers' pot: 2M less the winning tile's 1M.
      expect(settled.houseCut.toString()).toBe("60000");

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      const houseAfter = await program.account.player.fetch(pool.house);
      // Alice staked 1M of her 5M, then takes her stake back whole plus the
      // 1M losers' pot less the 60k House cut: 5M - 1M + 1M + 0.94M.
      expect(aliceAfter.entries.toString()).toBe("5940000");
      // Bob staked 1M and lost it outright.
      expect(bobAfter.entries.toString()).toBe("4000000");
      expect(houseAfter.entries.sub(houseBefore.entries).toString()).toBe(
        "60000",
      );
      // Zero-sum across every Player, the House included.
      expect(
        aliceAfter.entries.add(bobAfter.entries).add(houseAfter.entries).toString(),
      ).toBe("10000000");

      await expectClosed(alicePositionPda);
      await expectClosed(bobPositionPda);
      expect(
        await provider.connection.getBalance(alice.keypair.publicKey),
      ).toBe(aliceBalBefore + aliceRentBefore);
      expect(await provider.connection.getBalance(bob.keypair.publicKey)).toBe(
        bobBalBefore + bobRentBefore,
      );
    },
    TIMEOUT,
  );

  it(
    "pays winners on the winning tile pro rata, with dust left unminted",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 1_000_000n);
      await deposit(pool, bob, 1_000_000n);
      await deposit(pool, carol, 1_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      // Small stakes chosen so the pro-rata split leaves a remainder:
      // pot = 12, tile 5's total = 8, losers' pot = 4. Alice gets her 3 back
      // plus floor(4*3/8) = 1, bob his 5 plus floor(4*5/8) = 2 -- 11 total, 1
      // unit of dust stays unminted. The 6% House cut floors to 0 on a losers'
      // pot this small, so the dust rule is the only rounding at work.
      await buyPosition(pool, alice, round, 1n << 5n, 3n);
      await buyPosition(pool, bob, round, 1n << 5n, 5n);
      await buyPosition(pool, carol, round, 1n << 6n, 4n);

      const settled = await playToSettlement(pool, round, endsAt, 5);
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("12");
      expect(settled.houseCut.toString()).toBe("0");

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);
      await settlePosition(pool, round, carol.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      const carolAfter = await program.account.player.fetch(
        playerPda(pool.pool, carol.keypair.publicKey),
      );
      // Started at 1_000_000, staked 3/5/4, alice and bob win their share back.
      expect(aliceAfter.entries.toString()).toBe("1000001"); // 1_000_000 - 3 + 3 + 1
      expect(bobAfter.entries.toString()).toBe("1000002"); // 1_000_000 - 5 + 5 + 2
      expect(carolAfter.entries.toString()).toBe("999996"); // 1_000_000 - 4 + 0

      const totalRewards = 4n + 7n;
      expect(totalRewards <= 12n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "forfeits an uncovered tile's pot to the House",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 2n, 1_000_000n); // tile 2 only

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 7); // nobody on tile 7
      expect(settled.status).toBe(3); // Forfeited
      expect(settled.winningTile).toBe(7);
      // The House already takes the whole pot, so no cut comes off it.
      expect(settled.houseCut.toString()).toBe("0");

      const houseAfter = await program.account.player.fetch(pool.house);
      expect(houseAfter.entries.sub(houseBefore.entries).toString()).toBe(
        "1000000",
      );

      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(
        alicePositionPda,
      ))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(
        alice.keypair.publicKey,
      );
      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      expect(aliceAfter.entries.toString()).toBe("4000000"); // stake gone, no reward
      await expectClosed(alicePositionPda);
      expect(
        await provider.connection.getBalance(alice.keypair.publicKey),
      ).toBe(aliceBalBefore + aliceRentBefore);
    },
    TIMEOUT,
  );

  it(
    "credits the House exactly the cut and leaves the winners the remainder",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);
      await deposit(pool, carol, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      // Stakes chosen so the remainder divides exactly and no dust hides the
      // arithmetic: pot 6M, tile 3 holds 4M, so the losers' pot is 2M, the
      // cut 120k, and the 1.88M left splits 1:3 on top of the stakes.
      await buyPosition(pool, alice, round, 1n << 3n, 1_000_000n);
      await buyPosition(pool, bob, round, 1n << 3n, 3_000_000n);
      await buyPosition(pool, carol, round, 1n << 4n, 2_000_000n);

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 3);
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("6000000");
      expect(settled.houseCut.toString()).toBe("120000");

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);
      await settlePosition(pool, round, carol.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      const carolAfter = await program.account.player.fetch(
        playerPda(pool.pool, carol.keypair.publicKey),
      );
      const houseAfter = await program.account.player.fetch(pool.house);

      expect(houseAfter.entries.sub(houseBefore.entries).toString()).toBe(
        "120000",
      );
      expect(aliceAfter.entries.toString()).toBe("5470000"); // 5M - 1M + 1M + 0.47M
      expect(bobAfter.entries.toString()).toBe("6410000"); // 5M - 3M + 3M + 1.41M
      expect(carolAfter.entries.toString()).toBe("3000000"); // stake gone
      expect(
        aliceAfter.entries
          .add(bobAfter.entries)
          .add(carolAfter.entries)
          .add(houseAfter.entries)
          .toString(),
      ).toBe("15000000");
    },
    TIMEOUT,
  );

  it(
    "pays the winner the whole pot when the House cut is zero",
    async () => {
      const pool = await setupPool({
        roundSeconds: 6,
        closeBuffer: 2,
        houseCutBps: 0,
      });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n);

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 0);
      expect(settled.status).toBe(2); // Settled
      expect(settled.houseCut.toString()).toBe("0");

      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const houseAfter = await program.account.player.fetch(pool.house);
      expect(aliceAfter.entries.toString()).toBe("6000000"); // 5M - 1M + 1M + 1M
      expect(houseAfter.entries.toString()).toBe(houseBefore.entries.toString());
    },
    TIMEOUT,
  );

  it(
    "rejects a House cut above 100% and applies a new rate to the next round settled",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      await expect(setHouseCutBps(pool, 10_001)).rejects.toThrow();
      await setHouseCutBps(pool, 1_000); // 10%
      const poolAfter = await program.account.pool.fetch(pool.pool);
      expect(poolAfter.houseCutBps).toBe(1_000);

      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n);

      const settled = await playToSettlement(pool, round, endsAt, 0);
      expect(settled.status).toBe(2); // Settled
      expect(settled.houseCut.toString()).toBe("100000"); // 10% of the 1M losers' pot, not 6%

      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      expect(aliceAfter.entries.toString()).toBe("5900000"); // 5M - 1M + 1M + 0.9M
    },
    TIMEOUT,
  );

  it(
    "a round where everyone picks the winning tile pays no cut and every stake comes back whole",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 4n, 1_000_000n);
      await buyPosition(pool, bob, round, 1n << 4n, 3_000_000n);

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 4);
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("4000000");
      expect(settled.houseCut.toString()).toBe("0"); // losers' pot is empty

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      expect(aliceAfter.entries.toString()).toBe("5000000");
      expect(bobAfter.entries.toString()).toBe("5000000");
      const houseAfter = await program.account.player.fetch(pool.house);
      expect(houseAfter.entries.toString()).toBe(houseBefore.entries.toString());
    },
    TIMEOUT,
  );

  it(
    "guards buy_position: close buffer, duplicate position, empty mask, over-stake",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 3 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      const dave = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);
      await deposit(pool, carol, 1_000_000n);
      await deposit(pool, dave, 5_000_000n);

      const { round, startsAt } = await createRound(pool, 6);

      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      // Same owner, same round: the Position PDA already exists.
      await expect(
        buyPosition(pool, alice, round, 1n << 1n, 1_000_000n),
      ).rejects.toThrow();
      // Empty tile mask.
      await expect(
        buyPosition(pool, bob, round, 0n, 1_000_000n),
      ).rejects.toThrow();
      // Stake total exceeds the player's Entries (carol only has 1_000_000).
      await expect(
        buyPosition(pool, carol, round, 1n << 3n, 2_000_000n),
      ).rejects.toThrow();

      // Past ends_at - close_buffer (6 - 3 = 3s in), still before the round
      // itself ends, so this is specifically the close-buffer rejection.
      await waitUntil(startsAt + 6 - 3);
      await expect(
        buyPosition(pool, dave, round, 1n << 4n, 1_000_000n),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "rejects request_round_randomness before the close with RoundNotEnded",
    async () => {
      const pool = await setupPool({ roundSeconds: 20, closeBuffer: 14 });
      const { round } = await createRound(pool, 20);

      const roundBefore = await program.account.round.fetch(round);
      // Well before ends_at - close_buffer (20 - 14 = 6s in): the round is
      // still open to Positions, so the draw window has not started yet.
      await expect(
        requestRandomness(pool, round, BigInt(roundBefore.roundId.toString())),
      ).rejects.toThrow();

      const roundAfter = await program.account.round.fetch(round);
      expect(roundAfter.status).toBe(0); // still Open
    },
    TIMEOUT,
  );

  it(
    "requests randomness the instant positions close and settles before ends_at, exactly like a late round",
    async () => {
      const pool = await setupPool({ roundSeconds: 20, closeBuffer: 14 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);
      await deposit(pool, carol, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 20);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n); // tile 0
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n); // tile 1

      // ends_at - close_buffer (20 - 14 = 6s in): positions close here, 14s
      // before the round itself ends.
      const closeAt = endsAt - 14;
      await waitUntil(closeAt);

      // Positions are closed, but the round has not ended -- only the
      // close-buffer instant unblocks the draw request.
      await expect(
        buyPosition(pool, carol, round, 1n << 2n, 1_000_000n),
      ).rejects.toThrow();

      const roundBefore = await program.account.round.fetch(round);
      const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));

      const requested = await program.account.round.fetch(round);
      expect(requested.status).toBe(1); // Requested
      expect(Number(requested.requestedAt.toString())).toBeLessThan(endsAt);

      await fulfillRandomness(seed, randomnessFor(0)); // tile 0 wins
      await settleRound(pool, round, seed);

      const settled = await program.account.round.fetch(round);
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("2000000");
      expect(await chainNow()).toBeLessThan(endsAt);

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      // Same pro-rata payout as a round settled after ends_at: alice takes
      // her stake and the losers' 1M less the 60k House cut, bob's stake is gone.
      expect(aliceAfter.entries.toString()).toBe("5940000"); // 5M - 1M + 1M + 0.94M
      expect(bobAfter.entries.toString()).toBe("4000000"); // 5M - 1M, lost
    },
    TIMEOUT,
  );

  it(
    "a stake placed and settled inside one epoch leaves the draw where it was, plus the reward",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      await beginFirstEpoch(pool);
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const holder = await pool.fundedWallet(10_000_000n);
      for (const w of [alice, bob, holder]) await deposit(pool, w, 5_000_000n);
      const root = async () => (await leafTickets(await fetchTree(pool), 1n)).reduce((x, y) => x + y, 0n);
      const tickets = (w: Wallet) => ticketsOf(pool, w.keypair.publicKey, 1n);
      expect(await root()).toBe(15_000_000n);

      const { round, endsAt } = await createRound(pool, 6, epochPda(pool.pool, 1n));
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n);

      // The stakes leave the tree at once, with nothing credited back for the
      // seconds the round has left.
      expect(await tickets(alice)).toBe(4_000_000n);
      expect(await tickets(bob)).toBe(4_000_000n);
      expect(await tickets(holder)).toBe(5_000_000n);
      expect(await root()).toBe(13_000_000n);

      await playToSettlement(pool, round, endsAt, 0);
      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);

      // Alice is back with her stake and the losers' pot less the 6% cut
      // (1M + 0.94M), the House holds the cut, and the root is where it was.
      expect(await tickets(alice)).toBe(5_940_000n);
      expect(await tickets(bob)).toBe(4_000_000n);
      expect(await tickets(holder)).toBe(5_000_000n);
      expect(await ticketsOf(pool, pool.operator.publicKey, 1n)).toBe(60_000n);
      expect(await root()).toBe(15_000_000n);
    },
    TIMEOUT,
  );

  it(
    "voiding after the vrf timeout refunds every stake at settle_position, with no cut and nothing carried",
    async () => {
      const pool = await setupPool({
        roundSeconds: 4,
        closeBuffer: 1,
        vrfTimeout: 2,
      });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 4);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      // Three tiles at 500k: the refund is the whole 1.5M, not one tile's.
      await buyPosition(pool, bob, round, 0b1110n, 500_000n);

      await waitUntil(endsAt);
      const roundBefore = await program.account.round.fetch(round);
      const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));
      const requested = await program.account.round.fetch(round);

      await waitUntil(Number(requested.requestedAt.toString()) + 2); // past vrf_timeout
      const houseBefore = await program.account.player.fetch(pool.house);
      await voidRound(pool, round, seed);

      const voided = await program.account.round.fetch(round);
      expect(voided.status).toBe(4); // Voided
      expect(voided.houseCut.toString()).toBe("0");
      expect(voided.pot.toString()).toBe("2500000");

      // Nothing carries: the next round opens empty.
      const { round: round2 } = await createRound(pool, 4);
      expect((await program.account.round.fetch(round2)).pot.toString()).toBe("0");

      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(
        alicePositionPda,
      ))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(
        alice.keypair.publicKey,
      );
      const aliceSig = await settlePosition(pool, round, alice.keypair.publicKey);
      const bobSig = await settlePosition(pool, round, bob.keypair.publicKey);
      const aliceEvent = await findEvent<{ reward: BN; refund: BN }>(aliceSig, "positionSettled");
      const bobEvent = await findEvent<{ reward: BN; refund: BN }>(bobSig, "positionSettled");
      expect(aliceEvent?.refund.toString()).toBe("1000000");
      expect(bobEvent?.refund.toString()).toBe("1500000");
      expect(aliceEvent?.reward.toString()).toBe("0");

      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      const bobAfter = await program.account.player.fetch(
        playerPda(pool.pool, bob.keypair.publicKey),
      );
      expect(aliceAfter.entries.toString()).toBe("5000000"); // whole again
      expect(bobAfter.entries.toString()).toBe("5000000");
      const houseAfter = await program.account.player.fetch(pool.house);
      expect(houseAfter.entries.toString()).toBe(houseBefore.entries.toString());
      await expectClosed(alicePositionPda);
      expect(
        await provider.connection.getBalance(alice.keypair.publicKey),
      ).toBe(aliceBalBefore + aliceRentBefore);
    },
    TIMEOUT,
  );

  it(
    "a refund puts the stake back in the tree",
    async () => {
      const pool = await setupPool({
        roundSeconds: 4,
        closeBuffer: 1,
        vrfTimeout: 2,
      });
      await beginFirstEpoch(pool);
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 4, epochPda(pool.pool, 1n));
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);

      await waitUntil(endsAt);
      const roundBefore = await program.account.round.fetch(round);
      const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));
      const requested = await program.account.round.fetch(round);
      await waitUntil(Number(requested.requestedAt.toString()) + 2);
      await voidRound(pool, round, seed);

      await settlePosition(pool, round, alice.keypair.publicKey);

      // The refund puts the stake back, so the tree holds her whole 5M again.
      expect(await ticketsOf(pool, alice.keypair.publicKey, 1n)).toBe(5_000_000n);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      expect(aliceAfter.entries.toString()).toBe("5000000");
    },
    TIMEOUT,
  );

  it(
    "void_round is refused once the randomness has been fulfilled",
    async () => {
      const pool = await setupPool({
        roundSeconds: 4,
        closeBuffer: 1,
        vrfTimeout: 2,
      });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      // Round 1: the oracle answers, and only then does the timeout pass.
      // Reading the tile and voiding the round is the move this blocks.
      const first = await createRound(pool, 4);
      await buyPosition(pool, alice, first.round, 1n << 0n, 1_000_000n);
      await waitUntil(first.endsAt);
      const firstRoundBefore = await program.account.round.fetch(first.round);
      const firstSeed = await requestRandomness(
        pool,
        first.round,
        BigInt(firstRoundBefore.roundId.toString()),
      );
      await fulfillRandomness(firstSeed, randomnessFor(1)); // alice loses
      const requested = await program.account.round.fetch(first.round);
      await waitUntil(Number(requested.requestedAt.toString()) + 2);

      await expect(voidRound(pool, first.round, firstSeed)).rejects.toThrow(
        /RandomnessAlreadyFulfilled/,
      );
      // The only way out of a fulfilled request is the settlement it drew.
      await settleRound(pool, first.round, firstSeed);
      expect((await program.account.round.fetch(first.round)).status).toBe(3); // Forfeited

      // Round 2: nothing ever answers, so the same timeout still voids.
      const second = await createRound(pool, 4);
      await buyPosition(pool, alice, second.round, 1n << 0n, 1_000_000n);
      await waitUntil(second.endsAt);
      const secondRoundBefore = await program.account.round.fetch(second.round);
      const secondSeed = await requestRandomness(
        pool,
        second.round,
        BigInt(secondRoundBefore.roundId.toString()),
      );
      const secondRequested = await program.account.round.fetch(second.round);
      await waitUntil(Number(secondRequested.requestedAt.toString()) + 2);
      await voidRound(pool, second.round, secondSeed);
      expect((await program.account.round.fetch(second.round)).status).toBe(4); // Voided
    },
    TIMEOUT,
  );

  it(
    "pre-creating the randomness account for the seed no longer blocks a request",
    async () => {
      // beta-launch-fixes ticket 02: the seed is unknowable before the
      // request (it depends on the Operator's own nonce), so nobody can
      // grief a Round by pre-creating ORAO's request account for it. Proven
      // here as: two different nonces for the same Round land at two
      // different addresses, so "pre-creating the seed's account" isn't even
      // a coherent attack any more -- there is no address to target ahead of
      // time.
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const { round, endsAt } = await createRound(pool, 6);
      await waitUntil(endsAt);

      const roundBefore = await program.account.round.fetch(round);
      const roundId = BigInt(roundBefore.roundId.toString());
      const seedA = vrfSeed("round", pool.pool, roundId, testNonce(1));
      const seedB = vrfSeed("round", pool.pool, roundId, testNonce(2));
      expect(Buffer.from(seedA)).not.toEqual(Buffer.from(seedB));

      // A stranger's own would-be griefing "pre-create" pass over seedA's
      // address before the real request is exactly what the real request
      // (with a different, Operator-chosen nonce) never collides with.
      const seed = await requestRandomness(pool, round, roundId, testNonce(2));
      expect(Buffer.from(seed)).toEqual(Buffer.from(seedB));
      const requested = await program.account.round.fetch(round);
      expect(requested.status).toBe(1); // Requested
      expect(requested.vrfRequestSlot.toNumber()).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "a Round left OPEN past ends_at + vrf_timeout can be voided by anyone",
    async () => {
      // beta-launch-fixes ticket 02: a Round that never even got its
      // randomness request through (e.g. the Operator crashed before
      // calling request_round_randomness) is not stuck forever.
      const pool = await setupPool({ roundSeconds: 4, closeBuffer: 1, vrfTimeout: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 4);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);

      // Never requested at all: still OPEN past ends_at + vrf_timeout.
      await waitUntil(endsAt + 2 + 1);
      // Any placeholder randomness account: the OPEN branch never reads it.
      // A stranger, not the Operator (production-hardening 14, Finding 6).
      const stranger = await pool.fundedWallet(0n);
      await voidRound(pool, round, new Uint8Array(32), stranger.keypair);

      const voided = await program.account.round.fetch(round);
      expect(voided.status).toBe(4); // Voided
      // The stake comes back at settle_position, covered above.
    },
    TIMEOUT,
  );

  it(
    "buy_position refuses while the pool is paused",
    async () => {
      // production-hardening ticket 02: pause stops all Ticket movement.
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      const { round } = await createRound(pool, 6);

      await setPause(pool, true);
      await expect(
        buyPosition(pool, alice, round, 1n << 0n, 1_000_000n),
      ).rejects.toThrow(/PoolPaused/);
    },
    TIMEOUT,
  );

  it(
    "the House cannot buy a position with the Entries it just won",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 2n, 1_000_000n); // tile 2 only
      await playToSettlement(pool, round, endsAt, 7); // nobody on tile 7
      const house = await program.account.player.fetch(pool.house);
      expect(house.entries.toString()).toBe("1000000");

      const { round: next } = await createRound(pool, 6);
      await expect(
        buyPosition(
          pool,
          { keypair: pool.operator, tokenAccount: PublicKey.default },
          next,
          1n << 0n,
          1_000n,
        ),
      ).rejects.toThrow(/HouseCannotPlay/);
    },
    TIMEOUT,
  );

  it(
    "create_round rejects a paused pool, a game-paused pool, and a second open round",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });

      await setPause(pool, true);
      await expect(createRound(pool, 6)).rejects.toThrow(/PoolPaused/);
      await setPause(pool, false);

      await setGamePaused(pool, true);
      await expect(createRound(pool, 6)).rejects.toThrow(/GamePaused/);
      await setGamePaused(pool, false);

      await createRound(pool, 6); // now open
      await expect(createRound(pool, 6)).rejects.toThrow(); // still open
    },
    TIMEOUT,
  );

  it(
    "buy_position rejects a game-paused pool",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round } = await createRound(pool, 6);
      await setGamePaused(pool, true);
      await expect(
        buyPosition(pool, alice, round, 1n << 0n, 1_000_000n),
      ).rejects.toThrow(/GamePaused/);

      await setGamePaused(pool, false);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n); // clears once unpaused
    },
    TIMEOUT,
  );

  it(
    "a round opened before the game is paused still settles, its position still settles, and it still closes",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);

      await setGamePaused(pool, true);
      // create_round and buy_position are refused, but nothing that finishes
      // this already-open round is gated (spec: game pause never blocks
      // request_round_randomness, settle_round, settle_position or
      // close_round). Bob, not Alice, tries to buy: Alice's Position already
      // exists, so her second buy fails its `init` before the pause check.
      await expect(createRound(pool, 6)).rejects.toThrow(/GamePaused/);
      await expect(
        buyPosition(pool, bob, round, 1n << 1n, 1n),
      ).rejects.toThrow(/GamePaused/);

      const settled = await playToSettlement(pool, round, endsAt, 0);
      expect(settled.status).toBe(2); // Settled

      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(
        playerPda(pool.pool, alice.keypair.publicKey),
      );
      // 5M - 1M staked + the 1M stake back whole: nobody lost, so no cut.
      expect(aliceAfter.entries.toString()).toBe("5000000");

      const positionPdaAddr = positionPda(round, alice.keypair.publicKey);
      await expectClosed(positionPdaAddr);
    },
    TIMEOUT,
  );

  it(
    "voiding an already-open round after the vrf timeout still works while the game is paused",
    async () => {
      const pool = await setupPool({
        roundSeconds: 4,
        closeBuffer: 1,
        vrfTimeout: 2,
      });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 4);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      await setGamePaused(pool, true);

      await waitUntil(endsAt);
      const roundBefore = await program.account.round.fetch(round);
      const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));
      const requested = await program.account.round.fetch(round);

      await waitUntil(Number(requested.requestedAt.toString()) + 2);
      await voidRound(pool, round, seed);

      const voided = await program.account.round.fetch(round);
      expect(voided.status).toBe(4); // Voided
    },
    TIMEOUT,
  );

  it(
    "settle_round rejects a house slot that is not pool.house",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);

      await waitUntil(endsAt);
      const roundBefore = await program.account.round.fetch(round);
      const seed = await requestRandomness(pool, round, BigInt(roundBefore.roundId.toString()));
      await fulfillRandomness(seed, randomnessFor(0));

      // A real Player PDA, just not the House's.
      const impostor = await pool.fundedWallet(1_000_000n);
      await deposit(pool, impostor, 1_000_000n);

      await expect(
        program.methods
          .settleRound()
          .accountsPartial({
            caller: pool.operator.publicKey,
            pool: pool.pool,
            round,
            randomness: randomnessPda(seed),
            house: playerPda(pool.pool, impostor.keypair.publicKey),
          })
          .signers([pool.operator])
          .rpc(),
      ).rejects.toThrow();

      const roundAfter = await program.account.round.fetch(round);
      expect(roundAfter.status).toBe(1); // still Requested
    },
    TIMEOUT,
  );

  it(
    "create_round rejects a round that would end after the current epoch",
    async (ctx) => {
      const pool = await setupPool({ epochSeconds: 30, roundSeconds: 6 });

      try {
        await program.methods
          .beginEpoch()
          .accountsPartial({
            operator: pool.operator.publicKey,
            pool: pool.pool,
            currentEpoch: epochPda(pool.pool, 0n),
            // Never read at current_epoch_id 0 (< 2); the address still has
            // to be supplied.
            epochTwoBehind: epochPda(pool.pool, 0n),
            newEpoch: epochPda(pool.pool, 1n),
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.operator])
          .rpc();
      } catch (err) {
        // `begin_epoch` (ticket 04) is being implemented concurrently and is
        // a `todo!()` stub as of this ticket; skip until it lands rather
        // than implementing it here.
        ctx.skip(
          `begin_epoch unusable (ticket 04 in progress): ${(err as Error).message}`,
        );
        return;
      }

      const poolAccount = await program.account.pool.fetch(pool.pool);
      const epoch = await program.account.epoch.fetch(epochPda(pool.pool, 1n));
      // ends_at must still satisfy ends_at - starts_at == round_seconds (6),
      // so this fails specifically on the epoch bound, not round length.
      const endsAt = new BN(epoch.endsAt.toString()).addn(1);
      const startsAt = endsAt.subn(6);
      await expect(
        program.methods
          .createRound(startsAt, endsAt)
          .accountsPartial({
            operator: pool.operator.publicKey,
            pool: pool.pool,
            currentEpoch: epochPda(
              pool.pool,
              BigInt(poolAccount.currentEpochId.toString()),
            ),
            round: roundPda(
              pool.pool,
              BigInt(poolAccount.nextRoundId.toString()),
            ),
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.operator])
          .rpc(),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
