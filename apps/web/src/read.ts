/**
 * Ticket 07: the Indexer is the browser's read model now, not a cache in
 * front of an authoritative chain. `GET /state` (see `useStatePoll.ts`) is
 * the only source for Pool, Epoch, Round, Player and Position. The one
 * surviving direct chain read is the connected wallet's own token balance,
 * below, against the public endpoint on the visitor's own rate-limit
 * budget — nothing else in the browser touches the chain.
 */
import { useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";

import { acceptedAta } from "./chain.js";
import type { PoolDto } from "./api.js";

/**
 * What `actions.ts` needs to build instructions, and what the screens need to
 * gate the UI. All of it derives from `/state`'s `pool`: `closeBuffer` and
 * `minDeposit` are columns on the mirror (migration
 * 20260914061500_pool_close_buffer_and_min_deposit), so serving this costs
 * no chain read.
 */
export interface PoolLike {
  address: PublicKey;
  acceptedMint: PublicKey;
  closeBuffer: bigint;
  minDeposit: bigint;
  /** Share of a settled round's pot credited to the House, in basis points. */
  houseCutBps: number;
  paused: boolean;
  /** One epoch's length in seconds, for the buy-tickets draw-value preview. */
  epochSeconds: bigint;
  /** Base yield's APR on time-weighted Principal, in basis points (ADR 0011). */
  baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. */
  ticketsPerUsdc: number;
  /** Already validated and capped (`safePriorityFee`); the only fee the send
   *  helper (`actions.ts`, ticket 08) ever signs with. */
  priorityFeeMicroLamports: number;
  /** The Weight tree and the four pinned klend accounts (yield-claimer):
   *  deposit, withdraw and the game instructions all name them. */
  weightTree: PublicKey;
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
}

/**
 * The floor the send helper signs with when `/state`'s estimate is 0 or
 * missing (a failed backend read, or genuinely no congestion) — the ticket's
 * "the web uses its own floor".
 */
const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 1_000;

/**
 * Hard ceiling on `/state`'s `priorityFeeMicroLamports` before it ever
 * reaches a signature (security review ticket 14): `/state` is
 * unauthenticated input, so this caps what a compromised or misconfigured
 * backend could make a wallet sign away in fees, independent of whatever cap
 * the backend itself applies (`PRIORITY_FEE_MAX_MICROLAMPORTS`). Matches
 * that config's own default so a correctly configured backend never gets
 * clamped a second time.
 */
const PRIORITY_FEE_CEILING_MICROLAMPORTS = 50_000;

/**
 * Validates `/state`'s `priorityFeeMicroLamports` at the boundary: a finite
 * non-negative integer, clamped to `[PRIORITY_FEE_FLOOR_MICROLAMPORTS,
 * PRIORITY_FEE_CEILING_MICROLAMPORTS]`. Anything else — `NaN`, a negative
 * number, a fraction, `Infinity` — floors to the minimum rather than signing
 * whatever the backend sent.
 */
export function safePriorityFee(raw: number): number {
  const value = Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return Math.min(
    Math.max(value, PRIORITY_FEE_FLOOR_MICROLAMPORTS),
    PRIORITY_FEE_CEILING_MICROLAMPORTS,
  );
}

/**
 * Ticket 14: the app signs only against the Pool address its own
 * `VITE_POOL_ID` derives. `/state` is unauthenticated input; a compromised
 * or misconfigured backend could otherwise hand a signature a different Pool
 * to spend against. The mint is taken from `/state` as is: the backend's own
 * boot guard checks it against the on-chain Pool (beta-launch-fixes 10), and
 * the Pool address pin above is what stops a swapped pool.
 */
export type PoolResult =
  | { ok: true; pool: PoolLike }
  | { ok: false; reason: string };

/** Pure mapping from the API's decimal-string shape to the PublicKey/bigint
 *  one signing code needs; refuses a Pool that does not match what this
 *  build is configured for. */
export function poolFromDto(
  dto: PoolDto & { closeBuffer: string; minDeposit: string },
  priorityFeeMicroLamports: number,
  expectedAddress: PublicKey,
): PoolResult {
  const address = new PublicKey(dto.address);
  if (!address.equals(expectedAddress)) {
    return {
      ok: false,
      reason: `Pool address does not match this app's configuration (expected ${expectedAddress.toBase58()}).`,
    };
  }
  const mint = new PublicKey(dto.mint);
  // An indexer row from before the live-yield layout has none of these; no
  // instruction can be built without them.
  if (!dto.weightTree || !dto.klendProgram || !dto.klendMarket || !dto.klendReserve || !dto.klendCtoken) {
    return { ok: false, reason: "The pool is not indexed yet. Try again in a moment." };
  }
  return {
    ok: true,
    pool: {
      address,
      acceptedMint: mint,
      closeBuffer: BigInt(dto.closeBuffer),
      minDeposit: BigInt(dto.minDeposit),
      houseCutBps: dto.houseCutBps,
      paused: dto.paused,
      epochSeconds: BigInt(dto.epochSeconds),
      baseRateBps: dto.baseRateBps,
      ticketsPerUsdc: dto.ticketsPerUsdc,
      priorityFeeMicroLamports: safePriorityFee(priorityFeeMicroLamports),
      weightTree: new PublicKey(dto.weightTree),
      klendProgram: new PublicKey(dto.klendProgram),
      klendMarket: new PublicKey(dto.klendMarket),
      klendReserve: new PublicKey(dto.klendReserve),
      klendCtoken: new PublicKey(dto.klendCtoken),
    },
  };
}

/**
 * The one surviving direct chain read (spec.md "Wallet balances stay on the
 * chain"): the connected wallet's own USDC balance. `reloadKey` says when to
 * take it again, and it has to be a value that only changes when something
 * moved — pass the state poll's `data` object itself and this re-reads the
 * chain every 2 s per viewer, which is the polling the whole effort removed.
 * App.tsx passes `snapshot(state)` plus a faucet nonce.
 */
/** No ATA yet (never deposited) is a real, confirmed zero; anything else a
 *  balance read can throw is unknown, not zero (ticket 15: a stuttering RPC
 *  must never look like an empty wallet and block a deposit as over
 *  balance). Solana's JSON-RPC has no dedicated error code for a missing
 *  token account, only this message text. */
export function isMissingTokenAccount(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not find account/i.test(message);
}

export function useWalletBalance(
  connection: Connection,
  mint: string | null,
  owner: PublicKey | undefined,
  reloadKey: unknown,
): bigint | null {
  const [balance, setBalance] = useState<bigint | null>(0n);

  useEffect(() => {
    if (!mint || !owner) {
      setBalance(0n);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ata = acceptedAta(new PublicKey(mint), owner);
        const { value } = await connection.getTokenAccountBalance(ata);
        if (!cancelled) setBalance(BigInt(value.amount));
      } catch (error) {
        if (!cancelled) setBalance(isMissingTokenAccount(error) ? 0n : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, mint, owner, reloadKey]);

  return balance;
}

/**
 * Ticket 15: rent for a fresh USDC associated token account, the SOL cost an
 * email-login wallet with only USDC does not expect. `deposit`'s
 * `preInstructions` creates the ATA idempotently, so this is the one-time
 * cost a first deposit (or a first Position, which also opens accounts)
 * needs covered; a small margin over the bare rent covers the transaction
 * fee too.
 */
export const MIN_SOL_LAMPORTS = 3_000_000n; // ~0.003 SOL

/** Player copy naming the amount, or null when `lamports` covers it (or is
 *  still unknown, in which case there is nothing to warn about yet). Null for
 *  a sponsored wallet too: Privy's sponsored send pays the fee and tops the
 *  wallet up by the rent the transaction needs. */
export function solRentWarning(
  lamports: bigint | null,
  options: { sponsored: boolean },
): string | null {
  if (options.sponsored || lamports === null || lamports >= MIN_SOL_LAMPORTS) return null;
  const solNeeded = (Number(MIN_SOL_LAMPORTS - lamports) / 1e9).toFixed(3);
  return `You need about ${solNeeded} more SOL in your wallet to cover network fees before this will go through.`;
}

/** The connected wallet's own SOL balance, for `solRentWarning` above. Same
 *  reload semantics as `useWalletBalance`; a failed read stays `null`
 *  (unknown), never a false "you have enough". */
export function useSolBalance(
  connection: Connection,
  owner: PublicKey | undefined,
  reloadKey: unknown,
): bigint | null {
  const [lamports, setLamports] = useState<bigint | null>(null);

  useEffect(() => {
    if (!owner) {
      setLamports(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const value = await connection.getBalance(owner);
        if (!cancelled) setLamports(BigInt(value));
      } catch {
        if (!cancelled) setLamports(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, owner, reloadKey]);

  return lamports;
}
