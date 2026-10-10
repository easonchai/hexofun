// The epoch draw over a committed Merkle sum root (off-chain-tickets ticket 09,
// ADR 0025): `request_draw` freezes the snapshot's root, total, depth and leaf
// count and mixes the root into the seed, and the permissionless `payout` pays
// only a proof that reaches them. The verifier's arithmetic is unit-tested in
// `snapshot.rs` against `tests/fixtures/sum-tree-vectors.json`; this suite
// drives it through the instructions, with trees built by the backend's own
// builder (`snapshotOf`), so the hashes cannot drift apart.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  assertSolvent,
  connection,
  epochPda,
  findEvent,
  fulfillRandomness,
  payoutRaw,
  playerPda,
  program,
  proofFor,
  randomnessForTarget,
  randomnessPda,
  requestDrawMethod,
  requestDrawRaw,
  retryUntilOk,
  setupPool,
  sleep,
  snapshotOf,
  testNonce,
  txInfo,
  vrfSeed,
  type DrawArgs,
  type Holding,
  type PoolCtx,
  type Snapshot,
} from "./helpers/hx.js";

const TIMEOUT = 120_000;
/** A serialized transaction may not pass this (solana's PACKET_DATA_SIZE). */
const PACKET = 1232;

const epoch_status = { ENDED: 1, DRAWING: 2, DRAWN: 3, PAID: 4 };

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const fetchEpoch = (pool: PoolCtx, id: bigint) => program.account.epoch.fetch(epochPda(pool.pool, id));
const fetchPlayer = (pool: PoolCtx, owner: PublicKey) =>
  program.account.player.fetch(playerPda(pool.pool, owner));
const vaultAmount = async (account: PublicKey) =>
  BigInt((await connection.getTokenAccountBalance(account)).value.amount);

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  await program.methods
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

async function fundJackpot(pool: PoolCtx, source: Wallet, amount: bigint) {
  await program.methods
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

const PRIZE = 2_000_000n;

/** A pool with `players` deposited, a prize in the jackpot vault and epoch 1
 *  open. Epoch 1 ends 6 s later; `drawEpoch1` waits for that. */
async function openPool(players: Wallet[] = []) {
  const pool = await setupPool({ epochSeconds: 6 });
  for (const player of players) await deposit(pool, player, 3_000_000n);
  await fundJackpot(pool, await pool.fundedWallet(10_000_000n), PRIZE);
  await beginEpoch(pool, 0n);
  return pool;
}

/** `winner`'s range `[lo, hi)` in the snapshot's leaf order. */
function rangeOf(s: Snapshot, winner: PublicKey): [bigint, bigint] {
  let lo = 0n;
  for (const h of s.held) {
    if (h.owner.equals(winner)) return [lo, lo + h.tickets];
    lo += h.tickets;
  }
  throw new Error("winner holds nothing");
}

const argsOf = (s: Snapshot, overrides: Partial<DrawArgs> = {}): DrawArgs => ({
  nonce: testNonce(),
  root: s.root,
  total: s.total,
  depth: s.depth,
  leafCount: s.leafCount,
  ...overrides,
});

/** Ends epoch 1, commits `args`, fulfils the VRF with randomness whose target
 *  lies in `winner`'s range of `args.total`, and draws. */
async function drawEpoch1(pool: PoolCtx, s: Snapshot, winner: PublicKey, args = argsOf(s)) {
  await retryUntilOk(() => beginEpoch(pool, 1n));
  await requestDrawRaw(pool, 1n, args).rpc();
  const drawing = await fetchEpoch(pool, 1n);
  const [lo, hi] = rangeOf(s, winner);
  const randomness = randomnessForTarget(args.total, lo, hi);
  await program.methods
    .draw()
    .accountsPartial({
      caller: pool.operator.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, 1n),
      randomness: await fulfillRandomness(Uint8Array.from(drawing.vrfSeed), randomness),
    })
    .signers([pool.operator])
    .rpc();
  expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWN);
}

/** `count` wallets that are no Players, ascending, one Ticket each. */
function fillers(count: number, tickets = 1n): Holding[] {
  return Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.alloc(32, 0x11);
    bytes.writeUInt32BE(i, 0);
    return { owner: new PublicKey(bytes), tickets };
  });
}

describe("request_draw commits the snapshot", () => {
  it(
    "refuses a bad shape by name, then stores the four fields and derives the seed with the root in it",
    async () => {
      const pool = await openPool();
      const held: Holding[] = [
        { owner: Keypair.generate().publicKey, tickets: 3n },
        ...fillers(4, 2n),
      ];
      const s = snapshotOf(held);
      expect([s.depth, s.leafCount]).toEqual([3, 5]);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const refuse = (overrides: Partial<DrawArgs>, name: RegExp) =>
        expect(requestDrawRaw(pool, 1n, argsOf(s, overrides)).rpc()).rejects.toThrow(name);
      await refuse({ depth: 19, leafCount: 1 << 18 }, /SnapshotDepthTooLarge/);
      await refuse({ leafCount: 9 }, /SnapshotLeafCountInvalid/); // 2^3 = 8
      await refuse({ leafCount: 0 }, /SnapshotLeafCountInvalid/);
      await refuse({ root: Buffer.alloc(32) }, /SnapshotRootZero/);
      const untouched = await fetchEpoch(pool, 1n);
      expect(untouched.status).toBe(epoch_status.ENDED);
      expect(untouched.leafCount).toBe(0);
      expect(untouched.snapshotDepth).toBe(0);

      const args = argsOf(s);
      await requestDrawRaw(pool, 1n, args).rpc();
      const epoch = await fetchEpoch(pool, 1n);
      expect(epoch.status).toBe(epoch_status.DRAWING);
      expect(Buffer.from(epoch.snapshotRoot)).toEqual(s.root);
      expect(big(epoch.totalTickets)).toBe(s.total);
      expect(epoch.snapshotDepth).toBe(3);
      expect(epoch.leafCount).toBe(5);
      // `requestDrawRaw` handed the program the randomness account TypeScript
      // computed from sha256("epoch" || pool || epoch || nonce || root || total),
      // and the program accepted it, so both sides hash the same bytes.
      const seed = vrfSeed(pool.pool, 1n, args.nonce, s.root, s.total);
      expect(Buffer.from(epoch.vrfSeed)).toEqual(Buffer.from(seed));
      expect(randomnessPda(Uint8Array.from(epoch.vrfSeed))).toEqual(randomnessPda(seed));
    },
    TIMEOUT,
  );

  it(
    "refuses a randomness account computed without the root",
    async () => {
      const pool = await openPool();
      const s = snapshotOf(fillers(3));
      await retryUntilOk(() => beginEpoch(pool, 1n));
      const withoutRoot = vrfSeed(pool.pool, 1n, testNonce(), Buffer.alloc(32), s.total);
      await expect(
        requestDrawMethod(pool, 1n, s.held, testNonce(), randomnessPda(withoutRoot)).rpc(),
      ).rejects.toThrow(/InvalidRandomnessAccount/);
    },
    TIMEOUT,
  );
});

describe("payout verifies the winner's proof", () => {
  it.each([
    { name: "depth 1", others: 1, depth: 1 },
    { name: "depth 4", others: 10, depth: 4 },
  ])(
    "pays a valid proof at $name, from any caller, and the event names the leaf",
    async ({ others, depth }) => {
      const pool = await openPool();
      const winner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, winner, 3_000_000n);
      const owner = winner.keypair.publicKey;
      const s = snapshotOf([{ owner, tickets: 3n }, ...fillers(others, 2n)]);
      expect(s.depth).toBe(depth);
      await drawEpoch1(pool, s, owner);

      const before = await fetchPlayer(pool, owner);
      const stranger = await pool.fundedWallet(0n);
      const proof = proofFor(s, owner);
      const sig = await payoutRaw(pool, 1n, owner, proof, stranger.keypair).rpc();

      const after = await fetchPlayer(pool, owner);
      expect(big(after.principal) - big(before.principal)).toBe(PRIZE);
      const epoch = await fetchEpoch(pool, 1n);
      expect(epoch.status).toBe(epoch_status.PAID);
      expect(epoch.winner.toBase58()).toBe(owner.toBase58());
      const event = await findEvent<{ index: number; tickets: BN }>(sig, "jackpotPaid");
      expect(event?.index).toBe(proof.index);
      expect(big(event!.tickets)).toBe(3n);
      await assertSolvent(pool);
    },
    TIMEOUT,
  );

  it(
    "refuses a wrong-length proof, a tampered one, another wallet's, a range that misses the target and a zero-Ticket leaf, and moves nothing",
    async () => {
      const pool = await openPool();
      const [a, b] = [await pool.fundedWallet(10_000_000n), await pool.fundedWallet(10_000_000n)];
      await deposit(pool, a, 3_000_000n);
      await deposit(pool, b, 3_000_000n);
      const [ka, kb] = [a.keypair.publicKey, b.keypair.publicKey];
      const s = snapshotOf([
        { owner: ka, tickets: 3n },
        { owner: kb, tickets: 3n },
        ...fillers(9, 2n),
      ]);
      expect(s.depth).toBe(4);
      await drawEpoch1(pool, s, ka);

      const good = proofFor(s, ka);
      const flipped = good.siblings.map((x, i) =>
        i === 1 ? { ...x, hash: Buffer.from(x.hash).fill(0xab) } : x,
      );
      const pay = (winner: PublicKey, proof: typeof good) => () => payoutRaw(pool, 1n, winner, proof).rpc();
      const attempts: [string, () => Promise<string>, RegExp][] = [
        ["short proof", pay(ka, { ...good, siblings: good.siblings.slice(1) }), /ProofWrongLength/],
        ["long proof", pay(ka, { ...good, siblings: [...good.siblings, good.siblings[0]!] }), /ProofWrongLength/],
        ["tampered sibling", pay(ka, { ...good, siblings: flipped }), /ProofRootMismatch/],
        ["wrong ticket count", pay(ka, { ...good, tickets: 4n }), /ProofRootMismatch/],
        ["a's proof for b's account", pay(kb, good), /ProofRootMismatch/],
        ["index alias past the leaf count", pay(ka, { ...good, index: good.index + 16 }), /ProofIndexOutOfRange/],
        // b's proof is valid, but the target is in a's range.
        ["range misses the target", pay(kb, proofFor(s, kb)), /ProofRangeMismatch/],
        ["zero-Ticket leaf", pay(ka, { ...good, tickets: 0n }), /ZeroTicketLeaf/],
      ];
      for (const [name, attempt, error] of attempts) {
        await expect(attempt(), name).rejects.toThrow(error);
      }

      const epoch = await fetchEpoch(pool, 1n);
      expect(epoch.status).toBe(epoch_status.DRAWN);
      expect(await vaultAmount(pool.jackpotVault)).toBe(PRIZE);
      expect(big((await fetchPlayer(pool, ka)).principal)).toBe(3_000_000n);
      expect(big((await fetchPlayer(pool, kb)).principal)).toBe(3_000_000n);

      await payoutRaw(pool, 1n, ka, good).rpc();
      expect(big((await fetchPlayer(pool, ka)).principal)).toBe(3_000_000n + PRIZE);
    },
    TIMEOUT,
  );

  it(
    "refuses a proof whose sums miss the committed total",
    async () => {
      const pool = await openPool();
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const owner = a.keypair.publicKey;
      const s = snapshotOf([{ owner, tickets: 3n }, ...fillers(1, 2n)]);
      // The Operator commits a total one over the tree's. The proof reaches the
      // root, but its sums reach only the tree's own total.
      await drawEpoch1(pool, s, owner, argsOf(s, { total: s.total + 1n }));

      await expect(payoutRaw(pool, 1n, owner, proofFor(s, owner)).rpc()).rejects.toThrow(
        /ProofSumMismatch/,
      );
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWN);
      expect(await vaultAmount(pool.jackpotVault)).toBe(PRIZE);
    },
    TIMEOUT,
  );

  it(
    "pays a depth-18 proof in one transaction against a kVault-sized account list, and logs its size",
    async () => {
      const pool = await openPool();
      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const owner = a.keypair.publicKey;
      // 200,000 other wallets, more than 2^17, so the tree is 18 deep.
      const s = snapshotOf([{ owner, tickets: 1_000n }, ...fillers(200_000)]);
      expect([s.depth, s.leafCount]).toEqual([18, 200_001]);
      await drawEpoch1(pool, s, owner);
      const proof = proofFor(s, owner);
      expect(proof.siblings).toHaveLength(18);

      // The localnet venue is the stub, which reads no remaining accounts.
      // A kVault pool passes four pins (two more unique keys than the stub's)
      // and, for the RockawayX vault (six reserves), a klend program, six
      // reserves and six markets: 15 more unique keys, none of them the
      // pool's, so the message is as large as the real one.
      const kvaultExtras: AccountMeta[] = Array.from({ length: 15 }, (_, i) => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: i >= 1 && i <= 6,
      }));
      const caller = pool.operator;
      const blockhash = (await connection.getLatestBlockhash()).blockhash;

      // One signature: the cranking Operator is also the fee payer.
      const legacySize = async (remaining: AccountMeta[]) => {
        const tx = await payoutRaw(pool, 1n, owner, proof, caller, remaining).transaction();
        tx.feePayer = caller.publicKey;
        tx.recentBlockhash = blockhash;
        return 1 + 64 + tx.compileMessage().serialize().length;
      };
      const plain = await legacySize([]);
      const legacy = await legacySize(kvaultExtras);

      // Spec fallback 1: an address lookup table for the fixed accounts.
      const fixed = [
        pool.pool,
        pool.mint,
        pool.jackpotVault,
        pool.principalVault,
        pool.treasury,
        pool.buybackReserve,
        pool.venue.klendProgram,
        pool.venue.klendMarket,
        pool.venue.klendReserve,
        pool.venue.klendCtoken,
        TOKEN_PROGRAM_ID,
        ...kvaultExtras.map((m) => m.pubkey),
      ];
      // A finalized slot: the table needs a slot already in the SlotHashes sysvar.
      const slot = await connection.getSlot("finalized");
      const [createIx, table] = AddressLookupTableProgram.createLookupTable({
        authority: caller.publicKey,
        payer: caller.publicKey,
        recentSlot: slot,
      });
      const setup = new TransactionMessage({
        payerKey: caller.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          createIx,
          AddressLookupTableProgram.extendLookupTable({
            lookupTable: table,
            authority: caller.publicKey,
            payer: caller.publicKey,
            addresses: fixed,
          }),
        ],
      }).compileToV0Message();
      const setupTx = new VersionedTransaction(setup);
      setupTx.sign([caller]);
      await connection.confirmTransaction(await connection.sendTransaction(setupTx), "confirmed");
      // A table's addresses are usable from the slot after they were added.
      const lookup = await retryUntilOk(async () => {
        const got = (await connection.getAddressLookupTable(table)).value;
        if (!got || got.state.addresses.length < fixed.length) throw new Error("table not ready");
        return got;
      });
      await sleep(1_500);

      const ix = await payoutRaw(pool, 1n, owner, proof, caller, kvaultExtras).instruction();
      const message = new TransactionMessage({
        payerKey: caller.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ix],
      }).compileToV0Message([lookup]);
      const tx = new VersionedTransaction(message);
      tx.sign([caller]);
      const tableSize = tx.serialize().length;

      console.log(
        `payout depth 18: legacy ${plain} B on the stub's accounts, ${legacy} B against a kVault-sized list; with a lookup table ${tableSize} B (packet ${PACKET})`,
      );
      expect(tableSize).toBeLessThanOrEqual(PACKET);

      const before = await fetchPlayer(pool, owner);
      const sig = await retryUntilOk(() => connection.sendTransaction(tx));
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`payout depth 18: ${(await txInfo(sig)).units} compute units`);

      const after = await fetchPlayer(pool, owner);
      expect(big(after.principal) - big(before.principal)).toBe(PRIZE);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.PAID);
      const event = await findEvent<{ index: number; tickets: BN }>(sig, "jackpotPaid");
      expect(event?.index).toBe(proof.index);
      expect(big(event!.tickets)).toBe(1_000n);
    },
    300_000,
  );
});
