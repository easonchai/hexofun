// Epoch lifecycle: contiguous epochs, the Weight tree's per-Player Weight,
// request_draw, draw, payout to a player and to the House, rollover, and the
// closing invariant sweep (spec §2.3 "Epochs", §2.4 invariants 1-2 and 7-8).
//
// Registration is gone (yield-claimer tickets 04 and 08): every Player is in
// the draw through the Weight tree, which these tests read through
// `weightOf` and `drawnWinner` in the helpers.
//
// Epochs here run a handful of seconds (via the `epochSeconds` override) so
// tests sleep through them instead of a day. Each test airdrops, mints, and
// confirms several transactions against a real localnet validator.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  drawnWinner,
  epochPda,
  fetchTree,
  findEvent,
  fulfillRandomness,
  leafWeights,
  onChainNowSeconds,
  playerPda,
  positionPda,
  program,
  randomnessFor,
  randomnessForTarget,
  randomnessPda,
  requestDrawMethod,
  retryUntilOk,
  roundPda,
  setupPool,
  sleep,
  sleepUntilOnChain,
  testNonce,
  txInfo,
  vrfSeed,
  weightOf,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;

// ORAO's VRF program id, pinned on the pool at create_pool and re-checked by
// `request_draw`/`request_round_randomness`. test-vrf's request path
// never actually invokes it, so it needs no deployment on localnet.
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

const epoch_status = {
  OPEN: 0,
  ENDED: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
};

const round_status = {
  OPEN: 0,
  REQUESTED: 1,
  SETTLED: 2,
  FORFEITED: 3,
  VOIDED: 4,
};

type Wallet = { keypair: Keypair; tokenAccount: PublicKey };

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

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial(depositAccounts(pool, owner))
    .signers([owner.keypair])
    .rpc();
}

async function requestWithdraw(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      ...pool.venue,
    })
    .signers([owner.keypair])
    .rpc();
}

async function processWithdraw(pool: PoolCtx, owner: Wallet) {
  return program.methods
    .processWithdraw()
    .accountsPartial({
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

async function setPause(pool: PoolCtx, paused: boolean) {
  return program.methods
    .setPause(paused)
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

async function setJackpotPaused(pool: PoolCtx, paused: boolean) {
  return program.methods
    .setFeaturePause({ jackpot: {} }, paused)
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

/** `currentEpochId` is `pool.currentEpochId` *before* this call. */
async function beginEpoch(pool: PoolCtx, currentEpochId: bigint) {
  const twoBehindId = currentEpochId > 0n ? currentEpochId - 1n : 0n;
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      epochTwoBehind: epochPda(pool.pool, twoBehindId),
      newEpoch: epochPda(pool.pool, currentEpochId + 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function setParams(pool: PoolCtx, epochSeconds: number) {
  return program.methods
    .setParams({
      epochSeconds: new BN(epochSeconds),
      epochAnchor: null,
      roundSeconds: null,
      closeBuffer: null,
      vrfTimeout: null,
      minDeposit: null,
      houseCutBps: null,
      minJackpot: null,
      payoutTimeout: null,
      baseRateBps: null,
      ticketsPerUsdc: null,
      bonusCapBps: null,
    })
    .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
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

async function grantTickets(
  pool: PoolCtx,
  signer: Keypair,
  owner: PublicKey,
  amount: bigint,
) {
  return program.methods
    .grantTickets(new BN(amount.toString()))
    .accountsPartial({
      signer: signer.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner),
    })
    .signers([signer])
    .rpc();
}

/**
 * `nonce` is mixed into the seed (beta-launch-fixes ticket 02); the program
 * now checks the randomness account against it itself (production-hardening
 * ticket 02), so a throwaway address no longer works.
 */
async function requestDraw(
  pool: PoolCtx,
  epochId: bigint,
  nonce: Uint8Array = testNonce(),
) {
  return requestDrawMethod(pool, epochId, nonce).rpc();
}

/** Draws `epochId` with randomness that lands the target in `owner`'s leaf, then
 *  returns the Epoch. Every Player holds Weight now, so a test that cares who wins
 *  has to pick the randomness. */
async function drawFor(pool: PoolCtx, epochId: bigint, owner: PublicKey) {
  const drawing = await fetchEpoch(pool, epochId);
  const player = await fetchPlayer(pool, owner);
  const weights = leafWeights(await fetchTree(pool), epochId);
  const leaf = player.leafIndex;
  const lo = weights.slice(0, leaf - 1).reduce((s, w) => s + w, 0n);
  const hi = lo + (weights[leaf - 1] as bigint);
  const randomness = randomnessForTarget(BigInt(drawing.registeredWeight.toString()), lo, hi);
  await draw(pool, epochId, await fulfillRandomness(Uint8Array.from(drawing.vrfSeed), randomness));
  return fetchEpoch(pool, epochId);
}

/** Permissionless (production-hardening ticket 01): first account is
 *  `caller`, not `operator`. */
async function draw(
  pool: PoolCtx,
  epochId: bigint,
  randomness: PublicKey,
  caller: Keypair = pool.operator,
) {
  return program.methods
    .draw()
    .accountsPartial({
      caller: caller.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      randomness,
    })
    .signers([caller])
    .rpc();
}

/** Permissionless: no signer at all, so the test wallet (neither the pool's
 *  admin nor its operator) just pays the fee. The operator cannot veto a
 *  winner by sitting out `payout_timeout`. A non-House winner needs no token
 *  account of their own: the prize compounds into `principal_vault`. */
async function payout(pool: PoolCtx, epochId: bigint, winner: PublicKey) {
  return program.methods
    .payout()
    .accountsPartial({
      pool: pool.pool,
      acceptedMint: pool.mint,
      epoch: epochPda(pool.pool, epochId),
      winner: playerPda(pool.pool, winner),
      jackpotVault: pool.jackpotVault,
      principalVault: pool.principalVault,
      treasury: pool.treasury,
      buybackReserve: pool.buybackReserve,
      ...pool.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/**
 * `seed` is the Epoch's own `vrfSeed` once requested (unused, any value
 * works, when rolling over a still-Ended epoch that was never
 * requested at all). The program checks the randomness account against it
 * and refuses to roll over a fulfilled request. Permissionless
 * (production-hardening ticket 01): first account is `caller`, not
 * `operator`.
 */
async function rolloverEpoch(
  pool: PoolCtx,
  epochId: bigint,
  seed: Uint8Array | number[],
  caller: Keypair = pool.operator,
) {
  return program.methods
    .rolloverEpoch()
    .accountsPartial({
      caller: caller.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      randomness: randomnessPda(Uint8Array.from(seed)),
    })
    .signers([caller])
    .rpc();
}

// --- Round helpers (rounds.rs is ticket 03's file; these just drive its
// already-landed instructions as a black box to forfeit a pot to the House.)

async function createRound(pool: PoolCtx, currentEpochId: bigint, roundId: bigint, startsAt: number, endsAt: number) {
  return program.methods
    .createRound(new BN(startsAt), new BN(endsAt))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      round: roundPda(pool.pool, roundId),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function buyPosition(pool: PoolCtx, owner: Wallet, roundId: bigint, tiles: bigint, stakePerTile: bigint) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round: roundPda(pool.pool, roundId),
      position: PublicKey.findProgramAddressSync(
        [Buffer.from("position"), roundPda(pool.pool, roundId).toBuffer(), owner.keypair.publicKey.toBuffer()],
        program.programId,
      )[0],
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

/** `nonce` is mixed into the seed (beta-launch-fixes ticket 02); returns the
 *  seed actually used, since the Round's `vrfSeed` is `[0; 32]` until this
 *  succeeds. */
async function requestRoundRandomness(
  pool: PoolCtx,
  roundId: bigint,
  nonce: Uint8Array = testNonce(),
): Promise<Uint8Array> {
  const seed = vrfSeed("round", pool.pool, roundId, nonce);
  await program.methods
    .requestRoundRandomness(Array.from(nonce))
    .accountsPartial({
      payer: pool.operator.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness: randomnessPda(seed),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
  return seed;
}

/** Permissionless (production-hardening ticket 01): first account is
 *  `caller`, not `operator`; `house` still pins to `pool.house`. */
async function settleRound(
  pool: PoolCtx,
  roundId: bigint,
  randomness: PublicKey,
  caller: Keypair = pool.operator,
) {
  return program.methods
    .settleRound()
    .accountsPartial({
      caller: caller.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness,
      house: pool.house,
    })
    .signers([caller])
    .rpc();
}

async function settlePosition(pool: PoolCtx, roundId: bigint, owner: PublicKey) {
  return program.methods
    .settlePosition()
    .accountsPartial({
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      player: playerPda(pool.pool, owner),
      owner,
      position: positionPda(roundPda(pool.pool, roundId), owner),
    })
    .rpc();
}

/**
 * `seed` is the Round's own `vrfSeed` once requested (unused, any value
 * works, when voiding a still-OPEN round that was never requested at all).
 * The program checks the randomness account against it and refuses to void a
 * request that was fulfilled. Permissionless (production-hardening ticket
 * 01): first account is `caller`, not `operator`.
 */
async function voidRound(
  pool: PoolCtx,
  roundId: bigint,
  seed: Uint8Array | number[],
  caller: Keypair = pool.operator,
) {
  return program.methods
    .voidRound()
    .accountsPartial({
      caller: caller.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness: randomnessPda(Uint8Array.from(seed)),
    })
    .signers([caller])
    .rpc();
}

async function fetchPlayer(pool: PoolCtx, owner: PublicKey) {
  return program.account.player.fetch(playerPda(pool.pool, owner));
}

async function fetchEpoch(pool: PoolCtx, epochId: bigint) {
  return program.account.epoch.fetch(epochPda(pool.pool, epochId));
}

describe("epochs", () => {
  it(
    "B depositing at half the epoch holds roughly half A's weight",
    async () => {
      const pool = await setupPool({ epochSeconds: 12 });
      // Wallet setup (airdrop, mint, ATA) is real wall-clock work; done
      // before `beginEpoch` fixes the epoch's `starts_at`, so it can't eat
      // into the window the midpoint math below assumes.
      const a = await pool.fundedWallet(10_000_000n);
      const b = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      const epoch1Open = await fetchEpoch(pool, 1n);
      // Polls the validator's actual on-chain clock for the midpoint
      // instead of comparing an on-chain deadline to `Date.now()`: the two
      // clocks drift apart, so a wall-clock sleep landed both deposits in
      // the same early sliver of the epoch rather than either side of its
      // midpoint.
      const startsAtSec = Number(epoch1Open.startsAt.toString());
      const endsAtSec = Number(epoch1Open.endsAt.toString());
      const midpointSec = Math.floor((startsAtSec + endsAtSec) / 2);

      const timeA = (await txInfo(await deposit(pool, a, 5_000_000n))).time;
      await sleepUntilOnChain(midpointSec);
      const timeB = (await txInfo(await deposit(pool, b, 5_000_000n))).time;

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const weightA = await weightOf(pool, a.keypair.publicKey, 1n);
      const weightB = await weightOf(pool, b.keypair.publicKey, 1n);

      // Exact recomputation from the deposit's own block time removes any
      // dependence on hitting the sleep timings precisely: a deposit credits
      // its Tickets for every second from then to the epoch's end at once.
      const endsAt = BigInt(epoch1Open.endsAt.toString());
      expect(weightA).toBe(5_000_000n * (endsAt - timeA));
      expect(weightB).toBe(5_000_000n * (endsAt - timeB));

      // And the human-readable check the ticket asks for: roughly 2:1,
      // within a second of clock tolerance either way.
      const ratio = Number(weightA) / Number(weightB);
      expect(ratio).toBeGreaterThanOrEqual(1.4);
      expect(ratio).toBeLessThan(2.7);
    },
    TIMEOUT,
  );

  it(
    "a player idle through a whole epoch holds principal x epoch length",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, epoch 2 open

      // Player does nothing at all during epoch 2.
      const epoch2 = await fetchEpoch(pool, 2n);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch2 ended, epoch 3 open

      const weight = await weightOf(pool, a.keypair.publicKey, 2n);

      const epochLen = BigInt(epoch2.endsAt.toString()) - BigInt(epoch2.startsAt.toString());
      expect(weight).toBe(4_000_000n * epochLen);
    },
    TIMEOUT,
  );

  it(
    "a player acting in N+1 leaves the Weight epoch N ended with where it was, unaffected by a later deposit",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      const depositTime = (await txInfo(await deposit(pool, a, 3_000_000n))).time;

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, epoch 2 open
      const endsAt = BigInt((await fetchEpoch(pool, 1n)).endsAt.toString());
      const before = await weightOf(pool, a.keypair.publicKey, 1n);
      expect(before).toBe(3_000_000n * (endsAt - depositTime));

      // Acting inside epoch 2, before anything draws for epoch 1.
      await deposit(pool, a, 1_000_000n);
      expect(await weightOf(pool, a.keypair.publicKey, 1n)).toBe(before);

      // A further deposit in epoch 2 does not move it either.
      await deposit(pool, a, 1_000_000n);
      expect(await weightOf(pool, a.keypair.publicKey, 1n)).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "a player who requests their whole balance mid-epoch keeps the weight they earned",
    async () => {
      const pool = await setupPool({ epochSeconds: 20 });
      const a = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n);

      const depositTime = (await txInfo(await deposit(pool, a, 5_000_000n))).time;
      await sleep(2_000);
      const requestTime = (await txInfo(await requestWithdraw(pool, a, 5_000_000n))).time;

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const weight = await weightOf(pool, a.keypair.publicKey, 1n);

      // Tickets were 0 for the rest of the epoch, so no further weight
      // accrues past the withdrawal: what was earned between the two
      // transactions, exactly.
      expect(weight).toBe(5_000_000n * (requestTime - depositTime));
      expect(weight > 0n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "request_draw refuses an epoch that is still Open, and one already requested",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      // Deposited before epoch 1 opens, so it holds the whole epoch whatever
      // the wallet setup costs in seconds.
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 2_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await fundJackpot(pool, funder, 1_000_000n);

      // Epoch 1 is still Open, not Ended.
      await expect(requestDraw(pool, 1n)).rejects.toThrow(/EpochNotAwaitingDraw/);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended

      await requestDraw(pool, 1n);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWING);
      await expect(requestDraw(pool, 1n)).rejects.toThrow(/EpochNotAwaitingDraw/);
    },
    TIMEOUT,
  );

  it(
    "request_draw with zero total weight rolls over and leaves the jackpot in the vault",
    async () => {
      const pool = await setupPool({ epochSeconds: 4 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 5_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, nobody holds Weight

      await requestDraw(pool, 1n);

      const epoch = await fetchEpoch(pool, 1n);
      expect(epoch.status).toBe(epoch_status.ROLLED_OVER);
      expect(epoch.jackpotAmount.toString()).toBe("5000000");

      const vault = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vault.value.amount).toBe("5000000");
    },
    TIMEOUT,
  );

  it(
    "request_draw rolls over when the jackpot vault is under min_jackpot, and draws once it is not",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, minJackpot: 2_000_000 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await fundJackpot(pool, funder, 1_999_999n); // one unit short

      await retryUntilOk(() => beginEpoch(pool, 1n));
      const sig = await requestDraw(pool, 1n);

      const epoch1 = await fetchEpoch(pool, 1n);
      expect(epoch1.status).toBe(epoch_status.ROLLED_OVER);
      expect(epoch1.jackpotAmount.toString()).toBe("1999999");
      const event = await findEvent<{ epochId: BN; jackpotAmount: BN }>(sig, "epochRolledOver");
      expect(event?.epochId.toString()).toBe("1");
      // Weight was not the reason: the epoch had a depositor.
      expect(BigInt(epoch1.registeredWeight.toString()) > 0n).toBe(true);

      // The prize stayed put, so one more unit clears the floor next epoch.
      await fundJackpot(pool, funder, 1n);
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await requestDraw(pool, 2n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.status).toBe(epoch_status.DRAWING);
      expect(epoch2.jackpotAmount.toString()).toBe("2000000");
    },
    TIMEOUT,
  );

  it(
    "a player who lost every Entry can still request their whole Principal, and is paid after the boundary",
    async () => {
      const pool = await setupPool({ epochSeconds: 30, roundSeconds: 5, closeBuffer: 1 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      // Everything on tile 0, and tile 5 wins: the pot forfeits to the House
      // and Alice is left holding Entries 0 against Principal 5M.
      const startsAt = await onChainNowSeconds();
      await createRound(pool, 1n, 1n, startsAt, startsAt + 5);
      await buyPosition(pool, alice, 1n, 1n << 0n, 5_000_000n);
      const seed1 = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      await settleRound(pool, 1n, await fulfillRandomness(seed1, randomnessFor(5)));
      expect((await program.account.round.fetch(roundPda(pool.pool, 1n))).status).toBe(
        round_status.FORFEITED,
      );
      expect((await fetchPlayer(pool, alice.keypair.publicKey)).entries.toString()).toBe("0");

      // The old `entries >= amount` rule would have locked her out here.
      await requestWithdraw(pool, alice, 5_000_000n);
      const requested = await fetchPlayer(pool, alice.keypair.publicKey);
      expect(requested.principal.toString()).toBe("0");
      expect(requested.pendingWithdraw.toString()).toBe("5000000");
      expect(requested.pendingEpoch.toString()).toBe("1");

      // Mid-epoch the pool's Entries now exceed its Principal: the House
      // still holds Alice's 5M while total_principal has dropped to 0.
      const midPool = await program.account.pool.fetch(pool.pool);
      const midHouse = await fetchPlayer(pool, pool.operator.publicKey);
      expect(midPool.totalPrincipal.toString()).toBe("0");
      expect(midPool.pendingWithdrawals.toString()).toBe("5000000");
      expect(BigInt(midHouse.entries.toString())).toBeGreaterThan(
        BigInt(midPool.totalPrincipal.toString()),
      );

      const before = await program.provider.connection.getTokenAccountBalance(alice.tokenAccount);
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await processWithdraw(pool, alice);
      const after = await program.provider.connection.getTokenAccountBalance(alice.tokenAccount);
      expect(BigInt(after.value.amount) - BigInt(before.value.amount)).toBe(5_000_000n);

      const paid = await fetchPlayer(pool, alice.keypair.publicKey);
      expect(paid.pendingWithdraw.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).pendingWithdrawals.toString()).toBe("0");

      // Equality comes back at the epoch start, once each Player is touched.
      // An empty round always touches the House on settlement, which is what
      // resets the Entries it was holding for the epoch that ended.
      const round2Start = await onChainNowSeconds();
      await createRound(pool, 2n, 2n, round2Start, round2Start + 5);
      const seed2 = await retryUntilOk(() => requestRoundRandomness(pool, 2n));
      await settleRound(pool, 2n, await fulfillRandomness(seed2, randomnessFor(5)));

      const endPool = await program.account.pool.fetch(pool.pool);
      const endHouse = await fetchPlayer(pool, pool.operator.publicKey);
      const endAlice = await fetchPlayer(pool, alice.keypair.publicKey);
      const entriesSum = BigInt(endHouse.entries.toString()) + BigInt(endAlice.entries.toString());
      expect(entriesSum).toBe(BigInt(endPool.totalPrincipal.toString()));
    },
    TIMEOUT,
  );

  it(
    "draw and payout to a player: the prize compounds into Principal, total_principal and the principal vault, and can be withdrawn",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      await requestDraw(pool, 1n);

      const epochAfterClose = await fetchEpoch(pool, 1n);
      expect(epochAfterClose.status).toBe(epoch_status.DRAWING);
      // The snapshot is the tree's total for the epoch: `a` holds all of it.
      expect(epochAfterClose.registeredWeight.toString()).toBe(
        (await weightOf(pool, a.keypair.publicKey, 1n)).toString(),
      );

      const randomness = await fulfillRandomness(Uint8Array.from(epochAfterClose.vrfSeed));
      await draw(pool, 1n, randomness);

      const drawn = await fetchEpoch(pool, 1n);
      expect(drawn.status).toBe(epoch_status.DRAWN);

      const principalVaultBefore = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      const playerBefore = await fetchPlayer(pool, a.keypair.publicKey);
      const poolBefore = await program.account.pool.fetch(pool.pool);

      const sig = await payout(pool, 1n, a.keypair.publicKey);

      const principalVaultAfter = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      const playerAfter = await fetchPlayer(pool, a.keypair.publicKey);
      const poolAfter = await program.account.pool.fetch(pool.pool);

      expect(
        BigInt(principalVaultAfter.value.amount) - BigInt(principalVaultBefore.value.amount),
      ).toBe(2_000_000n);
      expect(
        BigInt(playerAfter.principal.toString()) - BigInt(playerBefore.principal.toString()),
      ).toBe(2_000_000n);
      expect(
        BigInt(playerAfter.entries.toString()) - BigInt(playerBefore.entries.toString()),
      ).toBe(2_000_000n);
      expect(
        BigInt(poolAfter.totalPrincipal.toString()) - BigInt(poolBefore.totalPrincipal.toString()),
      ).toBe(2_000_000n);

      const event = await findEvent<{ isHouse: boolean; compounded: boolean; amount: BN }>(
        sig,
        "jackpotPaid",
      );
      expect(event?.isHouse).toBe(false);
      expect(event?.compounded).toBe(true);
      expect(event?.amount.toString()).toBe("2000000");

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(a.keypair.publicKey.toString());

      // The prize is ordinary Principal now: withdrawable through the
      // normal locked flow, same as any other deposit.
      const tokenBefore = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      await requestWithdraw(pool, a, 2_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await processWithdraw(pool, a);
      const tokenAfter = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      expect(BigInt(tokenAfter.value.amount) - BigInt(tokenBefore.value.amount)).toBe(2_000_000n);
    },
    TIMEOUT,
  );

  it(
    "the House wins: buyback gets 50%, treasury 20%, the vault keeps 30%",
    async () => {
      const pool = await setupPool({ epochSeconds: 14, roundSeconds: 5, closeBuffer: 0 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 6_000_000n);

      await beginEpoch(pool, 0n);

      const startsAt = Math.floor(Date.now() / 1000);
      const endsAt = startsAt + 5;
      await createRound(pool, 1n, 1n, startsAt, endsAt);

      // A stakes everything on tile 0 only, leaving every other tile
      // uncovered so the draw below is guaranteed to forfeit.
      await buyPosition(pool, a, 1n, 1n, 6_000_000n);

      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      // Tile 1 is not covered by A's position (only tile 0 is): forfeit.
      const roundRandomness = await fulfillRandomness(seed, randomnessFor(1));
      await settleRound(pool, 1n, roundRandomness);

      const roundAfter = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(roundAfter.status).toBe(round_status.FORFEITED);

      // --- Closing invariant sweep (spec §2.4 #1-2), right after the
      // forfeit: A's stake left `entries`, and reappeared whole in the
      // House's, so both should still add up to total_principal exactly.
      // Nothing is pending here; a `request_withdraw` would let Entries
      // exceed Principal until the next boundary (ADR 0009).
      const poolAfterForfeit = await program.account.pool.fetch(pool.pool);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const house = await fetchPlayer(pool, pool.operator.publicKey);
      const principalVaultBalance = await program.provider.connection.getTokenAccountBalance(pool.principalVault);

      expect(playerA.principal.toString()).toBe(poolAfterForfeit.totalPrincipal.toString());
      expect(principalVaultBalance.value.amount).toBe(poolAfterForfeit.totalPrincipal.toString());
      expect(house.isHouse).toBe(true);
      expect(house.entries.toString()).toBe("6000000");
      expect(playerA.entries.toString()).toBe("0");
      const entriesSum = BigInt(playerA.entries.toString()) + BigInt(house.entries.toString());
      expect(entriesSum).toBe(BigInt(poolAfterForfeit.totalPrincipal.toString()));

      // --- The House now holds forfeited Tickets, so it holds Weight in the
      // tree too. Fund, request the draw, land the target in the House's leaf,
      // pay out, and check the split.
      await retryUntilOk(() => beginEpoch(pool, 1n));
      expect((await weightOf(pool, pool.operator.publicKey, 1n)) > 0n).toBe(true);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);
      await requestDraw(pool, 1n);

      const closed = await fetchEpoch(pool, 1n);
      expect(closed.status).toBe(epoch_status.DRAWING);

      await drawFor(pool, 1n, pool.operator.publicKey);

      const buybackBefore = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryBefore = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultBefore = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      const sig = await payout(pool, 1n, pool.operator.publicKey);

      const buybackAfter = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryAfter = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultAfter = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      expect(BigInt(buybackAfter.value.amount) - BigInt(buybackBefore.value.amount)).toBe(500_000n); // 50%
      expect(BigInt(treasuryAfter.value.amount) - BigInt(treasuryBefore.value.amount)).toBe(200_000n); // 20%
      expect(BigInt(vaultBefore.value.amount) - BigInt(vaultAfter.value.amount)).toBe(700_000n); // 70% left
      expect(vaultAfter.value.amount).toBe("300000"); // 30% stays

      const event = await findEvent<{ isHouse: boolean; compounded: boolean }>(sig, "jackpotPaid");
      expect(event?.isHouse).toBe(true);
      expect(event?.compounded).toBe(false);

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(pool.operator.publicKey.toString());
    },
    TIMEOUT,
  );

  it(
    "rollover_epoch after the timeout leaves the vault intact, and the next request_draw commits the larger amount",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);
      await requestDraw(pool, 1n);

      const drawing = await fetchEpoch(pool, 1n);
      expect(drawing.status).toBe(epoch_status.DRAWING);

      // past vrf_timeout(2s), never fulfilled. A stranger drives it
      // (production-hardening 14, Finding 6): the handler never reads
      // `caller`, so this pins that no `has_one` creeps back in.
      const stranger = await pool.fundedWallet(0n);
      await retryUntilOk(() => rolloverEpoch(pool, 1n, drawing.vrfSeed, stranger.keypair));

      const rolled = await fetchEpoch(pool, 1n);
      expect(rolled.status).toBe(epoch_status.ROLLED_OVER);
      const vaultAfterRollover = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vaultAfterRollover.value.amount).toBe("3000000");

      // Fund more, let epoch 2 elapse too, and confirm the next
      // request_draw snapshots the grown total, not the stale 3M.
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 2n));
      await requestDraw(pool, 2n);

      const epoch2After = await fetchEpoch(pool, 2n);
      expect(epoch2After.jackpotAmount.toString()).toBe("5000000");
    },
    TIMEOUT,
  );

  it(
    "an unpaid drawn epoch keeps its prize: the next request only snapshots the new deposits",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      // Both deposit before the first epoch opens, so each holds the whole
      // of epoch 1 and cannot come out at zero weight.
      const a = await pool.fundedWallet(10_000_000n);
      const b = await pool.fundedWallet(10_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      await deposit(pool, b, 3_000_000n);

      await beginEpoch(pool, 0n); // epoch 1
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      await requestDraw(pool, 1n);
      const closed1 = await fetchEpoch(pool, 1n);
      expect(closed1.jackpotAmount.toString()).toBe("3000000");
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe(
        "3000000",
      );
      await drawFor(pool, 1n, a.keypair.publicKey);

      // beta-launch-fixes ticket 03: begin_epoch refuses while the epoch two
      // behind the new one is still Drawing or Drawn, so epoch 1's winner
      // (`a`) must be paid before epoch 3 can ever open -- otherwise the tree
      // would stop holding epoch 1's leaf ranges that payout checks. Prize
      // compounds into the principal vault, not a.'s own token account.
      const principalBeforeFirst = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      await payout(pool, 1n, a.keypair.publicKey);
      const principalAfterFirst = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      expect(
        BigInt(principalAfterFirst.value.amount) - BigInt(principalBeforeFirst.value.amount),
      ).toBe(3_000_000n);
      expect((await fetchPlayer(pool, a.keypair.publicKey)).principal.toString()).toBe("6000000");

      // Epoch 1 is now Paid. The next epoch must draw for its own 2M only.
      await fundJackpot(pool, funder, 2_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3
      await requestDraw(pool, 2n);
      const closed2 = await fetchEpoch(pool, 2n);
      expect(closed2.jackpotAmount.toString()).toBe("2000000");
      await drawFor(pool, 2n, b.keypair.publicKey);

      await payout(pool, 2n, b.keypair.publicKey);
      expect((await fetchPlayer(pool, b.keypair.publicKey)).principal.toString()).toBe("5000000");

      const drained = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(drained.value.amount).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "rollover_epoch is refused once the draw's randomness has been fulfilled",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);
      await requestDraw(pool, 1n);

      const drawing = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(drawing.vrfSeed));
      // Past vrf_timeout, so the fulfilment is the only thing standing
      // between the operator and a rollover of a draw it has already read.
      await sleepUntilOnChain(Number(drawing.requestedAt.toString()) + 2 + 1);

      await expect(rolloverEpoch(pool, 1n, drawing.vrfSeed)).rejects.toThrow(
        /RandomnessAlreadyFulfilled/,
      );

      await draw(pool, 1n, randomness);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWN);
    },
    TIMEOUT,
  );

  it(
    "an Epoch left ENDED past its end plus vrf_timeout can be rolled over with nothing reserved",
    async () => {
      // beta-launch-fixes ticket 02: the draw was never requested (e.g. the
      // Operator crashed), so the epoch is stuck Ended forever without this
      // exit.
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await beginEpoch(pool, 0n);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      const ended = await fetchEpoch(pool, 1n);
      expect(ended.status).toBe(epoch_status.ENDED);

      // Past vrf_timeout(2s) from when begin_epoch handed it over.
      await sleepUntilOnChain(Number(ended.registrationOpenedAt.toString()) + 2 + 1);

      const jackpotBefore = await program.provider.connection.getTokenAccountBalance(
        pool.jackpotVault,
      );
      // Any placeholder randomness account: the Ended branch never
      // reads it (there was never a request to check). Driven by a stranger
      // (production-hardening 14, Finding 6).
      const stranger = await pool.fundedWallet(0n);
      const sig = await rolloverEpoch(pool, 1n, new Uint8Array(32), stranger.keypair);

      const rolled = await fetchEpoch(pool, 1n);
      expect(rolled.status).toBe(epoch_status.ROLLED_OVER);
      expect(rolled.jackpotAmount.toString()).toBe("0"); // never snapshotted
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe("0");
      // Nothing moved: the whole prize stays in the hexpot for the next epoch.
      const jackpotAfter = await program.provider.connection.getTokenAccountBalance(
        pool.jackpotVault,
      );
      expect(jackpotAfter.value.amount).toBe(jackpotBefore.value.amount);

      const event = await findEvent<{ epochId: BN; jackpotAmount: BN }>(sig, "epochRolledOver");
      expect(event?.epochId.toString()).toBe("1");
      expect(event?.jackpotAmount.toString()).toBe("0");

      // begin_epoch is then accepted, and the next draw request snapshots
      // the whole 3M the rolled-over epoch left in the vault.
      await retryUntilOk(() => beginEpoch(pool, 2n));
      expect((await fetchEpoch(pool, 3n)).status).toBe(epoch_status.OPEN);
      await requestDraw(pool, 2n);
      expect((await fetchEpoch(pool, 2n)).jackpotAmount.toString()).toBe("3000000");
    },
    TIMEOUT,
  );

  it(
    "begin_epoch refuses while the epoch two behind the new one is still Drawing or Drawn",
    async () => {
      // beta-launch-fixes ticket 03: the held-draw sequence from the
      // readiness report -- delay draw/payout until the next epoch begins
      // and the tree stops holding the winner's leaf range -- is refused at
      // the source.
      const pool = await setupPool({ epochSeconds: 6 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2 open, epoch 1 Ended
      await requestDraw(pool, 1n); // epoch 1: Drawing

      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWING);

      // epoch 2 -> Ended, epoch 3 would open; epoch 1 (two behind epoch
      // 3) is still Drawing.
      await sleepUntilOnChain(Number((await program.account.pool.fetch(pool.pool)).currentEpochEndsAt.toString()));
      await expect(beginEpoch(pool, 2n)).rejects.toThrow(/PreviousEpochStillDrawing/);

      // Drawing the epoch and paying its winner clears the way.
      const drawing = await fetchEpoch(pool, 1n);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(drawing.vrfSeed)));
      await expect(beginEpoch(pool, 2n)).rejects.toThrow(/PreviousEpochStillDrawing/); // still Drawn, unpaid

      await payout(pool, 1n, a.keypair.publicKey);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // now accepted
      expect((await fetchEpoch(pool, 3n)).status).toBe(epoch_status.OPEN);
    },
    TIMEOUT,
  );

  it(
    "request_draw checks its own randomness account, and draw accepts any caller",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await beginEpoch(pool, 0n);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));

      // production-hardening ticket 02: request_draw checks the
      // randomness account against its own computed seed, the same way
      // request_round_randomness does.
      const wrongNonce = testNonce(9);
      const wrongSeed = vrfSeed("epoch", pool.pool, 2n, wrongNonce); // another epoch's seed
      await expect(
        requestDrawMethod(pool, 1n, testNonce(), randomnessPda(wrongSeed)).rpc(),
      ).rejects.toThrow(/InvalidRandomnessAccount/);

      await requestDraw(pool, 1n);

      // Permissionless (production-hardening ticket 01): a stranger, not the
      // operator, drives draw and rollover_epoch (and settle_round/void_round
      // in tests/01-custody.test.ts).
      const stranger = Keypair.generate();
      await program.provider.connection.confirmTransaction(
        await program.provider.connection.requestAirdrop(stranger.publicKey, 2_000_000_000),
        "confirmed",
      );

      const drawing = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(drawing.vrfSeed));
      await draw(pool, 1n, randomness, stranger);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWN);
    },
    TIMEOUT,
  );

  // The two registration-window tests (a late registrant still lands; a
  // delayed begin_epoch still owes the window) went with the window itself
  // (ADR 0018). Every Player is in the draw with no transaction, so there is
  // nothing left to wait for.

  it(
    "a drawn epoch nobody can be paid rolls over after payout_timeout, and its prize carries",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, payoutTimeout: 2 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await fundJackpot(pool, funder, 4_000_000n);
      await requestDraw(pool, 1n);

      const closed = await fetchEpoch(pool, 1n);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(closed.vrfSeed)));
      const drawn = await fetchEpoch(pool, 1n);
      expect(Number(drawn.drawnAt.toString())).toBeGreaterThan(0);

      // The winner is known, so until the timeout the only way out is to pay.
      await expect(rolloverEpoch(pool, 1n, drawn.vrfSeed)).rejects.toThrow(
        /PayoutTimeoutNotElapsed/,
      );

      await sleepUntilOnChain(Number(drawn.drawnAt.toString()) + 2 + 1);
      // A stranger drives the Drawn rollover (production-hardening 14, Finding 6).
      const stranger = await pool.fundedWallet(0n);
      await rolloverEpoch(pool, 1n, drawn.vrfSeed, stranger.keypair);

      const rolled = await fetchEpoch(pool, 1n);
      expect(rolled.status).toBe(epoch_status.ROLLED_OVER);
      expect(rolled.winner.toString()).toBe(PublicKey.default.toString());
      const vault = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vault.value.amount).toBe("4000000");
      // The reservation went with it, or the next close would snapshot 0.
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe("0");

      // Nothing was paid, so the next epoch draws for the same prize.
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await requestDraw(pool, 2n);
      expect((await fetchEpoch(pool, 2n)).jackpotAmount.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "begin_epoch before the current epoch's ends_at fails",
    async () => {
      const pool = await setupPool();
      await beginEpoch(pool, 0n);
      await expect(beginEpoch(pool, 1n)).rejects.toThrow();
    },
    TIMEOUT,
  );

  // --- The anchored grid (epoch-anchor/02). Every boundary is a point of
  // `epochAnchor + k * epochSeconds`. These pools set the anchor a few
  // seconds ahead of `setupPool`, so epoch 1 is a short stub ending on the
  // first grid point and epoch 2 onwards run a full period. The clock cannot
  // be warped on localnet, so "minutes late" and "a whole period late" are
  // scaled down to seconds against a period of seconds; the arithmetic is
  // the same one an hourly pool goes through.

  const GRID_LEAD = 12;

  it(
    "an operator seconds late keeps the epochs contiguous",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 10, epochAnchor: anchor });

      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);
      // retryUntilOk polls every 750ms, so this lands within a second of the
      // boundary.
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.startsAt.toString()).toBe(epoch1.endsAt.toString());
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(10);
    },
    TIMEOUT,
  );

  it(
    "an operator well past the boundary but inside the period keeps the epochs contiguous",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 20, epochAnchor: anchor });

      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);
      await sleepUntilOnChain(Number(epoch1.endsAt) + 9);
      await beginEpoch(pool, 1n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.startsAt.toString()).toBe(epoch1.endsAt.toString());
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(20);
    },
    TIMEOUT,
  );

  it(
    "an operator a whole period late jumps to the current grid point",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 8, epochAnchor: anchor });
      const a = await pool.fundedWallet(10_000_000n);

      // Deposited before the first epoch opens, so this player holds Entries
      // for every second of the stub whatever length it turns out to be.
      await deposit(pool, a, 4_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);
      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);

      // Past the boundary *and* past the grid point after it.
      await sleepUntilOnChain(Number(epoch1.endsAt) + 8 + 1);
      await beginEpoch(pool, 1n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(Number(epoch2.startsAt)).toBe(Number(epoch1.endsAt) + 8);
      expect((Number(epoch2.startsAt) - anchor) % 8).toBe(0);
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(8);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.ENDED);

      // Epoch 1, skipped past and not orphaned, still runs its own draw and
      // pays out: its Weight is the whole stub, and it stays readable while
      // epoch 2 is current.
      const stub = BigInt(epoch1.endsAt.toString()) - BigInt(epoch1.startsAt.toString());
      expect(await weightOf(pool, a.keypair.publicKey, 1n)).toBe(4_000_000n * stub);
      await requestDraw(pool, 1n);
      await drawFor(pool, 1n, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.PAID);
    },
    TIMEOUT,
  );

  it(
    "the first epoch is a stub ending on the grid",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 30, epochAnchor: anchor });
      const a = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      const depositTime = (await txInfo(await deposit(pool, a, 5_000_000n))).time;

      const epoch1 = await fetchEpoch(pool, 1n);
      const startsAt = BigInt(epoch1.startsAt.toString());
      const endsAt = BigInt(epoch1.endsAt.toString());
      expect(endsAt).toBe(BigInt(anchor)); // the first grid point after bootstrap
      expect(Number(endsAt - startsAt)).toBeGreaterThan(0);
      expect(Number(endsAt - startsAt)).toBeLessThan(30);
      // The deposit's Weight covers only the stub's own length, read from
      // the Weight tree: never a full 30 second period.
      const weight = await weightOf(pool, a.keypair.publicKey, 1n);
      expect(weight).toBe(5_000_000n * (endsAt - depositTime));
      expect(weight).toBeLessThan(5_000_000n * 30n);
    },
    TIMEOUT,
  );

  it(
    "raising epoch_seconds mid-epoch gives one short transition epoch, then the new cadence",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      // payoutTimeout below the new 24s cadence: set_params requires
      // payout_timeout < epoch_seconds on the final values (beta-launch-fixes
      // ticket 03), and the pool's own default (82_800s) would otherwise
      // refuse the setParams(pool, 24) call below, which never touches
      // payout_timeout at all.
      const pool = await setupPool({ epochSeconds: 8, epochAnchor: anchor, payoutTimeout: 4 });
      const a = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n); // epoch 1: the stub
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: a full 8s period
      const epoch2 = await fetchEpoch(pool, 2n);
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(8);

      const depositTime = (await txInfo(await deposit(pool, a, 5_000_000n))).time;

      await setParams(pool, 24); // the daily-to-weekly switch, scaled down

      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3: the transition
      const epoch3 = await fetchEpoch(pool, 3n);
      expect(epoch3.startsAt.toString()).toBe(epoch2.endsAt.toString());
      expect((Number(epoch3.endsAt) - anchor) % 24).toBe(0);
      expect(Number(epoch3.endsAt) - Number(epoch3.startsAt)).toBeLessThan(24);

      // Epoch 2's Weight ends where its own Epoch account says it did, not
      // 24s after it started.
      expect(await weightOf(pool, a.keypair.publicKey, 2n)).toBe(
        5_000_000n * (BigInt(epoch2.endsAt.toString()) - depositTime),
      );

      await retryUntilOk(() => beginEpoch(pool, 3n)); // epoch 4: the new cadence
      const epoch4 = await fetchEpoch(pool, 4n);
      expect(Number(epoch4.endsAt) - Number(epoch4.startsAt)).toBe(24);
    },
    TIMEOUT,
  );

  // --- Cross-epoch Round settlement (audit-fixes/01): the program's own
  // guard against crediting a Round into an Epoch it didn't run in. `touch`
  // has already reset Entries to Principal for anyone it sees by the time
  // these settle, so the pot has to evaporate instead of paying out, or the
  // invariant below would drift.

  it(
    "a Round settled after its Epoch rolls over pays nothing, but stays zero-sum",
    async () => {
      const pool = await setupPool({ epochSeconds: 24, roundSeconds: 8, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 8; // the Round ends exactly at the Epoch's ends_at

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n); // tile 0
      await buyPosition(pool, bob, 1n, 1n << 1n, 1_000_000n); // tile 1

      await sleepUntilOnChain(endsAt);
      // Roll the Epoch before the Round is ever settled: the program's own
      // guard, not the operator's ordering, is what has to hold here.
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      const randomness = await fulfillRandomness(seed, randomnessFor(0)); // tile 0 wins
      await settleRound(pool, 1n, randomness);

      const settled = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(settled.status).toBe(round_status.SETTLED);
      // The Round records the cut it would have taken, but the Epoch has
      // rolled over, so it evaporated with the rest of the pot instead of
      // reaching the House.
      expect(settled.houseCut.toString()).toBe("120000"); // 6% of 2M
      expect((await fetchPlayer(pool, pool.operator.publicKey)).entries.toString()).toBe("0");

      const alicePositionPda = positionPda(roundPda(pool.pool, 1n), alice.keypair.publicKey);
      const bobPositionPda = positionPda(roundPda(pool.pool, 1n), bob.keypair.publicKey);
      const aliceRentBefore = (await program.provider.connection.getAccountInfo(alicePositionPda))!.lamports;
      const bobRentBefore = (await program.provider.connection.getAccountInfo(bobPositionPda))!.lamports;
      const aliceBalBefore = await program.provider.connection.getBalance(alice.keypair.publicKey);
      const bobBalBefore = await program.provider.connection.getBalance(bob.keypair.publicKey);

      const aliceSig = await settlePosition(pool, 1n, alice.keypair.publicKey);
      const bobSig = await settlePosition(pool, 1n, bob.keypair.publicKey);

      const aliceEvent = await findEvent<{ reward: BN }>(aliceSig, "positionSettled");
      const bobEvent = await findEvent<{ reward: BN }>(bobSig, "positionSettled");
      expect(aliceEvent?.reward.toString()).toBe("0");
      expect(bobEvent?.reward.toString()).toBe("0");

      const playerA = await fetchPlayer(pool, alice.keypair.publicKey);
      const playerB = await fetchPlayer(pool, bob.keypair.publicKey);
      const house = await fetchPlayer(pool, pool.operator.publicKey);
      const poolAfter = await program.account.pool.fetch(pool.pool);

      const entriesSum =
        BigInt(playerA.entries.toString()) + BigInt(playerB.entries.toString()) + BigInt(house.entries.toString());
      expect(entriesSum).toBe(BigInt(poolAfter.totalPrincipal.toString()));

      await expect(program.account.position.fetch(alicePositionPda)).rejects.toThrow();
      await expect(program.account.position.fetch(bobPositionPda)).rejects.toThrow();
      expect(await program.provider.connection.getBalance(alice.keypair.publicKey)).toBe(
        aliceBalBefore + aliceRentBefore,
      );
      expect(await program.provider.connection.getBalance(bob.keypair.publicKey)).toBe(bobBalBefore + bobRentBefore);
    },
    TIMEOUT,
  );

  it(
    "a forfeited Round from an ended Epoch credits the House nothing",
    async () => {
      const pool = await setupPool({ epochSeconds: 24, roundSeconds: 8, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 8;

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n); // tile 0 only

      await sleepUntilOnChain(endsAt);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const houseBefore = await fetchPlayer(pool, pool.operator.publicKey);

      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      const randomness = await fulfillRandomness(seed, randomnessFor(5)); // nobody on tile 5
      await settleRound(pool, 1n, randomness);

      const settled = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(settled.status).toBe(round_status.FORFEITED);

      const houseAfter = await fetchPlayer(pool, pool.operator.publicKey);
      expect(houseAfter.entries.toString()).toBe(houseBefore.entries.toString());
    },
    TIMEOUT,
  );

  // Skipped until yield-claimer ticket 11: `carry_pot` is gone (ADR 0019),
  // and ticket 11's refund-after-rollover rule replaces what this checked.
  it.skip(
    "voiding a Round from an ended Epoch adds nothing to carry_pot",
    async () => {
      const pool = await setupPool({ epochSeconds: 20, roundSeconds: 6, closeBuffer: 1, vrfTimeout: 2 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 6;

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n);

      await sleepUntilOnChain(endsAt);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(round.pot.toString()).toBe("1000000");
      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));

      const requested = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await sleepUntilOnChain(Number(requested.requestedAt.toString()) + 2 + 1); // past vrf_timeout

      const poolBeforeVoid = await program.account.pool.fetch(pool.pool);
      expect(poolBeforeVoid.carryPot.toString()).toBe("0");
      const sig = await retryUntilOk(() => voidRound(pool, 1n, seed));

      const voided = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(voided.status).toBe(round_status.VOIDED);

      const poolAfterVoid = await program.account.pool.fetch(pool.pool);
      expect(poolAfterVoid.carryPot.toString()).toBe("0"); // the 1M pot evaporated, not carried

      const event = await findEvent<{ carryPot: BN }>(sig, "roundVoided");
      expect(event?.carryPot.toString()).toBe("0");
    },
    TIMEOUT,
  );

  // --- Base yield (hexo-referrals ticket 01, ADR 0011) went with `register`
  // and `fund_yield` (ADR 0017). Ticket 06's Yield index tests replace it.

  // --- Bought tickets (hexo-referrals ticket 03). `buy_tickets` spends real
  // USDC into the jackpot vault and credits `amount * tickets_per_usdc`
  // ordinary Entries, capped per Player per epoch at Principal.

  it(
    "refuses before the first epoch exists",
    async () => {
      // beta-launch-fixes ticket 03: buy_tickets requires current_epoch_id >
      // 0, so Entries bought before Epoch 1 begins (and are lost the moment
      // it does) can never be paid for in the first place.
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);

      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/NoEpochYet/);

      await beginEpoch(pool, 0n); // epoch 1 now exists
      await buyTickets(pool, owner, 1_000_000n); // now succeeds
    },
    TIMEOUT,
  );

  it(
    "credits tickets at the pool rate, moves real USDC to the jackpot vault, and emits TicketsBought",
    async () => {
      const pool = await setupPool({ ticketsPerUsdc: 10 });
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open: buy_tickets now requires one

      const jackpotBefore = BigInt(
        (await program.provider.connection.getTokenAccountBalance(pool.jackpotVault)).value.amount,
      );
      const walletBefore = BigInt(
        (await program.provider.connection.getTokenAccountBalance(owner.tokenAccount)).value.amount,
      );

      const sig = await buyTickets(pool, owner, 1_000_000n);

      const jackpotAfter = BigInt(
        (await program.provider.connection.getTokenAccountBalance(pool.jackpotVault)).value.amount,
      );
      const walletAfter = BigInt(
        (await program.provider.connection.getTokenAccountBalance(owner.tokenAccount)).value.amount,
      );
      expect(jackpotAfter - jackpotBefore).toBe(1_000_000n);
      expect(walletBefore - walletAfter).toBe(1_000_000n);

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("4000000"); // unaffected: only entries move
      expect(player.entries.toString()).toBe("14000000"); // 4_000_000 + 1_000_000 * 10
      expect(player.boughtAmount.toString()).toBe("1000000");
      expect(player.boughtEpoch.toString()).toBe("1");

      const event = await findEvent<{ owner: PublicKey; epochId: BN; usdc: BN; tickets: BN }>(
        sig,
        "ticketsBought",
      );
      expect(event?.owner.toString()).toBe(owner.keypair.publicKey.toString());
      expect(event?.epochId.toString()).toBe("1");
      expect(event?.usdc.toString()).toBe("1000000");
      expect(event?.tickets.toString()).toBe("10000000");
    },
    TIMEOUT,
  );

  it(
    "the cap is exactly Principal: reaching it exactly succeeds, one more fails, and a new epoch resets it",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 3_000_000n);

      await buyTickets(pool, owner, 2_000_000n);
      await buyTickets(pool, owner, 1_000_000n); // lands exactly on the cap
      expect(
        (await fetchPlayer(pool, owner.keypair.publicKey)).boughtAmount.toString(),
      ).toBe("3000000");

      await expect(buyTickets(pool, owner, 1n)).rejects.toThrow(/DailyBuyCapExceeded/);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2 open
      await buyTickets(pool, owner, 3_000_000n); // fresh cap, same Principal

      const afterReset = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(afterReset.boughtAmount.toString()).toBe("3000000");
      expect(afterReset.boughtEpoch.toString()).toBe("2");
    },
    TIMEOUT,
  );

  it(
    "the House cannot buy tickets, and a paused pool refuses everyone",
    async () => {
      const pool = await setupPool();
      await beginEpoch(pool, 0n); // epoch 1 open: buy_tickets requires one
      const operatorAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );
      await mintTo(
        program.provider.connection,
        pool.operator,
        pool.mint,
        operatorAta.address,
        pool.operator,
        5_000_000n,
      );

      await expect(
        program.methods
          .buyTickets(new BN(1_000_000))
          .accountsPartial({
            owner: pool.operator.publicKey,
            pool: pool.pool,
            player: pool.house,
            acceptedMint: pool.mint,
            ownerToken: operatorAta.address,
            jackpotVault: pool.jackpotVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([pool.operator])
          .rpc(),
      ).rejects.toThrow(/HouseCannotBuyTickets/);

      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await setPause(pool, true);
      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/PoolPaused/);
    },
    TIMEOUT,
  );

  it(
    "a request_withdraw before buying only tightens the same-epoch cap, never bypasses it",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open: buy_tickets requires one
      await deposit(pool, owner, 5_000_000n);

      // Principal drops from 5M to 2M; bought_amount is still 0, so nothing
      // carried over gives back the room this just took away.
      await requestWithdraw(pool, owner, 3_000_000n);
      expect(
        (await fetchPlayer(pool, owner.keypair.publicKey)).principal.toString(),
      ).toBe("2000000");

      await expect(buyTickets(pool, owner, 2_000_001n)).rejects.toThrow(/DailyBuyCapExceeded/);
      await buyTickets(pool, owner, 2_000_000n); // exactly what's left, not the original 5M
      await expect(buyTickets(pool, owner, 1n)).rejects.toThrow(/DailyBuyCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "buying right after begin_epoch spends against the new epoch's cap, not the one just ended",
    async () => {
      const pool = await setupPool({ epochSeconds: 10 });
      const owner = await pool.fundedWallet(20_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 4_000_000n);
      await buyTickets(pool, owner, 4_000_000n); // caps epoch 1's spend

      // Epoch 1 has ended and is not drawn yet; the pool's current epoch is
      // already 2 the instant this lands.
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const sig = await buyTickets(pool, owner, 4_000_000n);
      const event = await findEvent<{ epochId: BN }>(sig, "ticketsBought");
      expect(event?.epochId.toString()).toBe("2");

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.boughtEpoch.toString()).toBe("2");
      expect(player.boughtAmount.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "bought tickets stake with buy_position, and request_withdraw still deducts min(entries, x)",
    async () => {
      const pool = await setupPool({ epochSeconds: 60, roundSeconds: 30, closeBuffer: 2 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 1_000_000n);
      await buyTickets(pool, owner, 500_000n); // +5_000_000 entries at the default rate

      const beforeStake = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(beforeStake.entries.toString()).toBe("6000000");

      const startsAt = await onChainNowSeconds();
      await createRound(pool, 1n, 1n, startsAt, startsAt + 30);
      // Stakes more than bare Principal (1_000_000) would cover; only clears
      // because the bought Tickets are ordinary Entries.
      await buyPosition(pool, owner, 1n, 0b11n, 2_500_000n);

      const afterStake = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(afterStake.entries.toString()).toBe("1000000"); // 6_000_000 - 5_000_000 staked

      // Unaffected by where the entries came from: still min(entries, x).
      await requestWithdraw(pool, owner, 1_000_000n);
      const afterWithdraw = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(afterWithdraw.entries.toString()).toBe("0");
      expect(afterWithdraw.principal.toString()).toBe("0");
    },
    TIMEOUT,
  );

  // --- Granted tickets (hexo-referrals ticket 04). `grant_tickets` credits
  // ordinary Entries by hand: capped per Player and pool-wide on the
  // operator path, uncapped on the admin path.

  it(
    "an operator grant credits entries up to the player's own cap, one more fails, and it emits TicketsGranted",
    async () => {
      // bonusCapBps: 10_000 (100%) so the pool-wide cap, which a
      // single-depositor pool would otherwise hit first (it is a share of
      // this same Principal), does not shadow the Player cap under test.
      const pool = await setupPool({ bonusCapBps: 10_000 });
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 1_000_000n);

      const sig = await grantTickets(pool, pool.operator, owner.keypair.publicKey, 1_000_000n);

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("1000000"); // unaffected: only entries move
      expect(player.entries.toString()).toBe("2000000"); // deposit + grant
      expect(player.bonusGranted.toString()).toBe("1000000");
      expect(player.bonusEpoch.toString()).toBe("0");

      const event = await findEvent<{
        owner: PublicKey;
        epochId: BN;
        amount: BN;
        byAdmin: boolean;
      }>(sig, "ticketsGranted");
      expect(event?.owner.toString()).toBe(owner.keypair.publicKey.toString());
      expect(event?.epochId.toString()).toBe("0");
      expect(event?.amount.toString()).toBe("1000000");
      expect(event?.byAdmin).toBe(false);

      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/DailyPlayerGrantCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "the pool-wide cap binds even when a large player's own cap has plenty of headroom",
    async () => {
      const pool = await setupPool(); // default bonusCapBps: 500 (5%)
      const owner = await pool.fundedWallet(20_000_000n);
      await deposit(pool, owner, 10_000_000n);

      // Player cap is 10_000_000; the pool cap (5% of total_principal) is
      // 500_000, far tighter, so hitting it here cannot be the player cap.
      await grantTickets(pool, pool.operator, owner.keypair.publicKey, 500_000n);
      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/DailyPoolGrantCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "a small player's own cap binds independently of a generous pool-wide cap",
    async () => {
      const pool = await setupPool({ minDeposit: 1 });
      const small = await pool.fundedWallet(1_000_000n);
      const big = await pool.fundedWallet(20_000_000n);
      await deposit(pool, small, 100_000n);
      await deposit(pool, big, 10_000_000n);

      // Pool cap is 5% of 10_100_000 = 505_000, well above small's own
      // 100_000 cap.
      await grantTickets(pool, pool.operator, small.keypair.publicKey, 100_000n);
      await expect(
        grantTickets(pool, pool.operator, small.keypair.publicKey, 1n),
      ).rejects.toThrow(/DailyPlayerGrantCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "a Player with zero Principal cannot receive an operator grant",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, pool.minDeposit);
      await requestWithdraw(pool, owner, pool.minDeposit); // back to zero Principal

      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/DailyPlayerGrantCapExceeded/);
    },
    TIMEOUT,
  );

  it(
    "the House cannot receive an operator grant",
    async () => {
      const pool = await setupPool();
      await expect(
        grantTickets(pool, pool.operator, pool.operator.publicKey, 1_000_000n),
      ).rejects.toThrow(/HouseCannotBeGranted/);
    },
    TIMEOUT,
  );

  it(
    "grant_tickets refuses while paused, both the operator and the admin path",
    async () => {
      // production-hardening ticket 02: pause stops all Ticket movement.
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 1_000_000n);
      await setPause(pool, true);

      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/PoolPaused/);
      await expect(
        grantTickets(pool, pool.admin, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/PoolPaused/);
    },
    TIMEOUT,
  );

  it(
    "pause leaves settle_round, settle_position and request_withdraw open",
    async () => {
      // production-hardening ticket 02: an open round can still finish, and
      // a withdrawal is never blocked by pause.
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 5_000_000n);

      const startsAt = await onChainNowSeconds();
      const endsAt = startsAt + 6;
      await createRound(pool, 0n, 1n, startsAt, endsAt);
      await buyPosition(pool, owner, 1n, 1n << 0n, 1_000_000n); // tile 0

      await sleepUntilOnChain(endsAt - 1);
      const seed = await requestRoundRandomness(pool, 1n);
      const randomness = await fulfillRandomness(seed, randomnessFor(0)); // tile 0 wins

      await setPause(pool, true);

      await settleRound(pool, 1n, randomness);
      expect((await program.account.round.fetch(roundPda(pool.pool, 1n))).status).toBe(
        round_status.SETTLED,
      );
      await settlePosition(pool, 1n, owner.keypair.publicKey);
      await requestWithdraw(pool, owner, 1_000_000n); // never blocked by pause
      expect(
        (await fetchPlayer(pool, owner.keypair.publicKey)).pendingWithdraw.toString(),
      ).toBe("1000000");
    },
    TIMEOUT,
  );

  it(
    "an unrelated signer is refused",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 1_000_000n);
      const stranger = await pool.fundedWallet(0n);

      await expect(
        grantTickets(pool, stranger.keypair, owner.keypair.publicKey, 1_000n),
      ).rejects.toThrow(/Unauthorized/);
    },
    TIMEOUT,
  );

  it(
    "the admin path is uncapped, leaves the operator counters untouched, and allows the House",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 1_000_000n); // a cap of only 1_000_000 on the operator path

      // Well past both the player and the (still-tiny) pool-wide cap.
      const sig = await grantTickets(pool, pool.admin, owner.keypair.publicKey, 5_000_000n);

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.entries.toString()).toBe("6000000");
      expect(player.bonusGranted.toString()).toBe("0");
      expect(player.bonusEpoch.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).bonusGranted.toString()).toBe("0");

      const event = await findEvent<{ byAdmin: boolean }>(sig, "ticketsGranted");
      expect(event?.byAdmin).toBe(true);

      // The House is refused on the operator path but not here.
      await grantTickets(pool, pool.admin, pool.operator.publicKey, 1_000n);
      expect((await fetchPlayer(pool, pool.operator.publicKey)).entries.toString()).toBe("1000");
    },
    TIMEOUT,
  );

  it(
    "both counters reset at the epoch boundary",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, bonusCapBps: 10_000 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 1_000_000n);

      await grantTickets(pool, pool.operator, owner.keypair.publicKey, 1_000_000n); // caps epoch 1
      expect((await fetchPlayer(pool, owner.keypair.publicKey)).bonusGranted.toString()).toBe(
        "1000000",
      );
      expect((await program.account.pool.fetch(pool.pool)).bonusGranted.toString()).toBe(
        "1000000",
      );

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2 open
      await grantTickets(pool, pool.operator, owner.keypair.publicKey, 1_000_000n); // fresh cap

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.bonusGranted.toString()).toBe("1000000");
      expect(player.bonusEpoch.toString()).toBe("2");
      const poolAfter = await program.account.pool.fetch(pool.pool);
      expect(poolAfter.bonusGranted.toString()).toBe("1000000");
      expect(poolAfter.bonusEpoch.toString()).toBe("2");
    },
    TIMEOUT,
  );

  it(
    "granted tickets are ordinary entries, stakeable with buy_position",
    async () => {
      const pool = await setupPool({
        epochSeconds: 60,
        roundSeconds: 30,
        closeBuffer: 2,
        bonusCapBps: 10_000,
      });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 1_000_000n);
      await grantTickets(pool, pool.operator, owner.keypair.publicKey, 500_000n);

      const beforeStake = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(beforeStake.entries.toString()).toBe("1500000");

      const startsAt = await onChainNowSeconds();
      await createRound(pool, 1n, 1n, startsAt, startsAt + 30);
      // One tile at the full 1_500_000 stake: more than bare Principal
      // (1_000_000) would cover; only clears because the granted Tickets
      // are ordinary Entries.
      await buyPosition(pool, owner, 1n, 0b1n, 1_500_000n);

      const afterStake = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(afterStake.entries.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "granted tickets reset to Principal at the next epoch boundary, like any other entries",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, bonusCapBps: 10_000 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 1_000_000n);
      await grantTickets(pool, pool.operator, owner.keypair.publicKey, 500_000n);
      expect((await fetchPlayer(pool, owner.keypair.publicKey)).entries.toString()).toBe(
        "1500000",
      );

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2 open
      // Any touch (here a further deposit) resets Entries to Principal
      // first, discarding the grant like any other Entries at the
      // boundary, then adds the new deposit on top of that reset base.
      await deposit(pool, owner, 1_000_000n);
      const after = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(after.entries.toString()).toBe(after.principal.toString());
      expect(after.principal.toString()).toBe("2000000");
    },
    TIMEOUT,
  );

  // --- Jackpot pause (game-jackpot-pause ticket 01). `begin_epoch`,
  // `buy_tickets` and `grant_tickets` are refused; `draw` and `payout` are
  // not. `request_draw` is refused too.

  it(
    "jackpot pause refuses begin_epoch, buy_tickets and grant_tickets",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, epoch 2 open

      await setJackpotPaused(pool, true);

      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/JackpotPaused/);
      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/JackpotPaused/);
      await expect(beginEpoch(pool, 2n)).rejects.toThrow(/JackpotPaused/);
      await expect(requestDraw(pool, 1n)).rejects.toThrow(/JackpotPaused/);

      await setJackpotPaused(pool, false);
      await buyTickets(pool, owner, 1_000_000n); // clears once unpaused
      await requestDraw(pool, 1n); // and so does the draw request
    },
    TIMEOUT,
  );

  it(
    "jackpot pause refuses rollover_epoch on an Ended epoch, even for a stranger past the VRF timeout",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, vrfTimeout: 1 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n);
      await deposit(pool, owner, 3_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 1 ended

      await setJackpotPaused(pool, true);
      await sleep(3_000); // past vrf_timeout (1)

      const stranger = await pool.fundedWallet(1_000_000n);
      await expect(
        rolloverEpoch(pool, 1n, new Uint8Array(32), stranger.keypair),
      ).rejects.toThrow(/JackpotPaused/);
      await expect(rolloverEpoch(pool, 1n, new Uint8Array(32))).rejects.toThrow(
        /JackpotPaused/,
      );

      // Unpaused, the same stranger may take it.
      await setJackpotPaused(pool, false);
      await rolloverEpoch(pool, 1n, new Uint8Array(32), stranger.keypair);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.ROLLED_OVER);
    },
    TIMEOUT,
  );

  it(
    "an epoch already Drawing when the jackpot is paused still draws and pays its winner",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      await requestDraw(pool, 1n); // -> Drawing, while still unpaused

      const epochAfterClose = await fetchEpoch(pool, 1n);
      expect(epochAfterClose.status).toBe(epoch_status.DRAWING);

      await setJackpotPaused(pool, true);

      const randomness = await fulfillRandomness(Uint8Array.from(epochAfterClose.vrfSeed));
      await draw(pool, 1n, randomness); // not gated by jackpot_paused

      const drawn = await fetchEpoch(pool, 1n);
      expect(drawn.status).toBe(epoch_status.DRAWN);

      const playerBefore = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey); // not gated either
      const playerAfter = await fetchPlayer(pool, a.keypair.publicKey);
      expect(
        BigInt(playerAfter.principal.toString()) - BigInt(playerBefore.principal.toString()),
      ).toBe(2_000_000n);

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
    },
    TIMEOUT,
  );
});
