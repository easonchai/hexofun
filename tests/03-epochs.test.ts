// Epoch lifecycle: contiguous epochs, request_draw, draw, payout to a player
// and to the House, rollover, and the buy_tickets USDC sink (spec §2.3
// "Epochs").
//
// The program holds no Tickets (ADR 0025): the Operator hands request_draw the
// root, total and shape of a Merkle sum tree over the epoch's Tickets, and
// payout verifies the winner's proof against them. So a test that draws keeps
// its own list of who holds what, lands the target with `randomnessLanding`,
// and builds the proof from the same list. The commitment and proof checks
// themselves are in 20-snapshot-draw.
//
// Epochs here run a handful of seconds (via the `epochSeconds` override) so
// tests sleep through them instead of a day. Each test airdrops, mints, and
// confirms several transactions against a real localnet validator.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  airdrop,
  deployToVenue,
  epochPda,
  findEvent,
  fulfillRandomness,
  onChainNowSeconds,
  payoutMethod,
  playerPda,
  refundAccounts,
  program,
  randomnessLanding,
  randomnessPda,
  requestDrawMethod,
  retryUntilOk,
  setupPool,
  setVenueRate,
  sleep,
  sleepUntilOnChain,
  snapshotOf,
  testNonce,
  vrfSeed,
  waitPastLastSync,
  type Holding,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;

const epoch_status = {
  OPEN: 0,
  ENDED: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
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
      ...refundAccounts(pool, owner),
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
      owner: null,
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...pool.venue,
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
      ...pool.venue,
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
      vrfTimeout: null,
      minDeposit: null,
      minJackpot: null,
      payoutTimeout: null,
      baseRateBps: null,
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

/** One holder with `tickets`, the snapshot of a draw `winner` can be paid in. */
const solo = (winner: PublicKey, tickets = 1n): Holding[] => [{ owner: winner, tickets }];

/**
 * `draw` is the epoch's holders, or a bare Ticket total nobody can be paid
 * against. `nonce` is mixed into the seed with the snapshot's root and total
 * (beta-launch-fixes ticket 02); the program checks the randomness account
 * against it itself (production-hardening ticket 02).
 */
async function requestDraw(
  pool: PoolCtx,
  epochId: bigint,
  draw: bigint | Holding[] = 1n,
  nonce: Uint8Array = testNonce(),
) {
  return requestDrawMethod(pool, epochId, draw, nonce).rpc();
}

/** Requests the draw over `held` and draws it with randomness that lands the
 *  target in `winner`'s range. Returns the Epoch. */
async function requestAndDrawFor(
  pool: PoolCtx,
  epochId: bigint,
  held: Holding[],
  winner: PublicKey,
) {
  const { randomness } = randomnessLanding(held, winner);
  await requestDraw(pool, epochId, held);
  const drawing = await fetchEpoch(pool, epochId);
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

/** Pays `winner` with the proof for the snapshot `held` that was committed.
 *  A non-House winner needs no token account of their own: the prize
 *  compounds into `principal_vault`. */
async function payout(pool: PoolCtx, epochId: bigint, winner: PublicKey, held: Holding[]) {
  return payoutMethod(pool, epochId, winner, held).rpc();
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

async function fetchPlayer(pool: PoolCtx, owner: PublicKey) {
  return program.account.player.fetch(playerPda(pool.pool, owner));
}

async function fetchEpoch(pool: PoolCtx, epochId: bigint) {
  return program.account.epoch.fetch(epochPda(pool.pool, epochId));
}

describe("epochs", () => {
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
    "request_draw with zero Tickets in total rolls over and leaves the jackpot in the vault",
    async () => {
      const pool = await setupPool({ epochSeconds: 4 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 5_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, nobody holds Tickets

      await requestDraw(pool, 1n, 0n);

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
      // Tickets were not the reason: the Operator reported some.
      expect(epoch1.totalTickets.toString()).toBe("1");

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
    "draw and payout to a player: the prize compounds into Principal, total_principal and the principal vault, and can be withdrawn",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      await retryUntilOk(() => beginEpoch(pool, 1n));

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      // `a` holds all of the epoch's 4M Tickets.
      const held = solo(a.keypair.publicKey, 4_000_000n);
      await requestDraw(pool, 1n, held);

      const epochAfterClose = await fetchEpoch(pool, 1n);
      expect(epochAfterClose.status).toBe(epoch_status.DRAWING);
      expect(epochAfterClose.totalTickets.toString()).toBe("4000000");

      const randomness = await fulfillRandomness(Uint8Array.from(epochAfterClose.vrfSeed));
      await draw(pool, 1n, randomness);

      const drawn = await fetchEpoch(pool, 1n);
      expect(drawn.status).toBe(epoch_status.DRAWN);

      const principalVaultBefore = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      const playerBefore = await fetchPlayer(pool, a.keypair.publicKey);
      const poolBefore = await program.account.pool.fetch(pool.pool);

      const sig = await payout(pool, 1n, a.keypair.publicKey, held);

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
        BigInt(poolAfter.totalPrincipal.toString()) - BigInt(poolBefore.totalPrincipal.toString()),
      ).toBe(2_000_000n);

      const event = await findEvent<{
        isHouse: boolean;
        compounded: boolean;
        amount: BN;
        principal: BN;
        yieldIndex: BN;
        index: number;
        tickets: BN;
      }>(sig, "jackpotPaid");
      expect(event?.isHouse).toBe(false);
      expect(event?.compounded).toBe(true);
      expect(event?.amount.toString()).toBe("2000000");
      // The winner's leaf, so the indexer can book the prize's Tickets.
      expect(event?.index).toBe(0);
      expect(event?.tickets.toString()).toBe("4000000");
      // The winner's post-state, as the Player account reads after the payout.
      expect(event?.principal.toString()).toBe(playerAfter.principal.toString());
      expect(event?.yieldIndex.toString()).toBe(playerAfter.yieldIndex.toString());

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
    "payout to a player: the yield settled just before the prize joins Principal, and the event carries both",
    async () => {
      // 1M USDC at 100% APR so the depositor ceiling does not bind on the gain.
      const big = 10n ** 12n;
      const pool = await setupPool({ epochSeconds: 6, baseRateBps: 10_000 });
      const a = await pool.fundedWallet(big * 2n);
      await deposit(pool, a, big);
      await waitPastLastSync(pool);
      await deployToVenue(pool, (big * 9n) / 10n);

      await beginEpoch(pool, 0n);
      await retryUntilOk(() => beginEpoch(pool, 1n));
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      const held = solo(a.keypair.publicKey, big);
      await requestDraw(pool, 1n, held);
      const drawing = await fetchEpoch(pool, 1n);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(drawing.vrfSeed)));

      // The venue gains 18,000 (9e11 shares x 2e10 / 1e18), 16,200 of it for
      // depositors, and `a` is the only one. Payout's own sync books it and the
      // winner's settle takes it before the prize lands.
      const reserve = await program.account.testReserve.fetch(pool.venue.klendReserve);
      await setVenueRate(pool, BigInt(reserve.rate.toString()) + 2n * 10n ** 10n).rpc();
      await waitPastLastSync(pool);
      const before = await fetchPlayer(pool, a.keypair.publicKey);
      const sig = await payout(pool, 1n, a.keypair.publicKey, held);
      const after = await fetchPlayer(pool, a.keypair.publicKey);

      const yieldSettled = 16_200n;
      expect(BigInt(after.principal.toString()) - BigInt(before.principal.toString())).toBe(
        2_000_000n + yieldSettled,
      );
      // The settle moved the Player's index to the pool's, and the event says so.
      const event = await findEvent<{ principal: BN; yieldIndex: BN }>(sig, "jackpotPaid");
      expect(event?.principal.toString()).toBe(after.principal.toString());
      expect(event?.yieldIndex.toString()).toBe(after.yieldIndex.toString());
      expect(after.yieldIndex.toString()).not.toBe(before.yieldIndex.toString());
    },
    TIMEOUT,
  );

  it(
    "the House wins: buyback gets 50%, treasury 20%, the vault keeps 30%",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      await beginEpoch(pool, 0n);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      // The House holds Tickets the backend booked from forfeited pots and the
      // cut, so it can win: land the target in its range.
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);
      const house = pool.operator.publicKey;
      const held = solo(house, 6_000_000n);
      const closed = await requestAndDrawFor(pool, 1n, held, house);
      expect(closed.status).toBe(epoch_status.DRAWN);

      const buybackBefore = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryBefore = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultBefore = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      const sig = await payout(pool, 1n, pool.operator.publicKey, held);

      const buybackAfter = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryAfter = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultAfter = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      expect(BigInt(buybackAfter.value.amount) - BigInt(buybackBefore.value.amount)).toBe(500_000n); // 50%
      expect(BigInt(treasuryAfter.value.amount) - BigInt(treasuryBefore.value.amount)).toBe(200_000n); // 20%
      expect(BigInt(vaultBefore.value.amount) - BigInt(vaultAfter.value.amount)).toBe(700_000n); // 70% left
      expect(vaultAfter.value.amount).toBe("300000"); // 30% stays

      const event = await findEvent<{
        isHouse: boolean;
        compounded: boolean;
        principal: BN;
        yieldIndex: BN;
      }>(sig, "jackpotPaid");
      expect(event?.isHouse).toBe(true);
      expect(event?.compounded).toBe(false);
      // The House holds no Principal and never earns, so both stay 0.
      expect(event?.principal.toString()).toBe("0");
      expect(event?.yieldIndex.toString()).toBe("0");

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(pool.operator.publicKey.toString());
    },
    TIMEOUT,
  );

  it(
    "a House rotated to a new Operator still wins: its address keeps the first Operator's seed",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const next = Keypair.generate();
      await airdrop(next.publicKey, 2);
      await program.methods
        .setOperator(next.publicKey)
        .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool, house: pool.house })
        .signers([pool.admin])
        .rpc();
      // From here the new key is the operator that cranks.
      const rotated = { ...pool, operator: next };
      await beginEpoch(rotated, 0n);
      await retryUntilOk(() => beginEpoch(rotated, 1n));

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);
      const held = solo(next.publicKey, 6_000_000n);
      const closed = await requestAndDrawFor(rotated, 1n, held, next.publicKey);
      expect(closed.status).toBe(epoch_status.DRAWN);

      const buybackBefore = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      // The winner is the House at its original address, whose owner is `next`.
      await payoutMethod(rotated, 1n, next.publicKey, held)
        .accountsPartial({ winner: pool.house })
        .rpc();
      const buybackAfter = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      expect(BigInt(buybackAfter.value.amount) - BigInt(buybackBefore.value.amount)).toBe(500_000n);
      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(next.publicKey.toString());
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
      // of epoch 1 and cannot come out with zero Tickets.
      const a = await pool.fundedWallet(10_000_000n);
      const b = await pool.fundedWallet(10_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      await deposit(pool, b, 3_000_000n);

      await beginEpoch(pool, 0n); // epoch 1
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      const [ha, hb] = [a.keypair.publicKey, b.keypair.publicKey];
      const held1 = [
        { owner: ha, tickets: 3_000_000n },
        { owner: hb, tickets: 3_000_000n },
      ];
      const closed1 = await requestAndDrawFor(pool, 1n, held1, ha);
      expect(closed1.jackpotAmount.toString()).toBe("3000000");
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe(
        "3000000",
      );

      // beta-launch-fixes ticket 03: begin_epoch refuses while the epoch two
      // behind the new one is still Drawing or Drawn, so epoch 1's winner
      // (`a`) must be paid before epoch 3 can ever open. Prize compounds into
      // the principal vault, not a.'s own token account.
      const principalBeforeFirst = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      await payout(pool, 1n, a.keypair.publicKey, held1);
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
      // Epoch 2: a holds 3M plus the 3M prize, b holds 3M.
      const held2 = [
        { owner: ha, tickets: 6_000_000n },
        { owner: hb, tickets: 3_000_000n },
      ];
      const closed2 = await requestAndDrawFor(pool, 2n, held2, hb);
      expect(closed2.jackpotAmount.toString()).toBe("2000000");

      await payout(pool, 2n, b.keypair.publicKey, held2);
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
      await requestDraw(pool, 1n, solo(a.keypair.publicKey)); // epoch 1: Drawing

      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWING);

      // epoch 2 -> Ended, epoch 3 would open; epoch 1 (two behind epoch
      // 3) is still Drawing.
      await sleepUntilOnChain(Number((await program.account.pool.fetch(pool.pool)).currentEpochEndsAt.toString()));
      await expect(beginEpoch(pool, 2n)).rejects.toThrow(/PreviousEpochStillDrawing/);

      // Drawing the epoch and paying its winner clears the way.
      const drawing = await fetchEpoch(pool, 1n);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(drawing.vrfSeed)));
      await expect(beginEpoch(pool, 2n)).rejects.toThrow(/PreviousEpochStillDrawing/); // still Drawn, unpaid

      await payout(pool, 1n, a.keypair.publicKey, solo(a.keypair.publicKey));
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
      // randomness account against its own computed seed.
      const wrongNonce = testNonce(9);
      const draw1 = snapshotOf([{ owner: Keypair.generate().publicKey, tickets: 1n }]);
      const wrongSeed = vrfSeed(pool.pool, 2n, wrongNonce, draw1.root, draw1.total); // another epoch's seed
      await expect(
        requestDrawMethod(pool, 1n, 1n, testNonce(), randomnessPda(wrongSeed)).rpc(),
      ).rejects.toThrow(/InvalidRandomnessAccount/);

      await requestDraw(pool, 1n);

      // Permissionless (production-hardening ticket 01): a stranger, not the
      // operator, drives draw and rollover_epoch.
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

  it(
    "EpochBegan carries the yield index after begin_epoch's own sync",
    async () => {
      // 1M USDC at 100% APR so the depositor ceiling does not bind on the gain.
      const big = 10n ** 12n;
      const pool = await setupPool({ epochSeconds: 6, baseRateBps: 10_000 });
      const a = await pool.fundedWallet(big * 2n);
      await deposit(pool, a, big);
      await beginEpoch(pool, 0n);
      await waitPastLastSync(pool);
      await deployToVenue(pool, (big * 9n) / 10n);

      // The venue gains with nobody syncing: only begin_epoch can book it.
      const reserve = await program.account.testReserve.fetch(pool.venue.klendReserve);
      await setVenueRate(pool, BigInt(reserve.rate.toString()) + 2n * 10n ** 10n).rpc();
      await waitPastLastSync(pool);
      expect((await program.account.pool.fetch(pool.pool)).yieldIndex.toString()).toBe("0");

      const sig = await retryUntilOk(() => beginEpoch(pool, 1n));

      const index = (await program.account.pool.fetch(pool.pool)).yieldIndex;
      expect(index.toString()).not.toBe("0");
      const event = await findEvent<{ epochId: BN; yieldIndex: BN }>(sig, "epochBegan");
      expect(event?.epochId.toString()).toBe("2");
      expect(event?.yieldIndex.toString()).toBe(index.toString());
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
      // pays out while epoch 2 is current.
      const held = solo(a.keypair.publicKey, 4_000_000n);
      await requestAndDrawFor(pool, 1n, held, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey, held);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.PAID);
    },
    TIMEOUT,
  );

  it(
    "the first epoch is a stub ending on the grid",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 30, epochAnchor: anchor });
      await beginEpoch(pool, 0n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const startsAt = BigInt(epoch1.startsAt.toString());
      const endsAt = BigInt(epoch1.endsAt.toString());
      expect(endsAt).toBe(BigInt(anchor)); // the first grid point after bootstrap
      expect(Number(endsAt - startsAt)).toBeGreaterThan(0);
      expect(Number(endsAt - startsAt)).toBeLessThan(30);
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

      await beginEpoch(pool, 0n); // epoch 1: the stub
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: a full 8s period
      const epoch2 = await fetchEpoch(pool, 2n);
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(8);

      await setParams(pool, 24); // the daily-to-weekly switch, scaled down

      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3: the transition
      const epoch3 = await fetchEpoch(pool, 3n);
      expect(epoch3.startsAt.toString()).toBe(epoch2.endsAt.toString());
      expect((Number(epoch3.endsAt) - anchor) % 24).toBe(0);
      expect(Number(epoch3.endsAt) - Number(epoch3.startsAt)).toBeLessThan(24);

      await retryUntilOk(() => beginEpoch(pool, 3n)); // epoch 4: the new cadence
      const epoch4 = await fetchEpoch(pool, 4n);
      expect(Number(epoch4.endsAt) - Number(epoch4.startsAt)).toBe(24);
    },
    TIMEOUT,
  );

  // --- Cross-epoch Round settlement. A Round that ended inside its epoch
  // can settle after the roll: `touch` runs first, the reset has already
  // restored every stake, and the credit is a plain delta in the epoch now
  // current (yield-claimer ticket 21; the winner's case is in 02-rounds).

  // --- Base yield (hexo-referrals ticket 01, ADR 0011) went with `register`
  // and `fund_yield` (ADR 0017). Ticket 06's Yield index tests replace it.

  // --- Bought tickets (hexo-referrals ticket 03). `buy_tickets` spends real
  // USDC into the jackpot vault, capped per Player per epoch at locked
  // Principal. It credits nothing: the backend books the Tickets from the
  // `TicketsBought` event (ADR 0025).

  it(
    "refuses before the first epoch exists",
    async () => {
      // beta-launch-fixes ticket 03: buy_tickets requires current_epoch_id >
      // 0, so Tickets bought before Epoch 1 begins (and are lost the moment
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
    "moves real USDC to the jackpot vault, credits nothing, and emits TicketsBought with the Player's post-state",
    async () => {
      const pool = await setupPool();
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
      expect(player.principal.toString()).toBe("4000000"); // unaffected
      expect(player.boughtAmount.toString()).toBe("1000000");
      expect(player.boughtEpoch.toString()).toBe("1");

      const event = await findEvent<{
        owner: PublicKey;
        epochId: BN;
        usdc: BN;
        principal: BN;
        yieldIndex: BN;
      }>(sig, "ticketsBought");
      expect(event?.owner.toString()).toBe(owner.keypair.publicKey.toString());
      expect(event?.epochId.toString()).toBe("1");
      expect(event?.usdc.toString()).toBe("1000000");
      expect(event?.principal.toString()).toBe(player.principal.toString());
      expect(event?.yieldIndex.toString()).toBe(player.yieldIndex.toString());
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
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: the deposit is locked

      await buyTickets(pool, owner, 2_000_000n);
      await buyTickets(pool, owner, 1_000_000n); // lands exactly on the cap
      expect(
        (await fetchPlayer(pool, owner.keypair.publicKey)).boughtAmount.toString(),
      ).toBe("3000000");

      // Past the cap it fails by name and moves no USDC.
      const balances = async () =>
        [pool.jackpotVault, owner.tokenAccount].map(async (account) =>
          (await program.provider.connection.getTokenAccountBalance(account)).value.amount,
        );
      const before = await Promise.all(await balances());
      await expect(buyTickets(pool, owner, 1n)).rejects.toThrow(/DailyBuyCapExceeded/);
      expect(await Promise.all(await balances())).toEqual(before);

      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3 open
      await buyTickets(pool, owner, 3_000_000n); // fresh cap, same Principal

      const afterReset = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(afterReset.boughtAmount.toString()).toBe("3000000");
      expect(afterReset.boughtEpoch.toString()).toBe("3");
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
    "refuses while the Bought Tickets switch is set, which only the Admin moves, and resumes when cleared",
    async () => {
      // yield-claimer ticket 11, ADR 0019.
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n);
      const setSwitch = (signer: Keypair, paused: boolean) =>
        program.methods
          .setBuyTicketsPause(paused)
          .accountsPartial({ admin: signer.publicKey, pool: pool.pool })
          .signers([signer])
          .rpc();

      // The operator may pause the pool but not this switch.
      await expect(setSwitch(pool.operator, true)).rejects.toThrow(/ConstraintHasOne|Unauthorized/);
      expect((await program.account.pool.fetch(pool.pool)).buyTicketsPaused).toBe(false);

      const sig = await setSwitch(pool.admin, true);
      expect((await program.account.pool.fetch(pool.pool)).buyTicketsPaused).toBe(true);
      expect((await findEvent<{ paused: boolean }>(sig, "buyTicketsPauseSet"))?.paused).toBe(true);
      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/BuyTicketsPaused/);
      // The pool pause still stops it on its own, switch or not.
      await setSwitch(pool.admin, false);
      await setPause(pool, true);
      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/PoolPaused/);
      await setPause(pool, false);

      await buyTickets(pool, owner, 1_000_000n);
      expect((await fetchPlayer(pool, owner.keypair.publicKey)).boughtAmount.toString()).toBe(
        "1000000",
      );
    },
    TIMEOUT,
  );

  it(
    "refunding a pending deposit before buying takes its room away, never bypasses the cap",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open: buy_tickets requires one
      await deposit(pool, owner, 5_000_000n);

      // The 3M refunds at once, leaving 2M of Principal that is all still
      // pending, so no locked Principal is left to buy against.
      await requestWithdraw(pool, owner, 3_000_000n);
      expect(
        (await fetchPlayer(pool, owner.keypair.publicKey)).principal.toString(),
      ).toBe("2000000");

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
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: the deposit is locked
      await buyTickets(pool, owner, 4_000_000n); // caps epoch 2's spend

      // Epoch 2 has ended and is not drawn yet; the pool's current epoch is
      // already 3 the instant this lands.
      await retryUntilOk(() => beginEpoch(pool, 2n));

      const sig = await buyTickets(pool, owner, 4_000_000n);
      const event = await findEvent<{ epochId: BN }>(sig, "ticketsBought");
      expect(event?.epochId.toString()).toBe("3");

      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.boughtEpoch.toString()).toBe("3");
      expect(player.boughtAmount.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  // --- Granted tickets (hexo-referrals ticket 04). `grant_tickets` credits
  // ordinary Entries by hand: capped per Player and pool-wide on the
  // operator path, uncapped on the admin path.

  // --- Jackpot pause (game-jackpot-pause ticket 01). `begin_epoch` and
  // `buy_tickets` are refused; `draw` and `payout` are not. `request_draw` is
  // refused too.

  it(
    "jackpot pause refuses begin_epoch, buy_tickets and request_draw",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, owner, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 ended, epoch 2 open

      await setJackpotPaused(pool, true);

      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/JackpotPaused/);
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
      await requestDraw(pool, 1n, solo(a.keypair.publicKey)); // -> Drawing, while still unpaused

      const epochAfterClose = await fetchEpoch(pool, 1n);
      expect(epochAfterClose.status).toBe(epoch_status.DRAWING);

      await setJackpotPaused(pool, true);

      const randomness = await fulfillRandomness(Uint8Array.from(epochAfterClose.vrfSeed));
      await draw(pool, 1n, randomness); // not gated by jackpot_paused

      const drawn = await fetchEpoch(pool, 1n);
      expect(drawn.status).toBe(epoch_status.DRAWN);

      const playerBefore = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey, solo(a.keypair.publicKey)); // not gated either
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
