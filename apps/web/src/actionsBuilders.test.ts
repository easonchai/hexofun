/**
 * Yield-claimer ticket 16: every Player instruction the web builds, against
 * the real IDL. Anchor refuses a builder whose named accounts do not match the
 * IDL, so a stale account list fails here instead of on chain. Network is
 * stubbed at the provider, as in `actions.test.ts`.
 */
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  buyPosition,
  buyTickets,
  deposit,
  klendRemaining,
  requestWithdraw,
  settlePosition,
  shutdownWithdraw,
} from "./actions.js";
import { PROGRAM_ID, VENUE_KIND } from "./chain.js";
import type { HexVaultProgram } from "./chain.js";
import { idl } from "./idl.js";
import { poolFromDto, type PoolLike } from "./read.js";
import type { PoolDto } from "./api.js";

const key = () => Keypair.generate().publicKey;

const pool: PoolLike = {
  address: key(),
  acceptedMint: key(),
  closeBuffer: 15n,
  minDeposit: 1n,
  houseCutBps: 600,
  paused: false,
  epochSeconds: 86_400n,
  baseRateBps: 800,
  ticketsPerUsdc: 1,
  priorityFeeMicroLamports: 1_000,
  weightTree: key(),
  klendProgram: key(),
  klendMarket: key(),
  klendReserve: key(),
  klendCtoken: key(),
  venueKind: VENUE_KIND.klend,
};

/** Runs `action` against a real Program and returns the program's instructions it sent. */
async function sent(
  action: (program: HexVaultProgram, owner: { publicKey: PublicKey }) => Promise<unknown>,
): Promise<TransactionInstruction[]> {
  const signer = Keypair.generate();
  let captured: Transaction | null = null;
  const connection = {
    rpcEndpoint: "http://127.0.0.1:1",
    getLatestBlockhash: async () => ({
      blockhash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      lastValidBlockHeight: 1_000,
    }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  const wallet = {
    publicKey: signer.publicKey,
    signTransaction: async <T,>(tx: T): Promise<T> => {
      captured = tx as unknown as Transaction;
      (tx as unknown as Transaction).sign(signer);
      return tx;
    },
    signAllTransactions: async <T,>(txs: T[]): Promise<T[]> => txs,
  };
  const program = new Program(idl, { connection, wallet }) as unknown as HexVaultProgram;
  const result = await action(program, { publicKey: signer.publicKey });
  expect(result).toEqual({ kind: "landed", signature: "sig" });
  return (captured as Transaction | null)!.instructions.filter((ix) =>
    // The Program's own id, not PROGRAM_ID: a local VITE_PROGRAM_ID may differ.
    ix.programId.equals(program.programId),
  );
}

const idlAccounts = (name: string) =>
  idl.instructions.find((ix) => ix.name === name)!.accounts.length;

describe("player instructions against the IDL", () => {
  it("deposit names the tree and the four klend accounts", async () => {
    const [ix] = await sent((p, o) => deposit(p, o, pool, 5n));
    const keys = ix!.keys.map((k) => k.pubkey.toBase58());
    expect(ix!.keys).toHaveLength(idlAccounts("deposit"));
    for (const k of [pool.weightTree, pool.klendProgram, pool.klendMarket, pool.klendReserve, pool.klendCtoken]) {
      expect(keys).toContain(k.toBase58());
    }
  });

  it("buy_tickets, buy_position and settle_position name the tree", async () => {
    const [tickets] = await sent((p, o) => buyTickets(p, o, pool, 5n));
    const [position] = await sent((p, o) => buyPosition(p, o, pool, 1n, 1n, 1n));
    const [settle] = await sent((p, o) => settlePosition(p, o, pool, 1n));
    for (const [ix, name] of [
      [tickets, "buy_tickets"],
      [position, "buy_position"],
      [settle, "settle_position"],
    ] as const) {
      expect(ix!.keys).toHaveLength(idlAccounts(name));
      expect(ix!.keys.map((k) => k.pubkey.toBase58())).toContain(pool.weightTree.toBase58());
    }
  });

  it("request_withdraw carries the klend redeem extras in klend.rs order", async () => {
    const [ix] = await sent((p, o) => requestWithdraw(p, o, pool, 5n));
    const named = idlAccounts("request_withdraw");
    expect(ix!.keys).toHaveLength(named + 4);
    const keys = ix!.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(pool.weightTree.toBase58());
    expect(keys.slice(named)).toEqual(klendRemaining(pool).map((m) => m.pubkey.toBase58()));
  });

  it("the shutdown pair names the tree and klend on both instructions", async () => {
    const [request, process] = await sent((p, o) => shutdownWithdraw(p, o, pool, 5n, 0n));
    expect(request!.keys).toHaveLength(idlAccounts("request_withdraw") + 4);
    expect(process!.keys).toHaveLength(idlAccounts("process_withdraw"));
    for (const ix of [request!, process!]) {
      const keys = ix.keys.map((k) => k.pubkey.toBase58());
      for (const k of [pool.weightTree, pool.klendProgram, pool.klendMarket, pool.klendReserve, pool.klendCtoken]) {
        expect(keys).toContain(k.toBase58());
      }
    }
  });
});

describe("klendRemaining", () => {
  it("is empty for the test-venue stub kind, whichever program is pinned", () => {
    expect(klendRemaining({ ...pool, venueKind: VENUE_KIND.stub })).toEqual([]);
  });

  it("goes by the kind, not the pinned program, and refuses a kind it does not know", () => {
    expect(klendRemaining({ ...pool, klendProgram: PROGRAM_ID })).toHaveLength(4);
    expect(() => klendRemaining({ ...pool, venueKind: 2 })).toThrow(/unsupported venue kind 2/);
  });

  it("derives the market authority, liquidity vault and cToken mint, then the sysvar", () => {
    const [lma, supply, cmint, sysvar] = klendRemaining(pool);
    const derive = (...seeds: (string | PublicKey)[]) =>
      PublicKey.findProgramAddressSync(
        seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
        pool.klendProgram,
      )[0];
    expect(lma!.pubkey).toEqual(derive("lma", pool.klendMarket));
    expect(supply).toEqual({
      pubkey: derive("reserve_liq_supply", pool.klendMarket, pool.acceptedMint),
      isSigner: false,
      isWritable: true,
    });
    expect(cmint!.pubkey).toEqual(derive("reserve_coll_mint", pool.klendMarket, pool.acceptedMint));
    expect(sysvar!.pubkey).toEqual(SYSVAR_INSTRUCTIONS_PUBKEY);
  });
});

describe("poolFromDto", () => {
  const dto = {
    address: pool.address.toBase58(),
    mint: pool.acceptedMint.toBase58(),
    closeBuffer: "15",
    minDeposit: "1",
    houseCutBps: 600,
    paused: false,
    epochSeconds: "86400",
    baseRateBps: 800,
    ticketsPerUsdc: 1,
    weightTree: pool.weightTree.toBase58(),
    klendProgram: pool.klendProgram.toBase58(),
    klendMarket: pool.klendMarket.toBase58(),
    klendReserve: pool.klendReserve.toBase58(),
    klendCtoken: pool.klendCtoken.toBase58(),
    venueKind: 0,
  } as unknown as PoolDto & { closeBuffer: string; minDeposit: string };

  it("carries the tree and klend addresses through", () => {
    const result = poolFromDto(dto, 0, pool.address);
    expect(result.ok && result.pool.weightTree.equals(pool.weightTree)).toBe(true);
    expect(result.ok && result.pool.klendReserve.equals(pool.klendReserve)).toBe(true);
  });

  it("refuses a row indexed before the live-yield layout", () => {
    expect(poolFromDto({ ...dto, weightTree: "" }, 0, pool.address).ok).toBe(false);
  });
});
