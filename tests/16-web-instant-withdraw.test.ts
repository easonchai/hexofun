// Yield-claimer ticket 16: the transactions apps/web builds, sent to a local
// validator. The web actions run unchanged (apps/web/src/actions.ts), against
// the web's own bundled IDL and a Program pointed at the deployed id, so a
// stale account list or a missing tree or klend account fails here.
//
// The web reads VITE_PROGRAM_ID once, at import, so this file sets it to the
// deployed id and imports the web modules afterwards.

import { describe, expect, it } from "vitest";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import type { Keypair } from "@solana/web3.js";

import type { HexVaultProgram } from "../apps/web/src/chain.js";
import type { PoolLike } from "../apps/web/src/read.js";
import {
  assertSolvent,
  deployToVenue,
  grantTicketsAsAdmin,
  PROGRAM_ID,
  program,
  provider,
  setupPool,
  setVenueRate,
  waitPastLastSync,
  playerPda,
  type PoolCtx,
} from "./helpers/hx.js";

// SAFETY: vitest's import.meta.env is a plain mutable object.
(import.meta.env as Record<string, string>).VITE_PROGRAM_ID = PROGRAM_ID.toBase58();
const {
  deposit: webDeposit,
  instantWithdraw: webInstantWithdraw,
  requestWithdraw: webRequestWithdraw,
} = await import("../apps/web/src/actions.js");
const { PROGRAM_ID: WEB_PROGRAM_ID } = await import("../apps/web/src/chain.js");
const { idl: webIdl } = await import("../apps/web/src/idl.js");
// The web resolves its own copy of web3.js; `Connection.simulateTransaction`
// checks `instanceof Transaction`, so the web's Program needs the web's copy.
const { Connection: WebConnection } = await import("../apps/web/node_modules/@solana/web3.js");

const TIMEOUT = 120_000;
const USDC = 1_000_000n;
const SCALE = 10n ** 18n;

const balance = async (account: import("@solana/web3.js").PublicKey): Promise<bigint> =>
  BigInt((await provider.connection.getTokenAccountBalance(account)).value.amount);

const poolLike = (ctx: PoolCtx): PoolLike => ({
  address: ctx.pool,
  acceptedMint: ctx.mint,
  closeBuffer: 15n,
  minDeposit: ctx.minDeposit,
  houseCutBps: ctx.houseCutBps,
  paused: false,
  epochSeconds: BigInt(ctx.epochSeconds),
  baseRateBps: ctx.baseRateBps,
  ticketsPerUsdc: ctx.ticketsPerUsdc,
  priorityFeeMicroLamports: 1_000,
  weightTree: ctx.weightTree,
  klendProgram: ctx.venue.klendProgram,
  klendMarket: ctx.venue.klendMarket,
  klendReserve: ctx.venue.klendReserve,
  klendCtoken: ctx.venue.klendCtoken,
});

/** The web's own Program for one wallet: its bundled IDL at the deployed id. */
const webProgram = (keypair: Keypair): HexVaultProgram =>
  new Program(
    { ...webIdl, address: PROGRAM_ID.toBase58() },
    new AnchorProvider(new WebConnection(provider.connection.rpcEndpoint, "confirmed"), new Wallet(keypair), { commitment: "confirmed" }),
  ) as unknown as HexVaultProgram;

describe("web transactions on a local validator", () => {
  it("web and test agree on the program id", () => {
    expect(WEB_PROGRAM_ID.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  it(
    "deposit, then instant withdraw from free idle and with a redeem, in one transaction each",
    async () => {
      const ctx = await setupPool();
      const owner = await ctx.fundedWallet(1_000n * USDC);
      const web = webProgram(owner.keypair);
      const signer = { publicKey: owner.keypair.publicKey };
      const pool = poolLike(ctx);

      expect(await webDeposit(web, signer, pool, 1_000n * USDC)).toMatchObject({ kind: "landed" });
      // The deposit holds no Ticket until the next epoch (ADR 0020), and an
      // instant withdraw needs Tickets of at least the amount.
      await grantTicketsAsAdmin(ctx, owner.keypair.publicKey, 1_000n * USDC);
      await waitPastLastSync(ctx);
      await deployToVenue(ctx, 900n * USDC);
      expect(await balance(ctx.principalVault)).toBe(100n * USDC);

      // Free idle only.
      const before = await balance(owner.tokenAccount);
      expect(await webInstantWithdraw(web, signer, pool, 60n * USDC)).toMatchObject({ kind: "landed" });
      expect((await balance(owner.tokenAccount)) - before).toBe(60n * USDC);
      await assertSolvent(ctx);

      // 40 idle left; 200 needs a 160 redeem from the venue.
      const mid = await balance(owner.tokenAccount);
      expect(await webInstantWithdraw(web, signer, pool, 200n * USDC)).toMatchObject({ kind: "landed" });
      expect((await balance(owner.tokenAccount)) - mid).toBe(200n * USDC);
      await assertSolvent(ctx);

      const player = await program.account.player.fetch(playerPda(ctx.pool, owner.keypair.publicKey));
      // Yield settled at each call joins Principal, so a few units above 740.
      expect(BigInt(player.principal.toString())).toBeGreaterThanOrEqual(740n * USDC);
      expect(BigInt(player.principal.toString())).toBeLessThan(741n * USDC);
    },
    TIMEOUT,
  );

  it(
    "an illiquid venue fails with the named code and the queued request still works",
    async () => {
      const ctx = await setupPool({ baseRateBps: 10_000 });
      const owner = await ctx.fundedWallet(1_000n * USDC);
      const web = webProgram(owner.keypair);
      const signer = { publicKey: owner.keypair.publicKey };
      const pool = poolLike(ctx);
      expect(await webDeposit(web, signer, pool, 1_000n * USDC)).toMatchObject({ kind: "landed" });
      await grantTicketsAsAdmin(ctx, owner.keypair.publicKey, 1_000n * USDC);
      await waitPastLastSync(ctx);
      await deployToVenue(ctx, 900n * USDC);
      // The venue triples on paper but its USDC stays at 900.
      await setVenueRate(ctx, 3n * SCALE).rpc();
      await waitPastLastSync(ctx);

      const before = await balance(owner.tokenAccount);
      const refused = await webInstantWithdraw(web, signer, pool, 1_000n * USDC + 1n);
      // 6063 VenueIlliquid, caught by the web's simulation before anything is signed.
      expect(refused).toMatchObject({ kind: "failed", code: 6063 });
      expect(await balance(owner.tokenAccount)).toBe(before);

      expect(await webRequestWithdraw(web, signer, pool, 400n * USDC)).toMatchObject({ kind: "landed" });
      const state = await program.account.pool.fetch(ctx.pool);
      expect(BigInt(state.pendingWithdrawals.toString())).toBe(400n * USDC);
      await assertSolvent(ctx);
    },
    TIMEOUT,
  );
});
