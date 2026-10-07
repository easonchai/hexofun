// Propose and cancel a venue (venue-switch ticket 03). The proposal is a PDA
// from the pool; deploys are refused while it exists.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  assertSolvent,
  deployToVenue,
  findEvent,
  playerPda,
  program,
  provider,
  setupPool,
  venueProposalPda,
  waitPastLastSync,
  VENUE_KIND,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;
const USDC = 1_000_000n;
const LOCK_SECONDS = 48 * 60 * 60;

// A klend-kind proposal must pin the real klend program (ticket 04).
const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const target = () => ({
  klendProgram: KLEND_PROGRAM,
  klendMarket: Keypair.generate().publicKey,
  klendReserve: Keypair.generate().publicKey,
  klendCtoken: Keypair.generate().publicKey,
});

function propose(
  ctx: PoolCtx,
  pins = target(),
  venueKind: number = VENUE_KIND.klend,
  signer: Keypair = ctx.admin,
) {
  return program.methods
    .proposeVenue({ venueKind, ...pins })
    .accountsPartial({
      admin: signer.publicKey,
      pool: ctx.pool,
      proposal: venueProposalPda(ctx.pool),
    })
    .signers([signer])
    .rpc();
}

const cancel = (ctx: PoolCtx, signer: Keypair = ctx.admin) =>
  program.methods
    .cancelVenue()
    .accountsPartial({
      admin: signer.publicKey,
      pool: ctx.pool,
      proposal: venueProposalPda(ctx.pool),
    })
    .signers([signer])
    .rpc();

const fetchProposal = (ctx: PoolCtx) =>
  program.account.venueProposal.fetch(venueProposalPda(ctx.pool));

const exists = async (ctx: PoolCtx) =>
  (await provider.connection.getAccountInfo(venueProposalPda(ctx.pool))) !== null;

async function fundedPool() {
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
  return ctx;
}

describe("propose_venue and cancel_venue", () => {
  it(
    "the Admin's proposal stores the kind, the four pins and the time, and emits the whole proposal",
    async () => {
      const ctx = await setupPool();
      const pins = target();
      const signature = await propose(ctx, pins);

      const stored = await fetchProposal(ctx);
      expect(stored.pool.toBase58()).toBe(ctx.pool.toBase58());
      expect(stored.venueKind).toBe(VENUE_KIND.klend);
      for (const key of Object.keys(pins) as (keyof typeof pins)[]) {
        expect(stored[key].toBase58()).toBe(pins[key].toBase58());
      }
      expect(stored.proposedAt.toNumber()).toBeGreaterThan(0);

      const event = await findEvent<{
        pool: PublicKey;
        venueKind: number;
        klendReserve: PublicKey;
        proposedAt: BN;
        unlocksAt: BN;
      }>(signature, "venueProposed");
      expect(event?.pool.toBase58()).toBe(ctx.pool.toBase58());
      expect(event?.venueKind).toBe(VENUE_KIND.klend);
      expect(event?.klendReserve.toBase58()).toBe(pins.klendReserve.toBase58());
      expect(event?.proposedAt.toNumber()).toBe(stored.proposedAt.toNumber());
      expect(event!.unlocksAt.toNumber() - event!.proposedAt.toNumber()).toBe(LOCK_SECONDS);
    },
    TIMEOUT,
  );

  it(
    "a stranger and the Operator cannot propose or cancel",
    async () => {
      const ctx = await setupPool();
      const stranger = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(stranger.publicKey, 1_000_000_000),
      );
      await expect(propose(ctx, target(), 0, stranger)).rejects.toThrow(/ConstraintHasOne/);
      await expect(propose(ctx, target(), 0, ctx.operator)).rejects.toThrow(/ConstraintHasOne/);
      expect(await exists(ctx)).toBe(false);

      await propose(ctx);
      await expect(cancel(ctx, stranger)).rejects.toThrow(/ConstraintHasOne/);
      await expect(cancel(ctx, ctx.operator)).rejects.toThrow(/ConstraintHasOne/);
      expect(await exists(ctx)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "refuses a kind the build does not support and a default pin, leaving nothing behind",
    async () => {
      const ctx = await setupPool();
      await expect(propose(ctx, target(), VENUE_KIND.unsupported)).rejects.toThrow(
        /UnsupportedVenueKind/,
      );
      await expect(
        propose(ctx, { ...target(), klendReserve: PublicKey.default }),
      ).rejects.toThrow(/InvalidParameter/);
      expect(await exists(ctx)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "refuses a klend proposal that pins a foreign program, leaving nothing behind",
    async () => {
      const ctx = await setupPool();
      const foreign = { ...target(), klendProgram: Keypair.generate().publicKey };
      await expect(propose(ctx, foreign, VENUE_KIND.klend)).rejects.toThrow(
        /KlendProgramMismatch/,
      );
      expect(await exists(ctx)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "refuses an epoch_seconds above seven days in set_params",
    async () => {
      const ctx = await setupPool();
      await expect(
        program.methods
          .setParams({
            epochSeconds: new BN(7 * 86_400 + 1),
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
          .accountsPartial({ admin: ctx.admin.publicKey, pool: ctx.pool })
          .signers([ctx.admin])
          .rpc(),
      ).rejects.toThrow(/InvalidParameter/);
    },
    TIMEOUT,
  );

  it(
    "a second proposal replaces the first and restarts the lock",
    async () => {
      const ctx = await setupPool();
      await propose(ctx, target(), VENUE_KIND.stub);
      const first = await fetchProposal(ctx);
      await new Promise((r) => setTimeout(r, 1500));

      const second = target();
      await propose(ctx, second, VENUE_KIND.klend);
      const replaced = await fetchProposal(ctx);
      expect(replaced.venueKind).toBe(VENUE_KIND.klend);
      expect(replaced.klendReserve.toBase58()).toBe(second.klendReserve.toBase58());
      expect(replaced.proposedAt.toNumber()).toBeGreaterThan(first.proposedAt.toNumber());
    },
    TIMEOUT,
  );

  it(
    "cancel closes the proposal, returns the rent to the Admin and emits what it withdrew",
    async () => {
      const ctx = await setupPool();
      const pins = target();
      await propose(ctx, pins);
      const rent = (await provider.connection.getAccountInfo(venueProposalPda(ctx.pool)))!
        .lamports;
      const before = await provider.connection.getBalance(ctx.admin.publicKey);

      const signature = await cancel(ctx);
      expect(await exists(ctx)).toBe(false);
      const after = await provider.connection.getBalance(ctx.admin.publicKey);
      // The admin is also the fee payer, so the rent comes back less the fee.
      expect(after - before).toBeGreaterThan(rent - 100_000);
      const event = await findEvent<{ klendMarket: PublicKey }>(signature, "venueProposalCancelled");
      expect(event?.klendMarket.toBase58()).toBe(pins.klendMarket.toBase58());

      await expect(cancel(ctx)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "deploy fails with VenueProposalOpen while a proposal exists and works again after cancel",
    async () => {
      const ctx = await fundedPool();
      await propose(ctx);
      await waitPastLastSync(ctx);
      await expect(deployToVenue(ctx, 1_000n * USDC)).rejects.toThrow(/VenueProposalOpen/);

      await cancel(ctx);
      await waitPastLastSync(ctx);
      await deployToVenue(ctx, 1_000n * USDC);
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );
});
