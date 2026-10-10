// migrate_venue (venue-switch ticket 05): once the lock has elapsed and the old
// position is down to dust, the pool is repinned to the proposed venue. The
// rehearsal runs stub to stub: the second stub has its own reserve and vault.
//
// A localnet clock cannot be warped, so `test_backdate_proposal` moves the
// proposal's start back 48 hours instead.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  assertSolvent,
  deployMethod,
  drainVenueMethod,
  findEvent,
  migrateVenueMethod,
  playerPda,
  program,
  provider,
  setVenueParamsMethod,
  setupPool,
  stubVenueValue,
  testVenueAltAccountsFor,
  VENUE_KIND,
  venueProposalPda,
  waitPastLastSync,
  type PoolCtx,
  type VenueAccounts,
} from "./helpers/hx.js";

const TIMEOUT = 120_000;
const USDC = 1_000_000n;
const LOCK_SECONDS = 48 * 60 * 60;

interface Depositor {
  keypair: Keypair;
  tokenAccount: PublicKey;
}

async function deposit(ctx: PoolCtx, who: Depositor, amount: bigint) {
  await program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner: who.keypair.publicKey,
      pool: ctx.pool,
      player: playerPda(ctx.pool, who.keypair.publicKey),
      acceptedMint: ctx.mint,
      ownerToken: who.tokenAccount,
      principalVault: ctx.principalVault,
      ...ctx.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([who.keypair])
    .rpc();
}

const principalOf = async (ctx: PoolCtx, who: Depositor) =>
  (await program.account.player.fetch(playerPda(ctx.pool, who.keypair.publicKey))).principal.toString();

/** A pool with two depositors, 4,000 USDC at the first stub venue, and a
 *  second stub venue created beside it. */
async function rehearsalPool() {
  const ctx = await setupPool();
  const alice = await ctx.fundedWallet(6_000n * USDC);
  const bob = await ctx.fundedWallet(4_000n * USDC);
  await deposit(ctx, alice, 6_000n * USDC);
  await deposit(ctx, bob, 4_000n * USDC);
  await deployMethod(ctx, 4_000n * USDC).rpc();

  const next = testVenueAltAccountsFor(ctx.pool, ctx.mint);
  await program.methods
    .testVenueInitAlt()
    .accountsPartial({
      payer: ctx.operator.publicKey,
      pool: ctx.pool,
      acceptedMint: ctx.mint,
      reserve: next.klendReserve,
      venueVault: next.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([ctx.operator])
    .rpc();
  await assertSolvent(ctx);
  return { ctx, alice, bob, next };
}

const propose = (ctx: PoolCtx, next: VenueAccounts, venueKind: number = VENUE_KIND.stub) =>
  program.methods
    .proposeVenue({ venueKind, ...next })
    .accountsPartial({
      admin: ctx.admin.publicKey,
      pool: ctx.pool,
      proposal: venueProposalPda(ctx.pool),
    })
    .signers([ctx.admin])
    .rpc();

const backdate = (ctx: PoolCtx, seconds = LOCK_SECONDS) =>
  program.methods
    .testBackdateProposal(new BN(seconds))
    .accountsPartial({ pool: ctx.pool, proposal: venueProposalPda(ctx.pool) })
    .rpc();

const proposalExists = async (ctx: PoolCtx) =>
  (await provider.connection.getAccountInfo(venueProposalPda(ctx.pool))) !== null;

/** `ctx` as it reads once the pool is on `venue`: the solvency helper and the
 *  builders default to `ctx.venue`. */
const onVenue = (ctx: PoolCtx, venue: VenueAccounts): PoolCtx => ({ ...ctx, venue });

describe("migrate_venue", () => {
  it(
    "stub to stub: propose, drain in two steps, migrate, deploy to the new venue, every Principal unchanged",
    async () => {
      const { ctx, alice, bob, next } = await rehearsalPool();
      const before = [await principalOf(ctx, alice), await principalOf(ctx, bob)];
      const unchanged = async (at: PoolCtx) => {
        expect([await principalOf(at, alice), await principalOf(at, bob)]).toEqual(before);
        await assertSolvent(at);
      };

      await propose(ctx, next);
      await unchanged(ctx);

      // Deploys are refused while the proposal stands, migration while it is locked.
      await waitPastLastSync(ctx);
      await expect(deployMethod(ctx, 1_000n * USDC).rpc()).rejects.toThrow(/VenueProposalOpen/);
      await expect(migrateVenueMethod(ctx).rpc()).rejects.toThrow(/VenueLockNotElapsed/);
      await unchanged(ctx);

      await backdate(ctx);
      // Still holding 4,000: above the 100 USDC dust line.
      await expect(migrateVenueMethod(ctx).rpc()).rejects.toThrow(/VenuePositionNotEmpty/);

      // Two drain steps, by anyone, since the proposal is open.
      const stranger = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(stranger.publicKey, 1_000_000_000),
      );
      await drainVenueMethod(ctx, 2_500n * USDC, stranger).rpc();
      await unchanged(ctx);
      await expect(migrateVenueMethod(ctx).rpc()).rejects.toThrow(/VenuePositionNotEmpty/);
      await drainVenueMethod(ctx, 1_500n * USDC, stranger).rpc();
      await unchanged(ctx);
      expect(await stubVenueValue(ctx)).toBe(0n);

      const adminBefore = await provider.connection.getBalance(ctx.admin.publicKey);
      const rent = (await provider.connection.getAccountInfo(venueProposalPda(ctx.pool)))!.lamports;
      const oldPins = await program.account.pool.fetch(ctx.pool);
      const signature = await migrateVenueMethod(ctx).rpc();

      // Pins and kind now equal the proposal's; the value is zero; the proposal is gone.
      const pool = await program.account.pool.fetch(ctx.pool);
      expect(pool.venueKind).toBe(VENUE_KIND.stub);
      for (const key of Object.keys(next) as (keyof VenueAccounts)[]) {
        expect(pool[key].toBase58()).toBe(next[key].toBase58());
      }
      expect(pool.venueValue.toString()).toBe("0");
      expect(await proposalExists(ctx)).toBe(false);
      // The rent went to the Admin, who did not sign or pay the fee.
      expect((await provider.connection.getBalance(ctx.admin.publicKey)) - adminBefore).toBe(rent);

      const event = await findEvent<{
        oldVenueKind: number;
        oldKlendReserve: PublicKey;
        oldKlendCtoken: PublicKey;
        newVenueKind: number;
        newKlendMarket: PublicKey;
        newKlendReserve: PublicKey;
        newKlendCtoken: PublicKey;
        leftBehind: BN;
      }>(signature, "venueMigrated");
      expect(event?.oldVenueKind).toBe(VENUE_KIND.stub);
      expect(event?.oldKlendReserve.toBase58()).toBe(oldPins.klendReserve.toBase58());
      expect(event?.oldKlendCtoken.toBase58()).toBe(oldPins.klendCtoken.toBase58());
      expect(event?.newVenueKind).toBe(VENUE_KIND.stub);
      expect(event?.newKlendMarket.toBase58()).toBe(next.klendMarket.toBase58());
      expect(event?.newKlendReserve.toBase58()).toBe(next.klendReserve.toBase58());
      expect(event?.newKlendCtoken.toBase58()).toBe(next.klendCtoken.toBase58());
      expect(event?.leftBehind.toString()).toBe("0");

      const after = onVenue(ctx, next);
      await unchanged(after);

      // The old venue is no longer accepted; deploys go to the new one.
      await waitPastLastSync(ctx);
      await expect(deployMethod(ctx, 1_000n * USDC, ctx.venue).rpc()).rejects.toThrow(
        /VenueMismatch/,
      );
      await deployMethod(after, 3_000n * USDC).rpc();
      expect(await stubVenueValue(after)).toBe(3_000n * USDC);
      expect(await stubVenueValue(ctx)).toBe(0n);
      await unchanged(after);

      // A migration needs a proposal: a second one has nothing to execute.
      await expect(migrateVenueMethod(after, next).rpc()).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "accepts a position at or under min_venue_move, reports it as left behind and leaves the old venue untouched",
    async () => {
      const { ctx, next } = await rehearsalPool();
      await propose(ctx, next);
      await backdate(ctx);
      // 4,000 held; drain all but 30 USDC.
      await drainVenueMethod(ctx, 3_970n * USDC).rpc();

      const signature = await migrateVenueMethod(ctx).rpc();
      const event = await findEvent<{ leftBehind: BN }>(signature, "venueMigrated");
      expect(event?.leftBehind.toString()).toBe((30n * USDC).toString());
      expect((await program.account.pool.fetch(ctx.pool)).venueValue.toString()).toBe("0");
      // Nothing moved and nothing was written off: the 30 USDC still sit in the
      // old stub, outside the pool's books, so the books are short by exactly that.
      expect(await stubVenueValue(ctx)).toBe(30n * USDC);
      await assertSolvent(onVenue(ctx, next), 30n * USDC);
    },
    TIMEOUT,
  );

  it(
    "the dust line is min_venue_move: a position just over it is refused",
    async () => {
      const { ctx, next } = await rehearsalPool();
      await setVenueParamsMethod(ctx, { minVenueMove: 10n * USDC }).rpc();
      await propose(ctx, next);
      await backdate(ctx);
      await drainVenueMethod(ctx, 3_989n * USDC).rpc();
      await expect(migrateVenueMethod(ctx).rpc()).rejects.toThrow(/VenuePositionNotEmpty/);
      await drainVenueMethod(ctx, 1n * USDC).rpc();
      await migrateVenueMethod(ctx).rpc();
      expect(await proposalExists(ctx)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "refuses the new venue's accounts at the migration, and a cancelled proposal cannot be executed",
    async () => {
      const { ctx, next } = await rehearsalPool();
      await propose(ctx, next);
      await backdate(ctx);
      await drainVenueMethod(ctx, 4_000n * USDC).rpc();
      // The sync inside the migration reads the venue the pool is pinned to.
      await expect(migrateVenueMethod(ctx, next).rpc()).rejects.toThrow(/VenueMismatch/);

      await program.methods
        .cancelVenue()
        .accountsPartial({
          admin: ctx.admin.publicKey,
          pool: ctx.pool,
          proposal: venueProposalPda(ctx.pool),
        })
        .signers([ctx.admin])
        .rpc();
      await expect(migrateVenueMethod(ctx).rpc()).rejects.toThrow();
      expect((await program.account.pool.fetch(ctx.pool)).klendReserve.toBase58()).toBe(
        ctx.venue.klendReserve.toBase58(),
      );
    },
    TIMEOUT,
  );
});
