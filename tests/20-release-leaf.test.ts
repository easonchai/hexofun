// release_leaf (mainnet-readiness-fixes ticket 08): a Player with nothing in the
// Weight tree gives its leaf back, and the next first deposit reuses it instead
// of growing the account. The attack this closes fills the tree with 1 USDC
// deposits from fresh wallets and refunds them in the same epoch.
//
// Deposits and refunds happen in epoch 0, where a deposit is a Pending deposit
// that `request_withdraw` refunds at once, so no epoch has to roll over.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  fetchTree,
  playerPda,
  program,
  provider,
  refundAccounts,
  setupPool,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 240_000;
const M = 1_000_000n;

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

const bn = (n: bigint) => new BN(n.toString());
const fetchPlayer = (pool: PoolCtx, owner: { publicKey: PublicKey }) =>
  program.account.player.fetch(playerPda(pool.pool, owner.publicKey));

function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .deposit(bn(amount))
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

function refund(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(bn(amount))
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

/** Anyone can release; the operator key pays here. */
function release(pool: PoolCtx, owner: { publicKey: PublicKey }) {
  return program.methods
    .releaseLeaf()
    .accountsPartial({
      payer: pool.operator.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.publicKey),
    })
    .signers([pool.operator])
    .rpc();
}

/** The free-leaves account: `count` at byte 8, indices from byte 48. */
async function freeLeaves(pool: PoolCtx): Promise<{ count: number; len: number; leaves: number[] }> {
  const address = PublicKey.findProgramAddressSync([Buffer.from("free_leaves"), pool.pool.toBuffer()], program.programId)[0];
  const info = await provider.connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error("free_leaves account is missing");
  const count = info.data.readUInt32LE(8);
  const leaves: number[] = [];
  for (let i = 0; i < count; i += 1) leaves.push(info.data.readUInt32LE(48 + 4 * i));
  return { count, len: info.data.length, leaves };
}

describe("release_leaf", () => {
  it(
    "refused while the Player holds anything, and for the House and a leafless Player",
    async () => {
      const pool = await setupPool();
      const a = await pool.fundedWallet(10n * M);
      await deposit(pool, a, 2n * M);

      await expect(release(pool, a.keypair)).rejects.toThrow(/LeafInUse/);
      await expect(release(pool, pool.operator)).rejects.toThrow(/HouseLeafCannotBeReleased/);

      // Never deposited: no leaf to give back.
      const b = await pool.fundedWallet(10n * M);
      await expect(release(pool, b.keypair)).rejects.toThrow();

      expect((await fetchPlayer(pool, a.keypair)).leafIndex).toBe(2);
      expect((await freeLeaves(pool)).count).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "fill, refund, release: new wallets deposit without growing the tree",
    async () => {
      const pool = await setupPool();
      const wallets: Wallet[] = [];
      for (let i = 0; i < 3; i += 1) wallets.push(await pool.fundedWallet(10n * M));
      for (const w of wallets) await deposit(pool, w, 2n * M);

      const filled = await fetchTree(pool);
      expect(filled.nodes.length).toBe(4); // the House and three Players
      expect((await freeLeaves(pool)).len).toBe(48);

      // Same-epoch refund empties each Player.
      for (const w of wallets) await refund(pool, w, 2n * M);
      for (const w of wallets) {
        expect((await fetchPlayer(pool, w.keypair)).principal.toString()).toBe("0");
      }

      // Anyone releases; the stack grows by one entry each time.
      for (const [i, w] of wallets.entries()) {
        await release(pool, w.keypair);
        expect((await fetchPlayer(pool, w.keypair)).leafIndex).toBe(0);
        const stack = await freeLeaves(pool);
        expect(stack.count).toBe(i + 1);
        expect(stack.len).toBe(48 + 4 * (i + 1));
      }
      expect((await freeLeaves(pool)).leaves).toEqual([2, 3, 4]);

      // New wallets take the released leaves, newest first; the tree stays put.
      const treeLen = filled.dataLen;
      const fresh: Wallet[] = [];
      for (let i = 0; i < 3; i += 1) fresh.push(await pool.fundedWallet(10n * M));
      for (const [i, w] of fresh.entries()) {
        await deposit(pool, w, 2n * M);
        expect((await fetchPlayer(pool, w.keypair)).leafIndex).toBe(4 - i);
      }
      const after = await fetchTree(pool);
      expect(after.dataLen).toBe(treeLen);
      expect(after.nodes.length).toBe(4);
      expect((await freeLeaves(pool)).count).toBe(0);

      // With the stack empty the next wallet appends again.
      const last = await pool.fundedWallet(10n * M);
      await deposit(pool, last, 2n * M);
      expect((await fetchPlayer(pool, last.keypair)).leafIndex).toBe(5);
      expect((await fetchTree(pool)).nodes.length).toBe(5);
    },
    TIMEOUT,
  );
});
