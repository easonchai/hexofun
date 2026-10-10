// Ops-and-envs program tickets: shutdown (ReduceOnly), the permissionless
// emergency_withdraw crank, and the admin's sweep_house
// (docs/plan/ops-and-envs/issues/02-04).
//
// Every test runs against a real localnet validator, so give it room.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import {
  epochPda,
  findEvent,
  fulfillRandomness,
  payoutMethod,
  playerPda,
  refundAccounts,
  program,
  requestDrawMethod,
  retryUntilOk,
  setupPool,
  testNonce,
  type Holding,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;

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

async function setPause(pool: PoolCtx, signer: Keypair, paused: boolean) {
  return program.methods
    .setPause(paused)
    .accountsPartial({ signer: signer.publicKey, pool: pool.pool })
    .signers([signer])
    .rpc();
}

async function shutdown(pool: PoolCtx, admin: Keypair = pool.admin) {
  return program.methods
    .shutdown()
    .accountsPartial({ admin: admin.publicKey, pool: pool.pool })
    .signers([admin])
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

/**
 * `nonce` is mixed into the seed (beta-launch-fixes ticket 02); the program
 * now checks the randomness account against it itself (production-hardening
 * ticket 02), so a throwaway address no longer works.
 */
async function requestDraw(
  pool: PoolCtx,
  epochId: bigint,
  draw: bigint | Holding[] = 1n,
  nonce: Uint8Array = testNonce(),
) {
  return requestDrawMethod(pool, epochId, draw, nonce).rpc();
}

/** One holder with a single Ticket: the snapshot `winner` can be paid in. */
const solo = (winner: PublicKey): Holding[] => [{ owner: winner, tickets: 1n }];

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

async function payout(pool: PoolCtx, epochId: bigint, winner: PublicKey) {
  return payoutMethod(pool, epochId, winner, solo(winner)).rpc();
}

async function fetchPlayer(pool: PoolCtx, owner: PublicKey) {
  return program.account.player.fetch(playerPda(pool.pool, owner));
}

async function fetchEpoch(pool: PoolCtx, epochId: bigint) {
  return program.account.epoch.fetch(epochPda(pool.pool, epochId));
}

const vaultBalance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await program.provider.connection.getTokenAccountBalance(account)).value.amount);

async function emergencyWithdraw(
  pool: PoolCtx,
  owner: PublicKey,
  ownerToken: PublicKey,
) {
  return program.methods
    .emergencyWithdraw()
    .accountsPartial({
      pool: pool.pool,
      player: playerPda(pool.pool, owner),
      owner: null,
      acceptedMint: pool.mint,
      ownerToken,
      principalVault: pool.principalVault,
      ...pool.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

async function sweepHouse(pool: PoolCtx, admin: Keypair = pool.admin) {
  return program.methods
    .sweepHouse()
    .accountsPartial({
      admin: admin.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      jackpotVault: pool.jackpotVault,
      treasury: pool.treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
}

describe("shutdown", () => {
  it(
    "flips shutdown and paused, refuses a second call, emits PoolShutdown, and only the admin may call it",
    async () => {
      const pool = await setupPool();

      await expect(shutdown(pool, pool.operator)).rejects.toThrow(/ConstraintHasOne/);

      const sig = await shutdown(pool);
      const account = await program.account.pool.fetch(pool.pool);
      expect(account.shutdown).toBe(true);
      expect(account.paused).toBe(true);
      expect(account.gamePaused).toBe(true);
      expect(account.jackpotPaused).toBe(true);

      const event = await findEvent<{ pool: PublicKey; at: BN }>(sig, "poolShutdown");
      expect(event?.pool.toBase58()).toBe(pool.pool.toBase58());

      await expect(shutdown(pool)).rejects.toThrow(/PoolShutDown/);
    },
    TIMEOUT,
  );

  it(
    "set_pause(false) refuses once shut down, but set_pause(true) is still accepted",
    async () => {
      const pool = await setupPool();
      await shutdown(pool);

      await expect(setPause(pool, pool.admin, false)).rejects.toThrow(/PoolShutDown/);
      await setPause(pool, pool.admin, true); // no-op, still allowed
    },
    TIMEOUT,
  );

  it(
    "request_withdraw and process_withdraw pay out in one transaction once shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n); // the deposit is active, so the request queues
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      await requestWithdraw(pool, owner, 4_000_000n);
      await processWithdraw(pool, owner); // would otherwise fail WithdrawalNotDue
      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
    },
    TIMEOUT,
  );

  it(
    "payout of an epoch already Drawn before shutdown still pays",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await requestDraw(pool, 1n, solo(a.keypair.publicKey));

      const closed = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(closed.vrfSeed));
      await draw(pool, 1n, randomness);

      await shutdown(pool);

      const before = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey);
      const after = await fetchPlayer(pool, a.keypair.publicKey);
      expect(BigInt(after.principal.toString()) - BigInt(before.principal.toString())).toBe(
        2_000_000n,
      );
    },
    TIMEOUT,
  );

  it(
    "draw succeeds after Shutdown: shut down while Drawing, fulfil, draw, pay out",
    async () => {
      // beta-launch-fixes ticket 03: shutdown must never strand a Prize that
      // was already mid-draw. Unlike the "already Drawn before shutdown"
      // test above, here `shutdown` lands while the epoch is still Drawing
      // (randomness requested, not yet fulfilled), so `draw` itself has to
      // run after shutdown for the Prize to ever reach its winner.
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await requestDraw(pool, 1n, solo(a.keypair.publicKey)); // status: Drawing

      const drawing = await fetchEpoch(pool, 1n);
      expect(drawing.status).toBe(2); // Drawing

      await shutdown(pool); // shuts down mid-draw

      const randomness = await fulfillRandomness(Uint8Array.from(drawing.vrfSeed));
      await draw(pool, 1n, randomness); // must succeed despite shutdown
      expect((await fetchEpoch(pool, 1n)).status).toBe(3); // Drawn

      const before = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey);
      const after = await fetchPlayer(pool, a.keypair.publicKey);
      expect(BigInt(after.principal.toString()) - BigInt(before.principal.toString())).toBe(
        2_000_000n,
      );
    },
    TIMEOUT,
  );

  it(
    "every shutdown-refused instruction fails once the pool is shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 5_000_000n);

      // An epoch that legitimately exists before shutdown, so the accounts
      // passed below satisfy Anchor's own seed/bump checks and the program's
      // `require!(!pool.shutdown, ...)` -- the very first check in every one of
      // these handlers -- is what actually fires.
      await beginEpoch(pool, 0n);

      await shutdown(pool);

      await expect(deposit(pool, owner, 1_000_000n)).rejects.toThrow(/PoolShutDown/);
      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/PoolShutDown/);
      await expect(beginEpoch(pool, 1n)).rejects.toThrow(/PoolShutDown/);
      // `draw` deliberately does NOT check shutdown any more
      // (beta-launch-fixes ticket 03): an Epoch still Drawing when shutdown
      // lands must still be drawn so its Prize reaches its winner. See the
      // dedicated "draw succeeds after Shutdown" test above.
      await expect(requestDraw(pool, 1n)).rejects.toThrow(/PoolShutDown/);
    },
    TIMEOUT,
  );
});

describe("emergency_withdraw", () => {
  it(
    "refuses while the pool is not shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);

      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount),
      ).rejects.toThrow(/PoolNotShutDown/);
    },
    TIMEOUT,
  );

  it(
    "pays principal only, principal zeroes out, total_principal drops",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      const sig = await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);

      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).totalPrincipal.toString()).toBe("0");

      const event = await findEvent<{
        claim: BN;
        pending: BN;
        total: BN;
        principal: BN;
        yieldIndex: BN;
      }>(sig, "emergencyWithdrawn");
      expect(event?.claim.toString()).toBe("4000000");
      expect(event?.pending.toString()).toBe("0");
      expect(event?.total.toString()).toBe("4000000");
      // The Player's post-state, as the account reads after the transaction.
      expect(event?.principal.toString()).toBe(player.principal.toString());
      expect(event?.yieldIndex.toString()).toBe(player.yieldIndex.toString());
    },
    TIMEOUT,
  );

  it(
    "pays the whole Principal once when part of it is queued",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n);
      // 4M of Principal, of which 1.5M is queued. The queue is inside the 4M.
      await requestWithdraw(pool, owner, 1_500_000n);
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);

      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("0");
      expect(player.pendingWithdraw.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).pendingWithdrawals.toString()).toBe(
        "0",
      );
    },
    TIMEOUT,
  );

  // "A short vault fails with InsufficientVault and pays nothing" emptied
  // the vault with `admin_withdraw`, which the layout rewrite removed. It
  // returns with ticket 05, which deploys the vault to the test venue before
  // shutdown (and ticket 10 decides what emergency_withdraw pays then).

  it(
    "the House refuses, even though it holds no principal",
    async () => {
      const pool = await setupPool();
      await shutdown(pool);
      const operatorAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );

      await expect(
        emergencyWithdraw(pool, pool.operator.publicKey, operatorAta.address),
      ).rejects.toThrow(/HouseCannotEmergencyWithdraw/);
    },
    TIMEOUT,
  );

  it(
    "a wrong ATA owner refuses, and a second call on a zero balance refuses",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      const stranger = await pool.fundedWallet(0n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);

      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, stranger.tokenAccount),
      ).rejects.toThrow();

      await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);
      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount),
      ).rejects.toThrow(/ZeroAmount/);
    },
    TIMEOUT,
  );
});

describe("sweep_house", () => {
  it(
    "refuses while the pool is not shut down, and refuses the operator",
    async () => {
      const pool = await setupPool();
      await expect(sweepHouse(pool)).rejects.toThrow(/PoolNotShutDown/);

      await shutdown(pool);
      await expect(sweepHouse(pool, pool.operator)).rejects.toThrow(/ConstraintHasOne/);
    },
    TIMEOUT,
  );

  it(
    "sweeps the whole jackpot and never the principal vault",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n);
      await requestWithdraw(pool, owner, 1_000_000n); // 4M principal, 1M of it queued

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      await shutdown(pool);

      const treasuryBefore = await vaultBalance(pool.treasury);
      const sig = await sweepHouse(pool);

      expect(await vaultBalance(pool.jackpotVault)).toBe(0n);
      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore + 2_000_000n);
      expect(await vaultBalance(pool.principalVault)).toBe(4_000_000n); // the 1M queued is still in it

      const event = await findEvent<{ jackpot: BN }>(sig, "houseSwept");
      expect(event?.jackpot.toString()).toBe("2000000");

      // Callable again: a later fund_jackpot can be swept a second time.
      await fundJackpot(pool, funder, 100_000n);
      await sweepHouse(pool);
      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore + 2_100_000n);
    },
    TIMEOUT,
  );

  it(
    "never touches jackpot_reserved, so an already-drawn epoch can still pay after a sweep",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await beginEpoch(pool, 0n);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n); // becomes the reserved prize

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await requestDraw(pool, 1n, solo(a.keypair.publicKey)); // snapshots jackpot_amount = 2M, reserves it

      const closed = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(closed.vrfSeed));
      await draw(pool, 1n, randomness); // Drawn, not yet paid: 2M stays reserved

      await shutdown(pool);
      // A surplus on top of the reserved prize: real House money this pool
      // never promised to epoch 1's winner.
      await fundJackpot(pool, funder, 500_000n);

      const treasuryBefore = await vaultBalance(pool.treasury);
      const sig = await sweepHouse(pool);

      // Only the surplus moved; the reserved prize is still sitting in the
      // jackpot vault for `payout` to pay out below.
      expect(await vaultBalance(pool.jackpotVault)).toBe(2_000_000n);
      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore + 500_000n);
      const event = await findEvent<{ jackpot: BN }>(sig, "houseSwept");
      expect(event?.jackpot.toString()).toBe("500000");

      const before = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey); // must not fail InsufficientVault
      const after = await fetchPlayer(pool, a.keypair.publicKey);
      expect(BigInt(after.principal.toString()) - BigInt(before.principal.toString())).toBe(
        2_000_000n,
      );
      expect(await vaultBalance(pool.jackpotVault)).toBe(0n);
    },
    TIMEOUT,
  );
});
