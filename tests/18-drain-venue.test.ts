// drain_venue (venue-switch ticket 04): brings the position home to the
// principal vault in steps. The Admin and the Operator may drain any time,
// anyone while a proposal is open.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  airdrop,
  assertSolvent,
  deployToVenue,
  drainVenueMethod,
  findEvent,
  playerPda,
  program,
  provider,
  setVenueRate,
  setupPool,
  stubVenueValue,
  venueProposalPda,
  waitPastLastSync,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;
const USDC = 1_000_000n;

const vaultBalance = async (ctx: PoolCtx) =>
  BigInt((await provider.connection.getTokenAccountBalance(ctx.principalVault)).value.amount);

async function deployedPool() {
  const ctx = await setupPool();
  const owner = await ctx.fundedWallet(10_000n * USDC);
  await program.methods
    .deposit(new BN((10_000n * USDC).toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, owner.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: owner.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
  await deployToVenue(ctx, 4_000n * USDC);
  await assertSolvent(ctx);
  return ctx;
}

const propose = (ctx: PoolCtx) =>
  program.methods
    .proposeVenue({
      venueKind: 1,
      klendProgram: Keypair.generate().publicKey,
      klendMarket: Keypair.generate().publicKey,
      klendReserve: Keypair.generate().publicKey,
      klendCtoken: Keypair.generate().publicKey,
    })
    .accountsPartial({
      admin: ctx.admin.publicKey,
      pool: ctx.pool,
      proposal: venueProposalPda(ctx.pool),
    })
    .signers([ctx.admin])
    .rpc();

describe("drain_venue", () => {
  it(
    "a partial drain by the Admin moves USDC home, lowers the venue value by what came back and emits asked and received",
    async () => {
      const ctx = await deployedPool();
      const vaultBefore = await vaultBalance(ctx);
      const poolBefore = await program.account.pool.fetch(ctx.pool);

      const signature = await drainVenueMethod(ctx, 1_500n * USDC).rpc();

      const poolAfter = await program.account.pool.fetch(ctx.pool);
      expect((await vaultBalance(ctx)) - vaultBefore).toBe(1_500n * USDC);
      expect(BigInt(poolBefore.venueValue.toString()) - BigInt(poolAfter.venueValue.toString())).toBe(
        1_500n * USDC,
      );
      expect(BigInt(poolAfter.venueValue.toString())).toBe(await stubVenueValue(ctx));
      expect(poolAfter.totalPrincipal.toString()).toBe(poolBefore.totalPrincipal.toString());
      const event = await findEvent<{ asked: BN; received: BN; venueValue: BN }>(
        signature,
        "venueDrained",
      );
      expect(event?.asked.toString()).toBe((1_500n * USDC).toString());
      expect(event?.received.toString()).toBe((1_500n * USDC).toString());
      expect(event?.venueValue.toString()).toBe(poolAfter.venueValue.toString());
      await assertSolvent(ctx);

      // A second step brings the rest home.
      await drainVenueMethod(ctx, 2_500n * USDC).rpc();
      expect(await stubVenueValue(ctx)).toBe(0n);
      expect((await program.account.pool.fetch(ctx.pool)).venueValue.toString()).toBe("0");
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "syncs first, so a gain is booked and not lost to the drain",
    async () => {
      const ctx = await deployedPool();
      await setVenueRate(ctx, 1_100_000_000_000_000_000n).rpc();
      await waitPastLastSync(ctx);
      const before = await program.account.pool.fetch(ctx.pool);

      await drainVenueMethod(ctx, 1_000n * USDC).rpc();

      const after = await program.account.pool.fetch(ctx.pool);
      // The 10% gain on 4,000 USDC was booked by the sync inside the drain.
      expect(BigInt(after.yieldIndex.toString())).toBeGreaterThan(BigInt(before.yieldIndex.toString()));
      expect(BigInt(after.venueValue.toString())).toBe(await stubVenueValue(ctx));
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "the Operator may drain with no proposal",
    async () => {
      const ctx = await deployedPool();
      await drainVenueMethod(ctx, 500n * USDC, ctx.operator).rpc();
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "a stranger is refused without a proposal and accepted while one is open",
    async () => {
      const ctx = await deployedPool();
      const stranger = Keypair.generate();
      await airdrop(stranger.publicKey, 1);

      await expect(drainVenueMethod(ctx, 500n * USDC, stranger).rpc()).rejects.toThrow(
        /Unauthorized/,
      );
      expect(await stubVenueValue(ctx)).toBe(4_000n * USDC);

      await propose(ctx);
      await waitPastLastSync(ctx);
      await drainVenueMethod(ctx, 500n * USDC, stranger).rpc();
      expect(await stubVenueValue(ctx)).toBe(3_500n * USDC);
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "a drain larger than the venue holds fails with VenueIlliquid and moves nothing",
    async () => {
      const ctx = await deployedPool();
      const vaultBefore = await vaultBalance(ctx);
      const poolBefore = await program.account.pool.fetch(ctx.pool);

      await expect(drainVenueMethod(ctx, 4_001n * USDC).rpc()).rejects.toThrow(/VenueIlliquid/);
      await expect(drainVenueMethod(ctx, 0n).rpc()).rejects.toThrow(/ZeroAmount/);

      expect(await vaultBalance(ctx)).toBe(vaultBefore);
      expect(await stubVenueValue(ctx)).toBe(4_000n * USDC);
      const poolAfter = await program.account.pool.fetch(ctx.pool);
      expect(poolAfter.venueValue.toString()).toBe(poolBefore.venueValue.toString());
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );

  it(
    "refuses a venue other than the pinned one",
    async () => {
      const ctx = await deployedPool();
      const wrong = { ...ctx.venue, klendReserve: PublicKey.unique() };
      await expect(drainVenueMethod(ctx, 500n * USDC, ctx.admin, wrong).rpc()).rejects.toThrow(
        /VenueMismatch/,
      );
    },
    TIMEOUT,
  );
});
