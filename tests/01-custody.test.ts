// Custody invariants: deposit and withdrawal bounds, the epoch lock on a
// payout, pause semantics, and the per-pool vault seeds (spec §2.3
// "Custody", §2.4 invariants 1-4). `admin_withdraw` and its tests went with
// the live-yield layout rewrite (yield-claimer ticket 04, ADR 0017).
//
// Each test airdrops, mints, and confirms several transactions against a
// real localnet validator, so the default 5s vitest timeout is too tight.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAccount,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  assertSolvent,
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  findEvent,
  fulfillRandomness,
  jackpotVaultPda,
  nextPoolId,
  onChainNowSeconds,
  playerPda,
  refundAccounts,
  poolPda,
  principalVaultPda,
  program,
  randomnessFor,
  randomnessPda,
  retryUntilOk,
  roundPda,
  setupPool,
  sleepUntilOnChain,
  testNonce,
  venueAccountsFor,
  vrfSeed,
  WEIGHT_TREE_SPACE,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 30_000;

/** Every account `deposit` needs, for one pool and one wallet. */
function depositAccounts(pool: PoolCtx, owner: Awaited<ReturnType<PoolCtx["fundedWallet"]>>) {
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

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

/** Awaits one instruction, then checks the solvency invariant (ticket 06):
 *  every instruction this suite runs through a helper must leave it holding. */
async function thenSolvent(pool: PoolCtx, tx: Promise<string>): Promise<string> {
  const signature = await tx;
  await assertSolvent(pool);
  return signature;
}

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return thenSolvent(
    pool,
    program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial(depositAccounts(pool, owner))
    .signers([owner.keypair])
    .rpc(),
  );
}

/** Books the withdrawal. No token accounts: nothing moves here. */
async function requestWithdraw(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return thenSolvent(
    pool,
    program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      ...pool.venue,
      ...refundAccounts(pool, owner),
    })
    .signers([owner.keypair])
    .rpc(),
  );
}

/** Pays a matured request. Signed by nobody; the test wallet just pays fees. */
async function processWithdraw(pool: PoolCtx, owner: Wallet) {
  return thenSolvent(
    pool,
    program.methods
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
    .rpc(),
  );
}

/** `currentEpochId` is `pool.currentEpochId` *before* this call. */
async function beginEpoch(pool: PoolCtx, currentEpochId: bigint) {
  const twoBehindId = currentEpochId > 0n ? currentEpochId - 1n : 0n;
  return thenSolvent(
    pool,
    program.methods
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
    .rpc(),
  );
}

const vaultBalance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await program.provider.connection.getTokenAccountBalance(account)).value.amount);

async function setPause(pool: PoolCtx, paused: boolean) {
  return thenSolvent(
    pool,
    program.methods
    .setPause(paused)
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc(),
  );
}

type Feature = "Game" | "Jackpot";

async function setFeaturePause(pool: PoolCtx, signer: Keypair, feature: Feature, paused: boolean) {
  return thenSolvent(
    pool,
    program.methods
    .setFeaturePause(feature === "Game" ? { game: {} } : { jackpot: {} }, paused)
    .accountsPartial({ signer: signer.publicKey, pool: pool.pool })
    .signers([signer])
    .rpc(),
  );
}

async function shutdown(pool: PoolCtx) {
  return thenSolvent(
    pool,
    program.methods
    .shutdown()
    .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc(),
  );
}

describe("custody", () => {
  it(
    "deposit raises principal and the pending deposit, and no Tickets",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);

      await deposit(pool, owner, 4_000_000n);
      await deposit(pool, owner, 1_000_000n);

      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      // Principal includes the pending amount, which earns Tickets from the
      // next epoch (ADR 0020). Epoch 0 has not ended, so it is still pending.
      expect(player.principal.toString()).toBe("5000000");
      expect(player.entries.toString()).toBe("0");
      expect(player.pendingDeposit.toString()).toBe("5000000");
      expect(player.pendingDepositEpoch.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "request_withdraw enforces the principal bound, and a request on active Principal moves nothing",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 3_000_000n);
      // The first begin_epoch has no end to wait for. The deposit is active
      // Principal after it, so a request queues instead of refunding.
      await beginEpoch(pool, 0n);
      const walletBefore = await vaultBalance(owner.tokenAccount);

      await expect(requestWithdraw(pool, owner, 3_000_001n)).rejects.toThrow(
        /InsufficientPrincipal/,
      );
      await expect(requestWithdraw(pool, owner, 0n)).rejects.toThrow(/ZeroAmount/);

      const signature = await requestWithdraw(pool, owner, 3_000_000n);
      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      // The queued amount stays in Principal and in Tickets until it pays.
      expect(player.principal.toString()).toBe("3000000");
      expect(player.entries.toString()).toBe("3000000");
      expect(player.pendingWithdraw.toString()).toBe("3000000");

      const event = await findEvent<{ amount: BN; pending: BN; pendingEpoch: BN; refunded: BN }>(
        signature,
        "withdrawRequested",
      );
      expect(event?.amount.toString()).toBe("3000000");
      expect(event?.pending.toString()).toBe("3000000");
      expect(event?.pendingEpoch.toString()).toBe("1");
      expect(event?.refunded.toString()).toBe("0");

      // The USDC has not moved: it is still in the vault and not in the
      // wallet, which is the whole point of queueing.
      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore);
      expect(await vaultBalance(pool.principalVault)).toBe(3_000_000n);
      expect((await program.account.pool.fetch(pool.pool)).pendingWithdrawals.toString()).toBe(
        "3000000",
      );
    },
    TIMEOUT,
  );

  it(
    "request_withdraw works while the pool is paused, for the refund and for the queue",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 2_000_000n);
      await beginEpoch(pool, 0n);
      await deposit(pool, owner, 1_000_000n); // pending

      await setPause(pool, true);
      // 1.5M asked: the 1M pending deposit refunds and 0.5M queues.
      await requestWithdraw(pool, owner, 1_500_000n);

      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("2000000");
      expect(player.pendingDeposit.toString()).toBe("0");
      expect(player.pendingWithdraw.toString()).toBe("500000");
    },
    TIMEOUT,
  );

  it(
    "deposit fails while paused and fails below the pool minimum",
    async () => {
      const pool = await setupPool({ minDeposit: 1_000_000 });
      const owner = await pool.fundedWallet(10_000_000n);

      await expect(deposit(pool, owner, 500_000n)).rejects.toThrow();

      await setPause(pool, true);
      await expect(deposit(pool, owner, 2_000_000n)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "deposit to the House fails with HouseCannotDeposit, but a normal deposit still succeeds",
    async () => {
      const pool = await setupPool();

      const operatorAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );
      await mintTo(program.provider.connection, pool.operator, pool.mint, operatorAta.address, pool.operator, 5_000_000n);

      await expect(
        program.methods
          .deposit(new BN("2000000"))
          .accountsPartial({
            owner: pool.operator.publicKey,
            pool: pool.pool,
            player: pool.house,
            acceptedMint: pool.mint,
            ownerToken: operatorAta.address,
            principalVault: pool.principalVault,
            ...pool.venue,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.operator])
          .rpc(),
      ).rejects.toThrow();

      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "rejects a foreign pool's vault by seeds",
    async () => {
      const poolA = await setupPool();
      const poolB = await setupPool({ mint: poolA.mint });
      const owner = await poolA.fundedWallet(10_000_000n);

      const accounts = depositAccounts(poolA, owner);
      accounts.principalVault = poolB.principalVault;

      await expect(
        program.methods.deposit(new BN("2000000")).accountsPartial(accounts).signers([owner.keypair]).rpc(),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  // --- The epoch lock (ADR 0009). Epochs here run a few seconds so the
  // boundary arrives inside a test rather than a day later.

  it(
    "a request is paid in full one epoch later, and not before",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n); // epoch 1
      await deposit(pool, owner, 4_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: the deposit is active

      await requestWithdraw(pool, owner, 1_500_000n);
      expect(
        (await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey)))
          .pendingEpoch.toString(),
      ).toBe("2");

      // Same epoch: the money is still lent out as far as the program knows.
      await expect(processWithdraw(pool, owner)).rejects.toThrow(/WithdrawalNotDue/);

      const before = await vaultBalance(owner.tokenAccount);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3
      const signature = await processWithdraw(pool, owner);

      expect((await vaultBalance(owner.tokenAccount)) - before).toBe(1_500_000n);
      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.pendingWithdraw.toString()).toBe("0");
      expect(player.principal.toString()).toBe("2500000");
      const poolAccount = await program.account.pool.fetch(pool.pool);
      expect(poolAccount.pendingWithdrawals.toString()).toBe("0");
      expect(poolAccount.totalPrincipal.toString()).toBe("2500000");

      const event = await findEvent<{ amount: BN }>(signature, "withdrawn");
      expect(event?.amount.toString()).toBe("1500000");

      // Nothing left to push.
      await expect(processWithdraw(pool, owner)).rejects.toThrow(/NothingPending/);
    },
    TIMEOUT,
  );

  it(
    "two requests in one epoch accumulate into one payout",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n);
      await deposit(pool, owner, 4_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: the deposit is active

      await requestWithdraw(pool, owner, 1_000_000n);
      const second = await requestWithdraw(pool, owner, 500_000n);
      expect(
        (await findEvent<{ amount: BN; pending: BN }>(second, "withdrawRequested"))?.pending.toString(),
      ).toBe("1500000");

      const before = await vaultBalance(owner.tokenAccount);
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await processWithdraw(pool, owner);

      expect((await vaultBalance(owner.tokenAccount)) - before).toBe(1_500_000n);
      expect(
        (await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey)))
          .pendingWithdraw.toString(),
      ).toBe("0");
    },
    TIMEOUT,
  );

  // The short-vault payout case ("fails, changes nothing, pays once the
  // USDC is back") needed USDC to leave the vault, which `admin_withdraw`
  // did. It now deploys to the test venue and recalls: see "makes a Pending
  // withdrawal the vault could not cover payable" in 07-recall-harvest.test.ts.

  it(
    "a stalled operator cannot freeze a request: it matures on its own clock",
    async () => {
      // `begin_epoch` is called once, so the deposit is active, and never again,
      // so `current_epoch_id` stays 1 and the epoch-boundary rule can never
      // fire. Only the elapsed time can.
      const pool = await setupPool({ epochSeconds: 5 });
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await beginEpoch(pool, 0n);
      await requestWithdraw(pool, owner, 2_000_000n);

      const player = await program.account.player.fetch(
        playerPda(pool.pool, owner.keypair.publicKey),
      );
      expect(player.pendingEpoch.toString()).toBe("1");
      await expect(processWithdraw(pool, owner)).rejects.toThrow(/WithdrawalNotDue/);

      const before = await vaultBalance(owner.tokenAccount);
      await sleepUntilOnChain(Number(player.requestedAt.toString()) + 5 + 1);
      await processWithdraw(pool, owner);

      expect((await vaultBalance(owner.tokenAccount)) - before).toBe(2_000_000n);
      expect((await program.account.pool.fetch(pool.pool)).currentEpochId.toString()).toBe("1");
    },
    TIMEOUT,
  );

  // `admin_withdraw`'s own tests (pending-withdrawal guard, ATA-only
  // destination, deployed principal derived from the vault) went with the
  // instruction. Ticket 05's solvency check replaces the last one.
});

// --- Roles (ticket 01) ---------------------------------------------------
//
// Anchor deserializes every account before it runs a single constraint, so
// the matrix needs Epoch 1 and Round 1 to exist or the wrong signer is
// masked by AccountNotInitialized. `rolePool` opens both; the accounts after
// them in each struct are never read, so any address fills those slots.

const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

const NO_PARAMS = {
  epochSeconds: null,
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
};

/** A funded throwaway key. The `init` accounts on the operator-gated
 *  instructions charge rent to the signer before the role constraint runs,
 *  so a broke wrong signer would fail on lamports instead of on the role. */
async function fundedKey(): Promise<Keypair> {
  const keypair = Keypair.generate();
  const connection = program.provider.connection;
  await connection.confirmTransaction(
    await connection.requestAirdrop(keypair.publicKey, 2_000_000_000),
    "confirmed",
  );
  return keypair;
}

/** A pool with Epoch 1 open and Round 1 created, both by the real operator. */
async function rolePool(): Promise<PoolCtx> {
  const pool = await setupPool({ roundSeconds: 60 });
  await program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, 0n),
      epochTwoBehind: epochPda(pool.pool, 0n),
      newEpoch: epochPda(pool.pool, 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();

  const startsAt = await onChainNowSeconds();
  await program.methods
    .createRound(new BN(startsAt), new BN(startsAt + 60))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, 1n),
      round: roundPda(pool.pool, 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
  return pool;
}

/**
 * Every operator-gated instruction, built with `signer` in the operator slot.
 *
 * `settle_round`, `void_round`, `draw` and `rollover_epoch` are deliberately
 * absent (production-hardening ticket 01): they take any `caller`, so an
 * operator that stops cranking cannot withhold a fulfilled result or leave a
 * timed-out request stuck. Their permissionless behavior is covered by the
 * "settle_round, void_round, draw and rollover_epoch accept any caller" test
 * below and by tests/03-epochs.test.ts's `payout` coverage.
 */
function operatorGated(pool: PoolCtx, signer: PublicKey) {
  const epoch = epochPda(pool.pool, 1n);
  const m = program.methods;
  return {
    // Round 1 is already open, so this one is aimed at the next id.
    createRound: m.createRound(new BN(0), new BN(60)).accountsPartial({
      operator: signer,
      pool: pool.pool,
      currentEpoch: epoch,
      round: roundPda(pool.pool, 2n),
      systemProgram: SystemProgram.programId,
    }),
    beginEpoch: m.beginEpoch().accountsPartial({
      operator: signer,
      pool: pool.pool,
      currentEpoch: epoch,
      epochTwoBehind: epochPda(pool.pool, 0n),
      newEpoch: epochPda(pool.pool, 2n),
      systemProgram: SystemProgram.programId,
    }),
    // `request_draw` replaced `close_registration` (ticket 08): operator-only,
    // since the signer also pays ORAO's fee.
    requestDraw: m.requestDraw(Array.from(testNonce())).accountsPartial({
      operator: signer,
      pool: pool.pool,
      epoch,
      jackpotVault: pool.jackpotVault,
      randomness: randomnessPda(vrfSeed("epoch", pool.pool, 1n, testNonce())),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"),
      systemProgram: SystemProgram.programId,
    }),
    // `payout` is deliberately absent: it takes no signer at all, so the
    // operator cannot veto a winner by sitting out `payout_timeout`. A
    // stranger paying one successfully is in tests/03-epochs.test.ts.
  };
}

/** Every admin-gated instruction, built with `signer` in the admin slot. */
function adminGated(pool: PoolCtx, signer: PublicKey) {
  const m = program.methods;
  return {
    setParams: m.setParams(NO_PARAMS).accountsPartial({ admin: signer, pool: pool.pool }),
    setOperator: m
      .setOperator(Keypair.generate().publicKey)
      .accountsPartial({ admin: signer, pool: pool.pool }),
    proposeAdmin: m
      .proposeAdmin(Keypair.generate().publicKey)
      .accountsPartial({ admin: signer, pool: pool.pool }),
  };
}

describe("roles", () => {
  it(
    "create_pool records both roles, no pending handover, and the House belongs to the operator",
    async () => {
      const pool = await setupPool();

      const account = await program.account.pool.fetch(pool.pool);
      expect(account.admin.toBase58()).toBe(pool.admin.publicKey.toBase58());
      expect(account.operator.toBase58()).toBe(pool.operator.publicKey.toBase58());
      expect(account.pendingAdmin.toBase58()).toBe(PublicKey.default.toBase58());
      expect((await program.account.player.fetch(pool.house)).owner.toBase58()).toBe(
        pool.operator.publicKey.toBase58(),
      );
    },
    TIMEOUT,
  );

  it(
    "create_pool writes the Weight tree header, the House's leaf and the venue defaults",
    async () => {
      const pool = await setupPool();

      const tree = await program.account.weightTree.fetch(pool.weightTree);
      expect(tree.version).toBe(1);
      expect(tree.nodeSize).toBe(56);
      // The House never deposits but can win, so create_pool gives it leaf 1.
      expect(tree.nodeCount.toString()).toBe("1");
      expect(tree.pool.toBase58()).toBe(pool.pool.toBase58());
      const info = await program.provider.connection.getAccountInfo(pool.weightTree);
      expect(info?.data.length).toBe(WEIGHT_TREE_SPACE + 56);
      expect(info?.owner.toBase58()).toBe(program.programId.toBase58());
      expect((await program.account.player.fetch(pool.house)).leafIndex).toBe(1);

      const account = await program.account.pool.fetch(pool.pool);
      expect(account.version).toBe(2);
      expect(account.weightTree.toBase58()).toBe(pool.weightTree.toBase58());
      expect(account.yieldFeeBps).toBe(1_000);
      expect(account.idleFloorBps).toBe(500);
      expect(account.idleTargetBps).toBe(1_000);
      expect(account.reserveShareCapBps).toBe(500);
      expect(account.reserveLiquidityFloorBps).toBe(20_000);
      expect(account.minVenueMove.toString()).toBe("100000000");
      expect(account.lossToleranceBps).toBe(1);
      expect(account.yieldIndex.toString()).toBe("0");
      expect([account.deployPaused, account.impaired, account.buyTicketsPaused]).toEqual([
        false,
        false,
        false,
      ]);
      const house = await program.account.player.fetch(pool.house);
      expect(house.version).toBe(2);
      expect(house.leafIndex).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "every operator-gated instruction rejects the admin and a stranger",
    async () => {
      const pool = await rolePool();
      const stranger = await fundedKey();

      for (const wrong of [pool.admin, stranger]) {
        for (const [name, builder] of Object.entries(operatorGated(pool, wrong.publicKey))) {
          await expect(builder.signers([wrong]).rpc(), name).rejects.toThrow(/ConstraintHasOne/);
        }
      }
    },
    TIMEOUT,
  );

  it(
    "settle_round and void_round accept any caller, and refuse the wrong precondition regardless of who calls",
    async () => {
      // Production-hardening ticket 01: `caller` may be any signer. A
      // stranger succeeds exactly when the operator would have, and is
      // refused by the same preconditions (unfulfilled/fulfilled/timeout),
      // never by who they are.
      const pool = await setupPool({ roundSeconds: 4, closeBuffer: 1, vrfTimeout: 2 });
      const stranger = await fundedKey();

      const startsAt = await onChainNowSeconds();
      const endsAt = startsAt + 4;
      await program.methods
        .createRound(new BN(startsAt), new BN(endsAt))
        .accountsPartial({
          operator: pool.operator.publicKey,
          pool: pool.pool,
          currentEpoch: pool.pool,
          round: roundPda(pool.pool, 1n),
          systemProgram: SystemProgram.programId,
        })
        .signers([pool.operator])
        .rpc();

      await sleepUntilOnChain(endsAt);

      const nonce = testNonce();
      const seed = vrfSeed("round", pool.pool, 1n, nonce);
      // `request_round_randomness` is permissionless (any `payer`); the
      // Operator is just the usual caller. A stranger who front-runs it pays
      // the ORAO fee and still cannot pick the result: one request per
      // Round, and pre-learning a seed's output makes that request fail.
      await program.methods
        .requestRoundRandomness(Array.from(nonce))
        .accountsPartial({
          payer: pool.operator.publicKey,
          pool: pool.pool,
          round: roundPda(pool.pool, 1n),
          randomness: randomnessPda(seed),
          vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
          vrfTreasury: DEVNET_VRF_TREASURY,
          vrfProgram: ORAO_VRF_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([pool.operator])
        .rpc();

      const settleRoundAsStranger = () =>
        program.methods
          .settleRound()
          .accountsPartial({
            caller: stranger.publicKey,
            pool: pool.pool,
            round: roundPda(pool.pool, 1n),
            randomness: randomnessPda(seed),
            house: pool.house,
          })
          .signers([stranger])
          .rpc();

      // Unfulfilled: under test-vrf the randomness account doesn't even
      // exist until test_fulfill creates it (real ORAO would have created a
      // Pending one at request time), so this reads as InvalidRandomnessAccount
      // rather than RandomnessNotFulfilled -- refused by the precondition
      // either way, never by who is calling.
      await expect(settleRoundAsStranger()).rejects.toThrow(/InvalidRandomnessAccount/);

      const voidRoundAsStranger = () =>
        program.methods
          .voidRound()
          .accountsPartial({
            caller: stranger.publicKey,
            pool: pool.pool,
            round: roundPda(pool.pool, 1n),
            randomness: randomnessPda(seed),
          })
          .signers([stranger])
          .rpc();

      // Before the vrf_timeout has elapsed: refused by VrfTimeoutNotElapsed.
      await expect(voidRoundAsStranger()).rejects.toThrow(/VrfTimeoutNotElapsed/);

      await fulfillRandomness(seed, randomnessFor(0));

      // Fulfilled: void is refused even past the timeout.
      const requested = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await sleepUntilOnChain(Number(requested.requestedAt.toString()) + 2 + 1);
      await expect(voidRoundAsStranger()).rejects.toThrow(/RandomnessAlreadyFulfilled/);

      // A stranger succeeds once the precondition holds.
      await settleRoundAsStranger();
      expect((await program.account.round.fetch(roundPda(pool.pool, 1n))).status).toBe(3); // Forfeited (no positions)
    },
    TIMEOUT,
  );

  it(
    "every admin-gated instruction rejects the operator and a stranger",
    async () => {
      const pool = await setupPool();
      const stranger = await fundedKey();

      for (const wrong of [pool.operator, stranger]) {
        for (const [name, builder] of Object.entries(adminGated(pool, wrong.publicKey))) {
          await expect(builder.signers([wrong]).rpc(), name).rejects.toThrow(/ConstraintHasOne/);
        }
      }
    },
    TIMEOUT,
  );

  it(
    "pause takes the admin or the operator, unpause takes only the admin",
    async () => {
      const pool = await setupPool();
      const stranger = await fundedKey();
      const setPauseBy = (signer: typeof pool.admin, paused: boolean) =>
        program.methods
          .setPause(paused)
          .accountsPartial({ signer: signer.publicKey, pool: pool.pool })
          .signers([signer])
          .rpc();

      await setPauseBy(pool.operator, true);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);

      await expect(setPauseBy(pool.operator, false)).rejects.toThrow(/Unauthorized/);
      await expect(setPauseBy(stranger, true)).rejects.toThrow(/Unauthorized/);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);

      await setPauseBy(pool.admin, false);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(false);

      await setPauseBy(pool.admin, true);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "set_feature_pause follows set_pause's role rule, for each feature on its own",
    async () => {
      const pool = await setupPool();
      const stranger = await fundedKey();
      const fieldFor = (feature: Feature) =>
        feature === "Game" ? ("gamePaused" as const) : ("jackpotPaused" as const);

      for (const feature of ["Game", "Jackpot"] as const) {
        const sig = await setFeaturePause(pool, pool.operator, feature, true);
        expect((await program.account.pool.fetch(pool.pool))[fieldFor(feature)]).toBe(true);

        const event = await findEvent<{ pool: PublicKey; paused: boolean; at: BN }>(
          sig,
          "featurePaused",
        );
        expect(event?.pool.toBase58()).toBe(pool.pool.toBase58());
        expect(event?.paused).toBe(true);

        await expect(setFeaturePause(pool, pool.operator, feature, false)).rejects.toThrow(
          /Unauthorized/,
        );
        await expect(setFeaturePause(pool, stranger, feature, true)).rejects.toThrow(
          /Unauthorized/,
        );
        expect((await program.account.pool.fetch(pool.pool))[fieldFor(feature)]).toBe(true);

        await setFeaturePause(pool, pool.admin, feature, false);
        expect((await program.account.pool.fetch(pool.pool))[fieldFor(feature)]).toBe(false);
      }
    },
    TIMEOUT,
  );

  it(
    "turning one switch off never turns the other off by accident",
    async () => {
      const pool = await setupPool();
      await setFeaturePause(pool, pool.admin, "Game", true);
      await setFeaturePause(pool, pool.admin, "Jackpot", true);

      await setFeaturePause(pool, pool.admin, "Game", false);
      expect((await program.account.pool.fetch(pool.pool)).jackpotPaused).toBe(true);
      expect((await program.account.pool.fetch(pool.pool)).gamePaused).toBe(false);

      await setFeaturePause(pool, pool.admin, "Jackpot", false);
      expect((await program.account.pool.fetch(pool.pool)).jackpotPaused).toBe(false);
      expect((await program.account.pool.fetch(pool.pool)).gamePaused).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "set_feature_pause(false) is refused once shut down, for both features, but pause(true) still no-ops",
    async () => {
      const pool = await setupPool();
      await shutdown(pool);

      await expect(setFeaturePause(pool, pool.admin, "Game", false)).rejects.toThrow(
        /PoolShutDown/,
      );
      await expect(setFeaturePause(pool, pool.admin, "Jackpot", false)).rejects.toThrow(
        /PoolShutDown/,
      );
      await setFeaturePause(pool, pool.admin, "Game", true);
      await setFeaturePause(pool, pool.admin, "Jackpot", true);
    },
    TIMEOUT,
  );

  it(
    "set_operator rotates the crank key and locks the old one out",
    async () => {
      const pool = await rolePool();
      const next = Keypair.generate();

      const signature = await program.methods
        .setOperator(next.publicKey)
        .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
        .signers([pool.admin])
        .rpc();

      expect((await program.account.pool.fetch(pool.pool)).operator.toBase58()).toBe(
        next.publicKey.toBase58(),
      );
      const event = await findEvent<{ previous: PublicKey; operator: PublicKey }>(
        signature,
        "operatorChanged",
      );
      expect(event?.previous.toBase58()).toBe(pool.operator.publicKey.toBase58());
      expect(event?.operator.toBase58()).toBe(next.publicKey.toBase58());

      await expect(
        operatorGated(pool, pool.operator.publicKey)
          .beginEpoch.signers([pool.operator])
          .rpc(),
      ).rejects.toThrow(/ConstraintHasOne/);
    },
    TIMEOUT,
  );

  it(
    "propose_admin then accept_admin hands the role over in two steps",
    async () => {
      const pool = await setupPool();
      const wrong = Keypair.generate();
      const next = await fundedKey();
      const acceptBy = (signer: typeof next) =>
        program.methods
          .acceptAdmin()
          .accountsPartial({ pendingAdmin: signer.publicKey, pool: pool.pool })
          .signers([signer])
          .rpc();

      // Nothing proposed yet.
      await expect(acceptBy(next)).rejects.toThrow(/NoPendingAdmin/);

      const proposeTo = (candidate: PublicKey) =>
        program.methods
          .proposeAdmin(candidate)
          .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
          .signers([pool.admin])
          .rpc();

      // A second proposal replaces the first, so the typo never lands.
      await proposeTo(wrong.publicKey);
      const proposal = await proposeTo(next.publicKey);
      expect(
        (
          await findEvent<{ pendingAdmin: PublicKey }>(proposal, "adminProposed")
        )?.pendingAdmin.toBase58(),
      ).toBe(next.publicKey.toBase58());
      expect((await program.account.pool.fetch(pool.pool)).pendingAdmin.toBase58()).toBe(
        next.publicKey.toBase58(),
      );

      await expect(acceptBy(wrong)).rejects.toThrow(/Unauthorized/);

      const handover = await acceptBy(next);
      const changed = await findEvent<{ previous: PublicKey; admin: PublicKey }>(
        handover,
        "adminChanged",
      );
      expect(changed?.previous.toBase58()).toBe(pool.admin.publicKey.toBase58());
      expect(changed?.admin.toBase58()).toBe(next.publicKey.toBase58());

      const account = await program.account.pool.fetch(pool.pool);
      expect(account.admin.toBase58()).toBe(next.publicKey.toBase58());
      expect(account.pendingAdmin.toBase58()).toBe(PublicKey.default.toBase58());

      // The old admin is now just another wrong signer.
      await expect(
        adminGated(pool, pool.admin.publicKey).setParams.signers([pool.admin]).rpc(),
      ).rejects.toThrow(/ConstraintHasOne/);
      await program.methods
        .setParams(NO_PARAMS)
        .accountsPartial({ admin: next.publicKey, pool: pool.pool })
        .signers([next])
        .rpc();
    },
    TIMEOUT,
  );
});

// --- create_pool parameter guards (ticket 10). Both of these fail before
// anything is written, but only after the vault accounts have been
// initialised, so the transaction has to be rejected as a whole.

describe("create_pool guards", () => {
  /** Every account `create_pool` needs for a fresh pool paid for by `payer`. */
  function createPoolAccounts(
    payer: Keypair,
    pool: PublicKey,
    mint: PublicKey,
    treasury: PublicKey,
    buybackReserve: PublicKey,
    tokenProgram: PublicKey,
  ) {
    return {
      payer: payer.publicKey,
      pool,
      acceptedMint: mint,
      principalVault: principalVaultPda(pool),
      jackpotVault: jackpotVaultPda(pool),
      house: playerPda(pool, payer.publicKey),
      treasury,
      buybackReserve,
      // Pinned unchecked; these cases never reach a sync, so the stub's
      // accounts need not exist.
      ...venueAccountsFor(pool),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    };
  }

  /** `create_pool` with the Weight tree's `create_account` in front of it,
   *  `space` bytes big (the right size unless a test says otherwise). */
  async function createPoolWith(
    payer: Keypair,
    p: ReturnType<typeof params>,
    accounts: ReturnType<typeof createPoolAccounts>,
    space = WEIGHT_TREE_SPACE,
  ) {
    const tree = Keypair.generate();
    const createTree = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: tree.publicKey,
      space,
      lamports: await program.provider.connection.getMinimumBalanceForRentExemption(space),
      programId: program.programId,
    });
    return program.methods
      .createPool(p)
      .accountsPartial({ ...accounts, weightTree: tree.publicKey })
      .preInstructions([createTree])
      .signers([payer, tree])
      .rpc();
  }

  // `admin` and `operator` default to a live key: the program rejects the
  // default one outright, and every case here is about some other guard.
  const params = (over: Record<string, BN | number | PublicKey> = {}) => ({
    poolId: new BN(0),
    admin: Keypair.generate().publicKey,
    operator: Keypair.generate().publicKey,
    vrfNetworkState: PublicKey.default,
    epochSeconds: new BN(86_400),
    epochAnchor: new BN(1_789_315_200),
    roundSeconds: new BN(60),
    closeBuffer: new BN(5),
    vrfTimeout: new BN(120),
    minDeposit: new BN(1_000_000),
    houseCutBps: 600,
    minJackpot: new BN(0),
    payoutTimeout: new BN(82_800),
    baseRateBps: 488,
    ticketsPerUsdc: 10,
    bonusCapBps: 500,
    ...over,
  });

  it(
    "rejects a mint owned by Token-2022",
    async () => {
      const payer = await fundedKey();
      const connection = program.provider.connection;
      // Token-2022 mints can carry a transfer fee, which would silently
      // shrink every vault movement the payout arithmetic assumes is exact.
      const mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        6,
        Keypair.generate(),
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const token = (): Promise<PublicKey> =>
        createAccount(
          connection,
          payer,
          mint,
          payer.publicKey,
          Keypair.generate(),
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
      const poolId = nextPoolId();
      const pool = poolPda(poolId);

      await expect(
        createPoolWith(
          payer,
          params({ poolId: new BN(poolId.toString()), operator: payer.publicKey }),
          createPoolAccounts(
            payer,
            pool,
            mint,
            await token(),
            await token(),
            TOKEN_2022_PROGRAM_ID,
          ),
        ),
      ).rejects.toThrow(/UnsupportedMint/);
    },
    TIMEOUT,
  );

  it(
    "rejects a default admin or operator, which nobody could ever sign for",
    async () => {
      const payer = await fundedKey();
      const connection = program.provider.connection;
      const mint = await createMint(connection, payer, payer.publicKey, null, 6);
      const token = (): Promise<PublicKey> =>
        createAccount(connection, payer, mint, payer.publicKey, Keypair.generate());
      const treasury = await token();
      const buybackReserve = await token();
      const attempt = (role: "admin" | "operator") => {
        const poolId = nextPoolId();
        const pool = poolPda(poolId);
        const operator = role === "operator" ? PublicKey.default : payer.publicKey;
        return createPoolWith(
          payer,
          params({
            poolId: new BN(poolId.toString()),
            operator,
            [role]: PublicKey.default,
          }),
          {
            ...createPoolAccounts(payer, pool, mint, treasury, buybackReserve, TOKEN_PROGRAM_ID),
            // Seeded from `params.operator`, so the House address has to
            // follow it or Anchor fails on the seeds before the guard runs.
            house: playerPda(pool, operator),
          },
        );
      };

      await expect(attempt("admin")).rejects.toThrow(/InvalidParameter/);
      await expect(attempt("operator")).rejects.toThrow(/InvalidParameter/);
    },
    TIMEOUT,
  );

  it(
    "rejects a zero payout_timeout, and a Weight tree account that is not header-sized",
    async () => {
      const payer = await fundedKey();
      const connection = program.provider.connection;
      const mint = await createMint(connection, payer, payer.publicKey, null, 6);
      const token = (): Promise<PublicKey> =>
        createAccount(connection, payer, mint, payer.publicKey, Keypair.generate());
      const treasury = await token();
      const buybackReserve = await token();
      const attempt = (payoutTimeout: number, treeSpace = WEIGHT_TREE_SPACE) => {
        const poolId = nextPoolId();
        const pool = poolPda(poolId);
        return createPoolWith(
          payer,
          params({
            poolId: new BN(poolId.toString()),
            operator: payer.publicKey,
            payoutTimeout: new BN(payoutTimeout),
          }),
          createPoolAccounts(payer, pool, mint, treasury, buybackReserve, TOKEN_PROGRAM_ID),
          treeSpace,
        );
      };

      // Zero would let a Drawn epoch be rolled over in the block it was
      // drawn in, which is what the timeout exists to stop.
      await expect(attempt(0)).rejects.toThrow(/InvalidParameter/);
      // The account arrives header-sized and create_pool grows it by the
      // House's leaf, so one that already holds a node is refused.
      await expect(attempt(82_800, WEIGHT_TREE_SPACE + 56)).rejects.toThrow(/InvalidParameter/);
      await attempt(82_800);
    },
    TIMEOUT,
  );

  it(
    "a fresh pool reads game_paused and jackpot_paused as true, before anyone starts either",
    async () => {
      const payer = await fundedKey();
      const connection = program.provider.connection;
      const mint = await createMint(connection, payer, payer.publicKey, null, 6);
      const token = (): Promise<PublicKey> =>
        createAccount(connection, payer, mint, payer.publicKey, Keypair.generate());
      const treasury = await token();
      const buybackReserve = await token();
      const poolId = nextPoolId();
      const pool = poolPda(poolId);

      await createPoolWith(
        payer,
        params({ poolId: new BN(poolId.toString()), operator: payer.publicKey }),
        createPoolAccounts(payer, pool, mint, treasury, buybackReserve, TOKEN_PROGRAM_ID),
      );

      const account = await program.account.pool.fetch(pool);
      expect(account.gamePaused).toBe(true);
      expect(account.jackpotPaused).toBe(true);
    },
    TIMEOUT,
  );
});
