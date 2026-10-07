/**
 * The six instructions this app sends. Each builds from the IDL by name and
 * goes through `sendMany` (ticket 08, production-hardening): a compute
 * budget sized from a public-RPC simulation, signed through the wallet
 * adapter or Privy, confirmed with the blockhash strategy at `confirmed`.
 * The caller gets a `SendResult` — `landed`, `expired` or `failed(code,
 * message)` — instead of a bare signature or a thrown error, and triggers
 * the chain re-read only on `landed`.
 *
 * `settlePosition` and `processWithdraw` are permissionless (`processWithdraw`
 * wants the owner's signature while the pool is impaired): the
 * program takes no signer for them, so the connected wallet is only the fee
 * payer.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  acceptedAta,
  bn,
  jackpotVaultAddress,
  method,
  playerAddress,
  positionAddress,
  principalVaultAddress,
  roundAddress,
  TOKEN_PROGRAM,
  VENUE_KIND,
  type HexVaultProgram,
  type TxBuilder,
} from "./chain.js";
import type { PoolLike } from "./read.js";
import { shutdownWithdrawStep } from "./shutdown.js";

export type { PoolLike };

export interface TxSigner {
  readonly publicKey: PublicKey;
  /**
   * Privy's sponsored path: signs and broadcasts, returning the base58
   * signature straight away — it does not itself wait for the transaction to
   * land (research/notes/frontend_and_wallets.md). `sendMany` confirms it the
   * same way as every other path (ticket 08), so a dropped sponsored send
   * still resolves to `expired`/`failed` instead of hanging. Unset for the
   * ordinary wallet-adapter path, which signs through `program.provider`.
   */
  readonly sendTransaction?:
    | ((transaction: Transaction) => Promise<string>)
    | undefined;
}

/** One player transaction's outcome (ticket 08): `sendMany` always resolves
 *  to one of these once a transaction has actually reached the network —
 *  never a hang, and never a raw thrown RPC error for these three cases. A
 *  rejected signature or a failed blockhash fetch, which never reach the
 *  network, still throw; callers keep their existing catch block for those. */
export type SendResult =
  | { readonly kind: "landed"; readonly signature: string }
  /** The blockhash expired before the transaction confirmed: dropped, not
   *  failed. The UI's answer is "try again", not the decoded program error. */
  | { readonly kind: "expired" }
  /**
   * Ticket 15: the confirmation call itself failed — a dropped connection, a
   * stuttering RPC — for a reason other than the blockhash expiring, so
   * whether the transaction landed is genuinely unknown. Never "try again":
   * retrying a deposit whose first attempt actually landed pays twice.
   * `resolveUnknownSend` below polls the signature until the blockhash's
   * `lastValidBlockHeight` passes, and only then resolves to `landed`,
   * `expired` or `failed`.
   */
  | { readonly kind: "unknown"; readonly signature: string; readonly lastValidBlockHeight: number }
  /** `code` is the on-chain `Custom` program error number when the failure
   *  carries one (`playerErrors.ts`'s `decodeErrorCode` turns it into player
   *  copy), null otherwise. `message` is the raw diagnostic for `console.error`. */
  | { readonly kind: "failed"; readonly code: number | null; readonly message: string };

const CONFIRMED = "confirmed" as const;

/** Solana's hard compute-unit ceiling per transaction, the generous limit
 *  the simulation probe below runs under before pricing the real one. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Margin over a simulation's `unitsConsumed`, same as the backend's
 *  (chain.service.ts `COMPUTE_UNIT_MARGIN`): rounded up, so a transaction
 *  never lands one unit short of what it measured. */
const COMPUTE_UNIT_MARGIN = 1.1;

/** `setComputeUnitLimit` when the public RPC's simulation fails: the
 *  runtime's own per-instruction default (solana.com's Compute Budget doc),
 *  so a struggling simulation still gets a transaction sent instead of
 *  blocking the send on it. */
const FALLBACK_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

/** The slice of `program.provider` this file signs and reads a blockhash
 *  through — narrower than Anchor's own `Provider` type so a test stub needs
 *  no more than this to stand in for one. */
interface SendProvider {
  connection: Connection;
  wallet?: { signTransaction<T>(tx: T): Promise<T> } | undefined;
}

function providerOf(program: HexVaultProgram): SendProvider {
  // SAFETY: every Program this app builds (App.tsx) carries an
  // AnchorProvider, whose `connection` and `wallet` are always set; the
  // SDK's `Provider` type only marks `wallet` optional for providers that
  // never sign.
  return program.provider as unknown as SendProvider;
}

/** The on-chain `Custom` program error code inside a landed transaction's
 *  failure, the same `{InstructionError: [index, {Custom: N}]}` shape
 *  `confirmTransaction`/`getSignatureStatuses` report; null for a failure
 *  with no such code (an account-level error, not a program `require`). */
function customErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const detail = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return null;
  const kind = detail[1] as unknown;
  if (typeof kind !== "object" || kind === null || !("Custom" in kind)) return null;
  const code = (kind as { Custom: unknown }).Custom;
  return typeof code === "number" ? code : null;
}

/**
 * True when a simulation failed only for lack of SOL, which Privy's sponsored
 * send supplies in the transaction it broadcasts: it pays the fee and tops the
 * wallet up by the rent for any account the transaction opens. Our own
 * simulation runs with the wallet as fee payer and cannot see either, so for a
 * sponsored send these failures are not real. Two shapes:
 * - `"AccountNotFound"`: a wallet with exactly 0 SOL has no account, so the
 *   fee payer does not exist and no instruction runs.
 * - The system program's "insufficient lamports" log before its custom error
 *   1: the wallet exists but cannot pay rent for a new account (the Player on
 *   a first deposit into a pool, a fresh token account).
 */
function isShortOfSol(err: unknown, logs: readonly string[] | null | undefined): boolean {
  if (err === "AccountNotFound") return true;
  return logs?.some((line) => line.startsWith("Transfer: insufficient lamports")) ?? false;
}

/** `computeUnitLimit`'s result: either a sized (or fallback) compute-unit
 *  limit, or ticket 15's "the simulation itself reported the instructions
 *  would fail" — a program error caught before the wallet ever sees a
 *  signature request. */
type ComputeSizing =
  | { kind: "units"; units: number }
  | { kind: "programError"; err: unknown };

/**
 * `setComputeUnitLimit`'s value: `unitsConsumed × COMPUTE_UNIT_MARGIN` from a
 * simulation on `connection` (ticket 08, research/notes/transactions_and_rpc.md
 * "Simulate every transaction to measure real compute-unit usage"), or the
 * per-instruction fallback when the simulation *call itself* throws — a
 * stuttering public RPC, not a program error. A simulation that ran fine but
 * reports `value.err` means these exact instructions would fail on chain
 * (ticket 15's "a failed simulation surfaces its program error before the
 * wallet is asked to sign"), so that case is reported back instead of
 * silently falling back and sending anyway. The one exception is a sponsored
 * send short only of SOL (`isShortOfSol`): Privy covers that, so it gets the
 * fallback limit and goes to Privy instead of failing here.
 */
async function computeUnitLimit(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  options: { sponsored: boolean },
): Promise<ComputeSizing> {
  let simulated: { err: unknown; unitsConsumed?: number; logs?: string[] | null };
  try {
    const probe = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
      ...instructions,
    );
    probe.feePayer = payer;
    simulated = (await connection.simulateTransaction(probe)).value;
  } catch {
    return {
      kind: "units",
      units: Math.min(
        MAX_COMPUTE_UNIT_LIMIT,
        FALLBACK_COMPUTE_UNITS_PER_INSTRUCTION * instructions.length,
      ),
    };
  }
  if (simulated.err && !(options.sponsored && isShortOfSol(simulated.err, simulated.logs))) {
    return { kind: "programError", err: simulated.err };
  }
  if (simulated.err || simulated.unitsConsumed === undefined) {
    return {
      kind: "units",
      units: Math.min(
        MAX_COMPUTE_UNIT_LIMIT,
        FALLBACK_COMPUTE_UNITS_PER_INSTRUCTION * instructions.length,
      ),
    };
  }
  return { kind: "units", units: Math.ceil(simulated.unitsConsumed * COMPUTE_UNIT_MARGIN) };
}

/**
 * The one send helper every player transaction goes through (ticket 08,
 * production-hardening): fetches the blockhash and `lastValidBlockHeight`,
 * prepends compute-budget instructions (the capped priority fee from
 * `/state`, and a compute-unit limit sized above), signs through the wallet
 * adapter or Privy's own `sendTransaction`, then confirms with the blockhash
 * strategy at `confirmed` — never the deprecated signature-only confirm, and
 * never left to Anchor's `.rpc()`/`sendAndConfirm`, so an expired or
 * on-chain-failed send always resolves to a `SendResult` instead of hanging.
 */
export async function sendMany(
  program: HexVaultProgram,
  owner: TxSigner,
  instructions: TransactionInstruction[],
  priorityFeeMicroLamports: number,
): Promise<SendResult> {
  const provider = providerOf(program);
  const connection = provider.connection;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(CONFIRMED);
  const sizing = await computeUnitLimit(connection, instructions, owner.publicKey, {
    sponsored: owner.sendTransaction !== undefined,
  });
  if (sizing.kind === "programError") {
    // Ticket 15: caught before anything is signed or sent.
    return {
      kind: "failed",
      code: customErrorCode(sizing.err),
      message: JSON.stringify(sizing.err),
    };
  }
  const transaction = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: owner.publicKey,
  }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: sizing.units }),
    ...instructions,
  );

  let signature: string;
  if (owner.sendTransaction) {
    signature = await owner.sendTransaction(transaction);
  } else {
    if (!provider.wallet) throw new Error("wallet cannot sign transactions");
    const signed = await provider.wallet.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize());
  }

  try {
    const { value } = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      CONFIRMED,
    );
    if (value.err) {
      return { kind: "failed", code: customErrorCode(value.err), message: JSON.stringify(value.err) };
    }
    return { kind: "landed", signature };
  } catch (error) {
    if (error instanceof TransactionExpiredBlockheightExceededError) return { kind: "expired" };
    // Ticket 15: the confirm call itself failed for some other reason (a
    // dropped connection, a stuttering RPC) — whether the transaction landed
    // is genuinely unknown, so this is not "failed" and never "try again".
    console.error(error instanceof Error ? error.message : String(error));
    return { kind: "unknown", signature, lastValidBlockHeight };
  }
}

/** `SendResult` once `"unknown"` has been resolved: never hangs a caller's
 *  narrowing on a branch that can no longer occur. */
export type ResolvedSendResult = Exclude<SendResult, { kind: "unknown" }>;

/**
 * Ticket 15: resolves a `SendResult` of kind `"unknown"` by polling the
 * signature's status until it lands, fails on chain, or the blockhash's
 * `lastValidBlockHeight` passes (expired) — the same three outcomes a clean
 * confirmation would have produced. Callers keep money buttons disabled
 * while this is in flight.
 */
export async function resolveUnknownSend(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  pollMs = 2_000,
): Promise<ResolvedSendResult> {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        return { kind: "failed", code: customErrorCode(status.err), message: JSON.stringify(status.err) };
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return { kind: "landed", signature };
      }
    }
    const blockHeight = await connection.getBlockHeight(CONFIRMED);
    if (blockHeight > lastValidBlockHeight) return { kind: "expired" };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Runs `result` through `resolveUnknownSend` when it is `"unknown"`;
 *  otherwise passes it through unchanged. The one call site every send path
 *  needs so an unknown outcome never reaches player-facing error copy as a
 *  bare "failed". */
export async function awaitSendResult(
  program: HexVaultProgram,
  result: SendResult,
): Promise<ResolvedSendResult> {
  if (result.kind !== "unknown") return result;
  return resolveUnknownSend(
    providerOf(program).connection,
    result.signature,
    result.lastValidBlockHeight,
  );
}

/** The four pinned klend accounts every instruction that runs sync names. */
const venueAccounts = (pool: PoolLike) => ({
  klendProgram: pool.klendProgram,
  klendMarket: pool.klendMarket,
  klendReserve: pool.klendReserve,
  klendCtoken: pool.klendCtoken,
});

/**
 * What the venue backing needs beyond the pinned four, chosen by the pool's
 * `venueKind` like the operator's `venueRemaining`, not by which program is
 * pinned. For klend, in the order klend.rs reads them: the lending market
 * authority, the reserve's liquidity supply vault, the cToken mint and the
 * instructions sysvar. klend derives the first three from the market and the
 * liquidity mint, so no RPC read is needed; the program checks each against
 * the reserve itself. The `test-venue` stub takes none (apps/backend
 * operator/instructions.ts `venueRemaining` does the same). A kind this
 * build does not know throws rather than guess an account list.
 */
export function klendRemaining(pool: PoolLike) {
  if (pool.venueKind === VENUE_KIND.stub) return [];
  if (pool.venueKind !== VENUE_KIND.klend) {
    throw new Error(`unsupported venue kind ${pool.venueKind}`);
  }
  const derive = (...seeds: (string | PublicKey)[]): PublicKey =>
    PublicKey.findProgramAddressSync(
      seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : seed.toBuffer())),
      pool.klendProgram,
    )[0];
  const meta = (pubkey: PublicKey, isWritable: boolean) => ({
    pubkey,
    isSigner: false,
    isWritable,
  });
  return [
    meta(derive("lma", pool.klendMarket), false),
    meta(derive("reserve_liq_supply", pool.klendMarket, pool.acceptedMint), true),
    meta(derive("reserve_coll_mint", pool.klendMarket, pool.acceptedMint), true),
    meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
  ];
}

/** Sends `builder`'s instructions through `sendMany` above. */
async function send(
  program: HexVaultProgram,
  owner: TxSigner,
  builder: TxBuilder,
  priorityFeeMicroLamports: number,
): Promise<SendResult> {
  const unsigned = await builder.transaction();
  return sendMany(program, owner, unsigned.instructions, priorityFeeMicroLamports);
}

export async function deposit(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const builder = method(
    program,
    "deposit",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      weightTree: pool.weightTree,
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      ...venueAccounts(pool),
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    // The faucet may already have created it; idempotent either way.
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        o,
        ownerToken,
        o,
        pool.acceptedMint,
        TOKEN_PROGRAM,
      ),
    ]);
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/**
 * Spends `amount` USDC into the jackpot vault for `amount × ticketsPerUsdc`
 * Tickets (ticket 10). Per Player per day the program caps total spend at
 * Principal, checked live: fails with `DailyBuyCapExceeded` over the cap,
 * `HouseCannotBuyTickets` for the House Player.
 */
export async function buyTickets(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const builder = method(
    program,
    "buyTickets",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      weightTree: pool.weightTree,
      acceptedMint: pool.acceptedMint,
      ownerToken: acceptedAta(pool.acceptedMint, o),
      jackpotVault: jackpotVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM,
    });
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/**
 * The one withdraw (ADR 0020). The part of `amount` that is still a pending
 * deposit pays to the wallet in this transaction and the rest queues for
 * `process_withdraw` once the epoch ends (ADR 0009). The program syncs the venue
 * itself, so no refresh instruction goes in front; a refund redeems from klend
 * when free idle is short, which is why the klend extras ride along. The compute
 * limit comes from `sendMany`'s simulation. Fails with `VenueIlliquid` when the
 * reserve cannot cover the refund's gap, and with `InsufficientPrincipal` past
 * Principal less what is already queued.
 */
export async function requestWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const builder = method(
    program,
    "requestWithdraw",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      weightTree: pool.weightTree,
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      ...venueAccounts(pool),
      tokenProgram: TOKEN_PROGRAM,
    })
    .remainingAccounts(klendRemaining(pool))
    // A mainnet depositor may have closed the ATA since depositing.
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        o,
        ownerToken,
        o,
        pool.acceptedMint,
        TOKEN_PROGRAM,
      ),
    ]);
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/**
 * Pays out the whole pending amount. The wallet signs as the owner, which the
 * program needs while the pool is impaired (the payout is the haircut value)
 * and ignores otherwise, so this is the depositor's own escape hatch when the
 * operator has not pushed it yet. Fails with `WithdrawalNotDue` before the
 * requesting epoch has ended and `InsufficientVaultLiquidity` while the
 * vault is short, so the caller gates it on the pending row's `due` state.
 */
export async function processWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
): Promise<SendResult> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const builder = method(program, "processWithdraw")()
    .accounts({
      pool: pool.address,
      player: playerAddress(pool.address, o),
      owner: o,
      weightTree: pool.weightTree,
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      ...venueAccounts(pool),
      tokenProgram: TOKEN_PROGRAM,
    })
    // A mainnet depositor may have closed the ATA since depositing; the
    // transfer needs it back, and this costs nothing when it is already there.
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        o,
        ownerToken,
        o,
        pool.acceptedMint,
        TOKEN_PROGRAM,
      ),
    ]);
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/**
 * Ticket 11: `process_withdraw` skips the epoch lock while the pool is shut
 * down (custody.rs), so a fresh request and its payout collapse into one
 * transaction instead of the ordinary two. `shutdownWithdrawStep` decides
 * which instructions that needs; a Player with only an earlier pending
 * amount and nothing new to request sends `process_withdraw` alone.
 */
export async function shutdownWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  requestAmount: bigint,
  pendingWithdraw: bigint,
): Promise<SendResult> {
  const step = shutdownWithdrawStep(requestAmount, pendingWithdraw);
  if (step.kind === "none") throw new Error("nothing to withdraw");
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const instructions: TransactionInstruction[] = [];
  if (step.kind === "request-and-process") {
    instructions.push(
      await method(
        program,
        "requestWithdraw",
      )(bn(step.amount))
        .accounts({
          owner: o,
          pool: pool.address,
          player: playerAddress(pool.address, o),
          weightTree: pool.weightTree,
          acceptedMint: pool.acceptedMint,
          ownerToken,
          principalVault: principalVaultAddress(pool.address),
          ...venueAccounts(pool),
          tokenProgram: TOKEN_PROGRAM,
        })
        .remainingAccounts(klendRemaining(pool))
        .instruction(),
    );
  }
  instructions.push(
    // A mainnet depositor may have closed the ATA since depositing; the
    // transfer needs it back, and this costs nothing when it is already there.
    createAssociatedTokenAccountIdempotentInstruction(
      o,
      ownerToken,
      o,
      pool.acceptedMint,
      TOKEN_PROGRAM,
    ),
    await method(program, "processWithdraw")()
      .accounts({
        pool: pool.address,
        player: playerAddress(pool.address, o),
        owner: o,
        weightTree: pool.weightTree,
        acceptedMint: pool.acceptedMint,
        ownerToken,
        principalVault: principalVaultAddress(pool.address),
        ...venueAccounts(pool),
        tokenProgram: TOKEN_PROGRAM,
      })
      .instruction(),
  );
  return sendMany(program, owner, instructions, pool.priorityFeeMicroLamports);
}

/** Stakes `stakePerTile` Entries on every tile set in `tilesMask`. */
export async function buyPosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
  tilesMask: bigint,
  stakePerTile: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, roundId);
  const builder = method(program, "buyPosition")(bn(tilesMask), bn(stakePerTile))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      weightTree: pool.weightTree,
      round,
      position: positionAddress(round, o),
      systemProgram: SystemProgram.programId,
    });
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/** Credits the round reward as Entries and closes the Position (rent back). */
export async function settlePosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, roundId);
  const builder = method(program, "settlePosition")()
    .accounts({
      pool: pool.address,
      weightTree: pool.weightTree,
      round,
      player: playerAddress(pool.address, o),
      owner: o,
      position: positionAddress(round, o),
    });
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

