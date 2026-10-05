// Fenwick weight tree (yield-claimer tickets 08 and 19, ADR 0018): a Player's
// leaf grows with their first deposit, every Ticket change keeps the tree equal
// to an eager count of each Player's Tickets, a deposit counts the same at the
// first second and at the last of an epoch, and the draw's target lands in
// exactly one leaf. The last test measures compute at 16,384 nodes.
//
// Epochs here run a few tens of seconds so a test can live through two or
// three of them against a real localnet validator.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  fetchTree,
  findEvent,
  fulfillRandomness,
  leafTickets,
  onChainNowSeconds,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessFor,
  randomnessForTarget,
  randomnessPda,
  requestDrawMethod,
  retryUntilOk,
  roundPda,
  setupPool,
  sleepUntilOnChain,
  testNonce,
  txInfo,
  unbiasedU64,
  vrfSeed,
  ticketsOf,
  type PoolCtx,
  type TreeClock,
} from "./helpers/hx.js";

const TIMEOUT = 240_000;
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

type Wallet = { keypair: Keypair; tokenAccount: PublicKey };

// --- Instruction helpers -----------------------------------------------------

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

/** `currentEpochId` is `pool.currentEpochId` *before* this call. */
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

async function createRound(pool: PoolCtx, currentEpochId: bigint, roundId: bigint, seconds: number) {
  const startsAt = await onChainNowSeconds();
  await program.methods
    .createRound(new BN(startsAt), new BN(startsAt + seconds))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      round: roundPda(pool.pool, roundId),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
  return startsAt + seconds;
}

async function buyPosition(
  pool: PoolCtx,
  owner: Wallet,
  roundId: bigint,
  tiles: bigint,
  stakePerTile: bigint,
) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round: roundPda(pool.pool, roundId),
      position: positionPda(roundPda(pool.pool, roundId), owner.keypair.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

async function requestRoundRandomness(pool: PoolCtx, roundId: bigint): Promise<Uint8Array> {
  const nonce = testNonce();
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

async function settleRound(pool: PoolCtx, roundId: bigint, randomness: PublicKey) {
  return program.methods
    .settleRound()
    .accountsPartial({
      caller: pool.operator.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness,
      house: pool.house,
    })
    .signers([pool.operator])
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

async function draw(pool: PoolCtx, epochId: bigint, randomness: PublicKey) {
  return program.methods
    .draw()
    .accountsPartial({
      caller: pool.operator.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      randomness,
    })
    .signers([pool.operator])
    .rpc();
}

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

const fetchEpoch = (pool: PoolCtx, id: bigint) => program.account.epoch.fetch(epochPda(pool.pool, id));
const fetchPlayer = (pool: PoolCtx, owner: PublicKey) =>
  program.account.player.fetch(playerPda(pool.pool, owner));
const big = (n: { toString(): string }): bigint => BigInt(n.toString());

// --- The eager model: what `touch` leaves each Player holding ----------------
//
// A copy of the model the Rust property test uses, kept here so the program's
// instructions are held to the same numbers.

class Eager {
  principal = 0n;
  entries = 0n;
  epochId: bigint;
  frozenTickets = 0n;
  frozenEpoch = 0n;
  /** The epoch the Player was created in. Earlier epochs read zero. */
  created: bigint;

  constructor(clock: TreeClock) {
    this.epochId = clock.current;
    this.created = clock.current;
  }

  touch(c: TreeClock): void {
    if (this.epochId >= c.current) return;
    const previous = c.current - 1n;
    this.frozenTickets = this.epochId === previous ? this.entries : this.principal;
    this.frozenEpoch = previous;
    this.entries = this.principal;
    this.epochId = c.current;
  }

  /** Tickets held at the end of epoch `e`. */
  tickets(e: bigint): bigint {
    if (this.created > e) return 0n;
    if (this.epochId === e) return this.entries;
    if (this.epochId > e) {
      expect(this.frozenEpoch, "the tree would refuse this read").toBe(e);
      return this.frozenTickets;
    }
    return this.principal;
  }
}

describe("weight tree", () => {
  it(
    "a first deposit grows the tree by one node and the depositor pays the rent delta; a second does not grow it",
    async () => {
      const pool = await setupPool();
      const a = await pool.fundedWallet(10_000_000n);
      const connection = provider.connection;

      const treeBefore = await fetchTree(pool);
      const infoBefore = await connection.getAccountInfo(pool.weightTree);
      const walletBefore = await connection.getBalance(a.keypair.publicKey);
      const operatorBefore = await connection.getBalance(pool.operator.publicKey);
      expect(treeBefore.nodes.length).toBe(1); // the House

      await deposit(pool, a, 2_000_000n);

      const treeAfter = await fetchTree(pool);
      const infoAfter = await connection.getAccountInfo(pool.weightTree);
      expect(treeAfter.nodes.length).toBe(2);
      expect(treeAfter.dataLen).toBe(treeBefore.dataLen + 56);
      expect((await fetchPlayer(pool, a.keypair.publicKey)).leafIndex).toBe(2);

      // The tree account stays rent exempt at its new size, and the depositor
      // is the one who paid for it.
      const rentDelta =
        (await connection.getMinimumBalanceForRentExemption(treeAfter.dataLen)) -
        (await connection.getMinimumBalanceForRentExemption(treeBefore.dataLen));
      expect(infoAfter!.lamports - infoBefore!.lamports).toBe(rentDelta);
      const playerRent = await connection.getMinimumBalanceForRentExemption(
        (await connection.getAccountInfo(playerPda(pool.pool, a.keypair.publicKey)))!.data.length,
      );
      const walletAfter = await connection.getBalance(a.keypair.publicKey);
      expect(walletBefore - walletAfter).toBeGreaterThanOrEqual(rentDelta + playerRent);
      expect(await connection.getBalance(pool.operator.publicKey)).toBe(operatorBefore);

      // The same wallet again: no new node, no new rent.
      await deposit(pool, a, 1_000_000n);
      const treeAgain = await fetchTree(pool);
      expect(treeAgain.nodes.length).toBe(2);
      expect(treeAgain.dataLen).toBe(treeAfter.dataLen);
      expect((await connection.getAccountInfo(pool.weightTree))!.lamports).toBe(infoAfter!.lamports);
      expect((await fetchPlayer(pool, a.keypair.publicKey)).leafIndex).toBe(2);

      // A second wallet takes the next leaf.
      const b = await pool.fundedWallet(10_000_000n);
      await deposit(pool, b, 2_000_000n);
      expect((await fetchPlayer(pool, b.keypair.publicKey)).leafIndex).toBe(3);
      expect((await fetchTree(pool)).nodes.length).toBe(3);
    },
    TIMEOUT,
  );

  it(
    "a mixed sequence of Ticket changes matches the eager model to the unit, in the current and the previous epoch",
    async () => {
      const pool = await setupPool({ epochSeconds: 60, roundSeconds: 6, closeBuffer: 1, bonusCapBps: 10_000 });
      const wallets = {
        a: await pool.fundedWallet(100_000_000n),
        b: await pool.fundedWallet(100_000_000n),
        c: await pool.fundedWallet(100_000_000n),
      };
      const owners = {
        house: pool.operator.publicKey,
        a: wallets.a.keypair.publicKey,
        b: wallets.b.keypair.publicKey,
        c: wallets.c.keypair.publicKey,
      };
      type Name = keyof typeof owners;
      const names = Object.keys(owners) as Name[];

      const model = new Map<Name, Eager>();
      const clock = async (): Promise<TreeClock> => (await fetchTree(pool)).clock;
      model.set("house", new Eager(await clock()));
      const join = async (name: Name) => {
        if (!model.has(name)) model.set(name, new Eager(await clock()));
        return model.get(name) as Eager;
      };
      /** The Player's own `touch`, which every instruction runs first. */
      const touched = async (name: Name) => {
        const m = model.get(name) as Eager;
        m.touch(await clock());
        return m;
      };

      /** The tree against the model, for every Player, in each readable epoch. */
      let checks = 0;
      const leaves = new Map<Name, number>(); // a Player's leaf never moves
      const check = async (label: string) => {
        const tree = await fetchTree(pool);
        const c = tree.clock;
        for (const e of c.current > 0n ? [c.current, c.current - 1n] : [c.current]) {
          if (e === 0n) continue;
          const held = leafTickets(tree, e);
          let sum = 0n;
          for (const name of names) {
            const eager = model.get(name);
            if (!eager) continue;
            if (!leaves.has(name)) leaves.set(name, (await fetchPlayer(pool, owners[name])).leafIndex);
            const leaf = leaves.get(name) as number;
            expect(held[leaf - 1], `${label}: ${name} in epoch ${e}`).toBe(eager.tickets(e));
            sum += eager.tickets(e);
            checks += 1;
          }
          // The root is the sum of every Player's Tickets.
          expect(held.reduce((x, y) => x + y, 0n), `${label}: root of epoch ${e}`).toBe(sum);
        }
      };

      // Epoch 0: `a` deposits before the first epoch begins.
      await deposit(pool, wallets.a, 5_000_000n);
      const ma0 = await join("a");
      ma0.principal += 5_000_000n;
      ma0.entries += 5_000_000n;
      await check("a deposits before epoch 1");

      await beginEpoch(pool, 0n); // epoch 1
      await check("epoch 1 begins");

      // Epoch 1: first deposits, bought and granted Tickets.
      for (const [name, amount] of [["b", 4_000_000n], ["c", 3_000_000n]] as const) {
        await deposit(pool, wallets[name], amount);
        const m = await join(name);
        m.touch(await clock());
        m.principal += amount;
        m.entries += amount;
        await check(`${name} deposits`);
      }
      await buyTickets(pool, wallets.b, 1_000_000n);
      (await touched("b")).entries += 1_000_000n * BigInt(pool.ticketsPerUsdc);
      await check("b buys tickets");

      await grantTickets(pool, owners.a, 2_000_000n);
      (await touched("a")).entries += 2_000_000n;
      await check("a is granted tickets");

      // A round: three stakes, tile 0 wins, so `a` collects from the pot and
      // the House takes its cut.
      await createRound(pool, 1n, 1n, 6);
      const stakes = [
        ["a", 0n, 1_000_000n],
        ["b", 1n, 500_000n],
        ["c", 2n, 250_000n],
      ] as const;
      for (const [name, tile, stake] of stakes) {
        await buyPosition(pool, wallets[name], 1n, 1n << tile, stake);
        (await touched(name)).entries -= stake;
        await check(`${name} buys a position`);
      }
      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      await settleRound(pool, 1n, await fulfillRandomness(seed, randomnessFor(0)));
      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(round.status).toBe(2); // Settled
      (await touched("house")).entries += big(round.houseCut);
      await check("the round settles");

      for (const name of ["a", "b", "c"] as const) {
        const sig = await settlePosition(pool, 1n, owners[name]);
        const reward = big((await findEvent<{ reward: BN }>(sig, "positionSettled"))!.reward);
        (await touched(name)).entries += reward;
        await check(`${name} settles a position`);
      }

      await requestWithdraw(pool, wallets.c, 1_000_000n);
      const mc = await touched("c");
      mc.principal -= 1_000_000n;
      mc.entries = mc.entries > 1_000_000n ? mc.entries - 1_000_000n : 0n;
      await check("c requests a withdrawal");

      // Epoch 2: epoch 1 stays readable behind it.
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await check("epoch 2 begins");

      await deposit(pool, wallets.a, 1_000_000n);
      const ma = await touched("a");
      ma.principal += 1_000_000n;
      ma.entries += 1_000_000n;
      await check("a deposits in epoch 2");

      await requestWithdraw(pool, wallets.b, 2_000_000n);
      const mb = await touched("b");
      mb.principal -= 2_000_000n;
      mb.entries = mb.entries > 2_000_000n ? mb.entries - 2_000_000n : 0n;
      await check("b requests a withdrawal in epoch 2");

      // Epoch 3: epoch 1 is gone, epoch 2 is the previous one, and `c`, idle
      // all of epoch 2, still holds its Principal there.
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await check("epoch 3 begins");

      await grantTickets(pool, owners.c, 500_000n);
      (await touched("c")).entries += 500_000n;
      await check("c is granted tickets in epoch 3");

      expect(checks).toBeGreaterThan(80);
    },
    480_000,
  );

  it(
    "a deposit at the first second and one at the last second of an epoch show the same Tickets, and the ended epoch's root is the sum of every Player's",
    async () => {
      const pool = await setupPool({ epochSeconds: 12 });
      const early = await pool.fundedWallet(10_000_000n);
      const late = await pool.fundedWallet(10_000_000n);
      const gap = await pool.fundedWallet(10_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await beginEpoch(pool, 0n);
      await deposit(pool, early, 4_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      await sleepUntilOnChain(endsAt - 1);
      await deposit(pool, late, 4_000_000n);
      const tickets = async (w: Wallet, e: bigint) => ticketsOf(pool, w.keypair.publicKey, e);
      expect(await tickets(late, 1n)).toBe(4_000_000n);
      expect(await tickets(late, 1n)).toBe(await tickets(early, 1n));

      // Epoch 1 has ended and nobody has called begin_epoch yet. A change in
      // that gap lands in the epoch still current, which is epoch 1.
      await sleepUntilOnChain(endsAt + 1);
      await deposit(pool, gap, 5_000_000n);
      expect(await tickets(gap, 1n)).toBe(5_000_000n);

      await beginEpoch(pool, 1n);
      // Epoch 2 holds every Principal in full, deposited early or late.
      expect(await tickets(early, 2n)).toBe(4_000_000n);
      expect(await tickets(late, 2n)).toBe(4_000_000n);
      expect(await tickets(gap, 2n)).toBe(5_000_000n);

      // The draw for epoch 1 snapshots what was there when it ended.
      await requestDrawMethod(pool, 1n).rpc();
      expect(big((await fetchEpoch(pool, 1n)).registeredWeight)).toBe(13_000_000n);
    },
    TIMEOUT,
  );

  it(
    "the draw hashes the 64 bytes to a target under the epoch's root, and payout takes only the leaf that holds it",
    async () => {
      const pool = await setupPool({ epochSeconds: 8 });
      const players = [
        await pool.fundedWallet(10_000_000n),
        await pool.fundedWallet(10_000_000n),
        await pool.fundedWallet(10_000_000n),
      ];
      const funder = await pool.fundedWallet(10_000_000n);
      await deposit(pool, players[0]!, 3_000_000n);
      await deposit(pool, players[1]!, 2_000_000n);
      await deposit(pool, players[2]!, 1_000_000n);
      await beginEpoch(pool, 0n);
      await fundJackpot(pool, funder, 3_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await requestDrawMethod(pool, 1n).rpc();

      const drawing = await fetchEpoch(pool, 1n);
      const tree = await fetchTree(pool);
      const held = leafTickets(tree, 1n);
      const root = held.reduce((s, t) => s + t, 0n);
      expect(root).toBe(6_000_000n);
      expect(big(drawing.registeredWeight)).toBe(root);

      // Aim the randomness at the middle player's range.
      const start = (held[0] as bigint) + (held[1] as bigint); // after the House and player 0
      const end = start + (held[2] as bigint);
      const randomness = randomnessForTarget(root, start, end);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(drawing.vrfSeed), randomness));

      const drawn = await fetchEpoch(pool, 1n);
      expect(big(drawn.target)).toBe(unbiasedU64(randomness, root));
      expect(big(drawn.target) >= start && big(drawn.target) < end).toBe(true);

      // The first and the third players' ranges do not hold the target.
      for (const wrong of [players[0]!, players[2]!]) {
        await expect(payout(pool, 1n, wrong.keypair.publicKey)).rejects.toThrow(/NotTheWinner/);
      }
      await expect(payout(pool, 1n, pool.operator.publicKey)).rejects.toThrow(/NotTheWinner/);
      const before = await fetchPlayer(pool, players[1]!.keypair.publicKey);
      await payout(pool, 1n, players[1]!.keypair.publicKey);
      const after = await fetchPlayer(pool, players[1]!.keypair.publicKey);
      expect(big(after.principal) - big(before.principal)).toBe(3_000_000n);
      expect((await fetchEpoch(pool, 1n)).status).toBe(4); // Paid
    },
    TIMEOUT,
  );

  it(
    "a round records the slot of its VRF request and picks its tile from the hash of all 64 bytes",
    async () => {
      const pool = await setupPool({ roundSeconds: 5, closeBuffer: 1 });
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 5_000_000n);
      await createRound(pool, 0n, 1n, 5);
      await buyPosition(pool, a, 1n, 1n, 1_000_000n);

      const seed = await retryUntilOk(() => requestRoundRandomness(pool, 1n));
      const requested = await program.account.round.fetch(roundPda(pool.pool, 1n));
      const slot = await provider.connection.getSlot("confirmed");
      expect(big(requested.vrfRequestSlot) > 0n).toBe(true);
      expect(big(requested.vrfRequestSlot) <= BigInt(slot)).toBe(true);

      // Bytes 8..63 are not what the old reduction ignored any more: this
      // randomness has a zero leading u64, which the old code would read as
      // tile 0.
      const randomness = new Uint8Array(64).fill(9);
      randomness.set(new Uint8Array(8), 0);
      await settleRound(pool, 1n, await fulfillRandomness(seed, randomness));
      const settled = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(BigInt(settled.winningTile)).toBe(unbiasedU64(randomness, 36n));
    },
    TIMEOUT,
  );
});

describe("compute at 16,384 nodes", () => {
  it(
    "measures begin_epoch, a deposit and a buy_position against a tree of 16,384 nodes",
    async () => {
      const TARGET = 16_384;
      const units = async (sig: string) => (await txInfo(sig)).units;

      // begin_epoch on a small tree, for the constant-compute comparison. The
      // third call, like the one measured below: it reads the epoch two behind.
      const small = await setupPool({ epochSeconds: 6 });
      await beginEpoch(small, 0n);
      await retryUntilOk(() => beginEpoch(small, 1n));
      const smallBegin = await units(await retryUntilOk(() => beginEpoch(small, 2n)));

      const pool = await setupPool({ epochSeconds: 20, roundSeconds: 5, closeBuffer: 1 });
      const a = await pool.fundedWallet(100_000_000n); // leaf 2, path of 14 entries
      const a2 = await pool.fundedWallet(100_000_000n); // leaf 3, path of 13
      const b = await pool.fundedWallet(100_000_000n); // the 16,384th leaf
      const filler = Keypair.generate();
      for (let i = 0; i < 2; i += 1) {
        const sig = await provider.connection.requestAirdrop(filler.publicKey, 10_000_000_000);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }

      await beginEpoch(pool, 0n);
      await deposit(pool, a, 10_000_000n);
      await deposit(pool, a2, 10_000_000n);

      // Fill with zero-Ticket leaves, 142 to a transaction, until one short of
      // the target: House, a, a2 and these make 16,383, so b's first deposit
      // appends leaf 16,384, the append with the longest path.
      let nodes = (await fetchTree(pool)).nodes.length;
      while (nodes < TARGET - 1) {
        const count = Math.min(142, TARGET - 1 - nodes);
        await program.methods
          .testTreeFill(count)
          .accountsPartial({
            payer: filler.publicKey,
            pool: pool.pool,
            weightTree: pool.weightTree,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
          .signers([filler])
          .rpc();
        nodes += count;
      }
      expect((await fetchTree(pool)).nodes.length).toBe(TARGET - 1);

      // Epoch 3 current: every slot on every path is stale (last written in
      // epoch 1), so the first write of the epoch resets every entry on it.
      await retryUntilOk(() => beginEpoch(pool, 1n));
      const beginBig = await units(await retryUntilOk(() => beginEpoch(pool, 2n)));
      await createRound(pool, 3n, 1n, 5);
      const buyFirst = await units(await buyPosition(pool, a2, 1n, 1n, 1_000_000n));
      const firstDepositB = await units(await deposit(pool, b, 10_000_000n));
      expect((await fetchTree(pool)).nodes.length).toBe(TARGET);

      // Epoch 4 current: stale again for the other parity.
      await retryUntilOk(() => beginEpoch(pool, 3n));
      const depositFirstWrite = await units(await deposit(pool, a, 1_000_000n));
      const depositStamped = await units(await deposit(pool, a, 1_000_000n));

      const wSmall = await small.fundedWallet(10_000_000n);
      const depositSmall = await units(await deposit(small, wSmall, 2_000_000n));

      console.log(
        `COMPUTE nodes=${TARGET} begin_epoch(small tree)=${smallBegin} begin_epoch(16384)=${beginBig} ` +
          `buy_position(first write of epoch, leaf 3, 13 entries)=${buyFirst} ` +
          `deposit(first deposit, appends leaf 16384)=${firstDepositB} ` +
          `deposit(first write of epoch, leaf 2, 14 entries)=${depositFirstWrite} ` +
          `deposit(same path again)=${depositStamped} deposit(small tree, first deposit)=${depositSmall}`,
      );

      // begin_epoch takes no tree account, so it cannot scale with one. Two
      // calls differ by several thousand CU on PDA bump searches alone
      // (each failed bump is about 1.5k), so this is a ceiling, not a ratio.
      expect(beginBig).toBeLessThan(60_000);
      expect(smallBegin).toBeLessThan(60_000);
      expect(firstDepositB).toBeLessThan(200_000);
      expect(depositFirstWrite).toBeLessThan(200_000);
      expect(buyFirst).toBeLessThan(200_000);
    },
    900_000,
  );
});
