import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AnchorError,
  AnchorProvider,
  parseIdlErrors,
  Program,
  translateError,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type SignatureResult,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { HexVaultEnv } from "../config/env";
import { loadIdl } from "./idl";
import {
  epochAddress,
  jackpotVaultAddress,
  playerAddress,
  poolAddress,
  positionAddress,
  principalVaultAddress,
  roundAddress,
} from "./pda";
import {
  heliusPriorityFeeEstimate,
  p75PriorityFeeMicroLamports,
  type RpcRequester,
} from "./priority-fee";

export const SOLANA_CONNECTION = Symbol("SOLANA_CONNECTION");

/**
 * How long `send` waits for a signature subscription to report before
 * falling back to one status query and one block-height read (ticket 04,
 * spec.md "A subscription still has to notice a dropped transaction"): a
 * bare subscription would wait forever for a transaction that never landed,
 * so the wait is bounded and the fallback decides pending from expired.
 */
export const CONFIRM_TIMEOUT_MS = 30_000;

/**
 * How often `send`'s confirmation wait rebroadcasts the identical signed
 * bytes (production-hardening ticket 04, research/report.md "Landing a
 * transaction is a local auction"): the RPC node's own retry queue is not
 * trusted to land it, so this loop owns resending instead.
 */
export const REBROADCAST_INTERVAL_MS = 2_000;

/** Solana's hard compute-unit ceiling per transaction, used as the generous
 *  limit `send` simulates under before pricing the real one. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** The margin over a simulation's `unitsConsumed` the real compute-unit
 *  limit is set to (ticket 04): rounded up, so a transaction never lands one
 *  unit short of what it measured. */
const COMPUTE_UNIT_MARGIN = 1.1;

/** How long `send`'s priority-fee read is cached per writable-account set
 *  (ticket 10), so a burst of sends against the same accounts costs one
 *  fee-estimate call rather than one per send. */
export const PRIORITY_FEE_TTL_MS = 10_000;

/**
 * Connection, Program, operator keypair, PDA helpers and a signed-send
 * helper. No business logic (deposit/withdraw/etc calls) — that lands with
 * the operator and API tickets.
 */
@Injectable()
export class ChainService {
  readonly connection: Connection;
  readonly program: Program<Idl>;
  readonly programId: PublicKey;
  readonly keypair: Keypair;
  readonly poolId: bigint;

  private readonly logger = new Logger(ChainService.name);
  private readonly errorNames: Map<number, string>;
  private readonly idlErrorMessages: Map<number, string>;
  /**
   * The last Clock sysvar reading (the operator's tick takes one) and the wall
   * time it was taken at. The indexer's live log path timestamps events from
   * this instead of paying a `getBlockTime` call per event (ticket 04).
   */
  private lastChainTime: { value: bigint; observedAtMs: number } | undefined;

  private readonly priorityFeeMaxMicroLamports: number;
  /** `send`'s `getRecentPrioritizationFees` result, keyed by the sorted
   *  writable-account set and held for `PRIORITY_FEE_TTL_MS`. */
  private readonly priorityFeeCache = new Map<
    string,
    { at: number; result: Promise<number> }
  >();

  constructor(
    @Inject(SOLANA_CONNECTION) connection: Connection,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.connection = connection;
    this.keypair = Keypair.fromSecretKey(
      bs58.decode(config.get("OPERATOR_KEYPAIR", { infer: true })),
    );
    this.poolId = BigInt(config.get("POOL_ID", { infer: true }));
    this.priorityFeeMaxMicroLamports = config.get(
      "PRIORITY_FEE_MAX_MICROLAMPORTS",
      { infer: true },
    );
    this.programId = new PublicKey(config.get("PROGRAM_ID", { infer: true }));

    // The env-resolved program id wins over whatever address is baked into
    // the checked-in IDL snapshot, which goes stale between program builds.
    const idl = { ...loadIdl(), address: this.programId.toBase58() };
    const provider = new AnchorProvider(connection, new Wallet(this.keypair), {
      commitment: "confirmed",
    });
    this.program = new Program(idl, provider);

    this.idlErrorMessages = parseIdlErrors(idl);
    this.errorNames = new Map((idl.errors ?? []).map((e) => [e.code, e.name]));
  }

  poolAddress(poolId: bigint = this.poolId): PublicKey {
    return poolAddress(this.programId, poolId);
  }

  epochAddress(
    epochId: bigint,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return epochAddress(this.programId, pool, epochId);
  }

  roundAddress(
    roundId: bigint,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return roundAddress(this.programId, pool, roundId);
  }

  playerAddress(
    owner: PublicKey,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return playerAddress(this.programId, pool, owner);
  }

  positionAddress(round: PublicKey, owner: PublicKey): PublicKey {
    return positionAddress(this.programId, round, owner);
  }

  principalVaultAddress(pool: PublicKey = this.poolAddress()): PublicKey {
    return principalVaultAddress(this.programId, pool);
  }

  jackpotVaultAddress(pool: PublicKey = this.poolAddress()): PublicKey {
    return jackpotVaultAddress(this.programId, pool);
  }

  /** Records a Clock sysvar reading, for `lastObservedChainTime`. */
  recordChainTime(now: bigint): void {
    this.lastChainTime = { value: now, observedAtMs: Date.now() };
  }

  /**
   * The last chain time read, advanced by the wall seconds since. The operator
   * can sleep a minute between reads, and an event stamped with a minute-old
   * clock would land in the wrong Round. The advance is the only wall time in
   * it; a fast local validator's chain clock pulls ahead again on the next
   * read. Undefined until something has read the clock once.
   */
  lastObservedChainTime(): bigint | undefined {
    if (this.lastChainTime === undefined) return undefined;
    const elapsedMs = Math.max(0, Date.now() - this.lastChainTime.observedAtMs);
    return this.lastChainTime.value + BigInt(Math.floor(elapsedMs / 1000));
  }

  /**
   * Signs with `signer` (the operator unless told otherwise, as for the
   * Sparring player), sends, confirms at "confirmed". The signer pays the fee.
   *
   * The blockhash is fetched at "finalized" on purpose. The RPC is a
   * load-balanced pool, and a "confirmed" blockhash from one node is not yet
   * known to a node a few slots behind, so preflight there fails with
   * "Blockhash not found". A finalized hash is ~32 slots old, which every node
   * has, and still leaves ~118 of its 150 valid slots to land.
   */
  async send(
    instructions: TransactionInstruction[],
    signer: Keypair = this.keypair,
    lookupTables: readonly AddressLookupTableAccount[] = [],
  ): Promise<string> {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("finalized");
      const [microLamports, computeUnits] = await Promise.all([
        this.priorityFeeMicroLamports(writableAccountsOf(instructions)),
        this.computeUnitLimit(
          instructions,
          signer.publicKey,
          blockhash,
          lastValidBlockHeight,
          lookupTables,
        ),
      ]);
      const budgetInstructions = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        ...(computeUnits === undefined
          ? []
          : [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })]),
      ];
      if (lookupTables.length > 0) {
        // A kVault pool's instructions name too many accounts for a legacy
        // transaction (venue-switch ticket 06): v0, with the vault's table.
        const versioned = new VersionedTransaction(
          new TransactionMessage({
            payerKey: signer.publicKey,
            recentBlockhash: blockhash,
            instructions: [...budgetInstructions, ...instructions],
          }).compileToV0Message([...lookupTables]),
        );
        versioned.sign([signer]);
        // SAFETY: sign() has just filled the fee payer's signature slot.
        const versionedSignature = bs58.encode(versioned.signatures[0] as Uint8Array);
        await this.sendSigned(versioned.serialize(), versionedSignature, lastValidBlockHeight);
        return versionedSignature;
      }
      const tx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: signer.publicKey,
      }).add(...budgetInstructions, ...instructions);
      tx.sign(signer);
      // SAFETY: sign() has just filled the fee payer's signature slot.
      const signature = bs58.encode(tx.signature as Buffer);
      await this.sendSigned(tx.serialize(), signature, lastValidBlockHeight);
      return signature;
    } catch (cause) {
      throw this.mapSendError(cause);
    }
  }

  /**
   * Sends already-signed bytes and confirms them (ticket 04): `send` above is
   * this plus building, pricing and signing the transaction. The admin CLI's
   * Ledger path, which signs its own way, calls this directly so it lands
   * through the same subscription-and-rebroadcast loop rather than its own
   * confirmation logic.
   */
  async sendSigned(
    raw: Uint8Array,
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<void> {
    // Subscribe before sending. The RPC only notifies a signature that lands
    // after the subscription opens, so one that confirms first never would.
    const watch = this.watchSignature(signature);
    try {
      await this.connection.sendRawTransaction(raw, {
        maxRetries: 0,
        preflightCommitment: "confirmed",
      });
    } catch (cause) {
      watch.cancel();
      throw cause;
    }
    await this.confirm(raw, signature, watch, lastValidBlockHeight);
  }

  /**
   * Simulates `instructions` under a generous compute-unit limit, then
   * answers with `ceil(unitsConsumed × COMPUTE_UNIT_MARGIN)` (ticket 04,
   * research/report.md "Landing a transaction is a local auction"): the
   * priority fee is charged against the requested limit, not what a
   * transaction actually uses, so simulating first is what lets `send` stop
   * paying for the runtime's 200k-per-instruction default.
   *
   * A simulation that fails inside the program (a custom error code, such
   * as `NothingToHarvest`) is deterministic: preflight would refuse the same
   * bytes, so it throws through `mapSendError` and `send` never goes to the
   * wire. Any other failure (RPC hiccup, no `unitsConsumed`) is logged once
   * and answered with `undefined`, so `send` still lands the transaction
   * without a limit instruction, same as before this ticket.
   */
  private async computeUnitLimit(
    instructions: TransactionInstruction[],
    payer: PublicKey,
    blockhash: string,
    lastValidBlockHeight: number,
    lookupTables: readonly AddressLookupTableAccount[] = [],
  ): Promise<number | undefined> {
    const generousLimit = ComputeBudgetProgram.setComputeUnitLimit({
      units: MAX_COMPUTE_UNIT_LIMIT,
    });
    try {
      const { value } =
        lookupTables.length > 0
          ? await this.connection.simulateTransaction(
              new VersionedTransaction(
                new TransactionMessage({
                  payerKey: payer,
                  recentBlockhash: blockhash,
                  instructions: [generousLimit, ...instructions],
                }).compileToV0Message([...lookupTables]),
              ),
              { sigVerify: false },
            )
          : await this.connection.simulateTransaction(
              new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer }).add(
                generousLimit,
                ...instructions,
              ),
            );
      const code = customErrorCode(value.err);
      if (code !== undefined) {
        // Carries the program's logs (how `mapSendError` names an Anchor
        // error) and the code (its fallback when the RPC returned none).
        throw Object.assign(new Error(JSON.stringify(value.err)), {
          code,
          logs: value.logs ?? undefined,
        });
      }
      if (value.err || value.unitsConsumed === undefined) {
        throw new Error(
          value.err ? JSON.stringify(value.err) : "simulation reported no unitsConsumed",
        );
      }
      return Math.ceil(value.unitsConsumed * COMPUTE_UNIT_MARGIN);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause) throw cause;
      this.logger.warn(
        `simulate failed, sending without a compute limit: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Confirms `signature` off a subscription instead of polling block height
   * once a second (ticket 04, spec.md "transaction confirmation to come from
   * a subscription rather than a block-height poll"): web3.js's own
   * `confirmTransaction`, given a blockhash strategy, races that very poll
   * against the subscription, so it pays for it even on the happy path.
   * While waiting, the identical `raw` bytes are rebroadcast every
   * `REBROADCAST_INTERVAL_MS` with `skipPreflight: true` (production-
   * hardening ticket 04): the RPC node's own retry queue (`maxRetries`,
   * unset before this ticket) is not trusted to land it, so this owns
   * resending instead. It never re-signs — the bytes on the wire never
   * change, only how many times they are sent.
   *
   * Bounded by `CONFIRM_TIMEOUT_MS`. Past it, one `getSignatureStatuses` plus
   * one `getBlockHeight` decide pending (the blockhash has not expired yet)
   * from expired, so a dropped send still surfaces as an error rather than a
   * hang, which is the property the block-height strategy used to provide.
   */
  private async confirm(
    raw: Uint8Array,
    signature: string,
    watch: { result: Promise<SignatureResult | "timeout">; cancel: () => void },
    lastValidBlockHeight: number,
  ): Promise<void> {
    const rebroadcast = setInterval(() => {
      void this.connection
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
        .catch(() => {
          // The signature subscription and the fallback below decide the
          // outcome; a resend failing (already landed, blockhash expired) is
          // not this loop's problem to report.
        });
    }, REBROADCAST_INTERVAL_MS);
    let result: SignatureResult | "timeout";
    try {
      result = await watch.result;
    } finally {
      clearInterval(rebroadcast);
    }
    if (result !== "timeout") {
      if (result.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(result.err)}`,
        );
      }
      return;
    }
    // The subscription itself may have dropped without web3.js noticing yet
    // (it resubscribes on reconnect, but that misses a notification already
    // in flight when the socket closed), so ask directly before giving up.
    const [status] = (await this.connection.getSignatureStatuses([signature])).value;
    if (status) {
      if (status.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
      }
      return;
    }
    const blockHeight = await this.connection.getBlockHeight("confirmed");
    if (blockHeight > lastValidBlockHeight) {
      throw new Error(
        `transaction ${signature} expired: block height ${blockHeight} passed the blockhash's last valid height ${lastValidBlockHeight}`,
      );
    }
    throw new Error(
      `transaction ${signature} still pending after ${CONFIRM_TIMEOUT_MS}ms; the blockhash has not expired yet`,
    );
  }

  /** One-shot wait for `signature` to reach "confirmed", or `"timeout"` past
   *  `CONFIRM_TIMEOUT_MS` or on `cancel`. web3.js drops a signature listener
   *  itself once it fires, so only the timeout and cancel paths remove it. */
  private watchSignature(signature: string): {
    result: Promise<SignatureResult | "timeout">;
    cancel: () => void;
  } {
    let resolve!: (value: SignatureResult | "timeout") => void;
    const result = new Promise<SignatureResult | "timeout">((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => stop(), CONFIRM_TIMEOUT_MS);
    const subscriptionId = this.connection.onSignature(
      signature,
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      "confirmed",
    );
    const stop = () => {
      clearTimeout(timer);
      void this.connection.removeSignatureListener(subscriptionId);
      resolve("timeout");
    };
    return { result, cancel: stop };
  }

  /** Anchor's own logs already name the error; fall back to the IDL's error table. */
  mapSendError(cause: unknown): Error {
    const translated = translateError(cause, this.idlErrorMessages);
    if (translated instanceof AnchorError) {
      return new Error(translated.error.errorCode.code, { cause });
    }
    const code = (translated as { code?: number } | undefined)?.code;
    const name = code !== undefined ? this.errorNames.get(code) : undefined;
    if (name) return new Error(name, { cause });
    return translated instanceof Error
      ? translated
      : new Error(String(translated), { cause });
  }

  /**
   * The microlamport price `send` attaches (ticket 10), over `writable`.
   * Prefers Helius's own `getPriorityFeeEstimate` (production-hardening
   * ticket 04, research/report.md "Landing a transaction is a local
   * auction"), a percentile estimate scoped to the accounts a transaction
   * actually writes; falls back to the 75th percentile of
   * `getRecentPrioritizationFees`'s samples when the endpoint is not Helius
   * or the call fails. Either way, capped at `PRIORITY_FEE_MAX_MICROLAMPORTS`.
   *
   * Cached per exact writable-account set for `PRIORITY_FEE_TTL_MS`. Public
   * (ticket 08 needs this for the pool's hot accounts, over `/state`), and a
   * failed read still falls back to 0 rather than blocking or failing the
   * send; congestion pricing is best-effort, landing the transaction is not.
   */
  priorityFeeMicroLamports(writable: PublicKey[]): Promise<number> {
    const key = writable.map((pubkey) => pubkey.toBase58()).sort().join(",");
    const cached = this.priorityFeeCache.get(key);
    if (cached && Date.now() - cached.at <= PRIORITY_FEE_TTL_MS) return cached.result;
    const result = this.estimatePriorityFee(writable);
    this.priorityFeeCache.set(key, { at: Date.now(), result });
    return result;
  }

  private async estimatePriorityFee(writable: PublicKey[]): Promise<number> {
    const helius = await heliusPriorityFeeEstimate(
      // SAFETY: `_rpcRequest` is web3.js's own private JSON-RPC transport,
      // the same one `indexer.service.ts`'s `programAccountsPage` reaches
      // into for `getProgramAccountsV2`.
      this.connection as unknown as RpcRequester,
      writable,
      this.priorityFeeMaxMicroLamports,
    );
    if (helius !== undefined) return helius;
    return this.connection
      .getRecentPrioritizationFees(
        writable.length > 0 ? { lockedWritableAccounts: writable } : undefined,
      )
      .then((samples) =>
        p75PriorityFeeMicroLamports(
          samples.map((sample) => sample.prioritizationFee),
          this.priorityFeeMaxMicroLamports,
        ),
      )
      .catch(() => 0);
  }
}

/** The program's own error code inside a simulation's `err`, when it is one:
 *  `{ InstructionError: [index, { Custom: code }] }`. Anything else (a
 *  runtime error, an RPC shape, null) answers undefined. */
function customErrorCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return undefined;
  const inner = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(inner)) return undefined;
  const detail: unknown = inner[1];
  if (typeof detail !== "object" || detail === null || !("Custom" in detail)) return undefined;
  const code = (detail as { Custom: unknown }).Custom;
  return typeof code === "number" ? code : undefined;
}

/** Every writable account across `instructions`, deduplicated — the account
 *  set `send` prices its priority fee against (ticket 10). */
function writableAccountsOf(instructions: TransactionInstruction[]): PublicKey[] {
  const writable = new Map<string, PublicKey>();
  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) writable.set(key.pubkey.toBase58(), key.pubkey);
    }
  }
  return [...writable.values()];
}
