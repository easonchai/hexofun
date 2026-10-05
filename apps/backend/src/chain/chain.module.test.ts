import type { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../config/config.module";
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  DEFAULT_PROGRAM_ID,
  type HexVaultEnv,
} from "../config/env";
import { CountingConnection } from "../test-utils/counting-connection";
import { ChainModule } from "./chain.module";
import {
  CONFIRM_TIMEOUT_MS,
  ChainService,
  REBROADCAST_INTERVAL_MS,
  SOLANA_CONNECTION,
} from "./chain.service";
import { poolAddress } from "./pda";

describe("ChainModule", () => {
  let chain: ChainService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ChainModule],
    })
      .overrideProvider(SOLANA_CONNECTION)
      .useValue({}) // fake connection: nothing in this ticket calls it
      .compile();

    chain = moduleRef.get(ChainService);
  });

  it("derives the Pool PDA for POOL_ID", () => {
    const expected = poolAddress(new PublicKey(DEFAULT_PROGRAM_ID), 1n);
    expect(chain.poolAddress().equals(expected)).toBe(true);
  });

  it("names an Anchor error from its program logs", () => {
    const fakeSendFailure = {
      logs: [
        "Program log: AnchorError thrown in lib.rs:100. Error Code: InvalidTileSelection. Error Number: 6000. Error Message: Invalid tile selection.",
      ],
    };
    expect(chain.mapSendError(fakeSendFailure).message).toBe(
      "InvalidTileSelection",
    );
  });
});

// Ticket 04: confirmation moves from the block-height poll to a signature
// subscription, bounded so a dropped send still surfaces as an error.
describe("ChainService.send", () => {
  // A single no-op instruction: `Transaction.add()` refuses zero
  // instructions, and nothing here needs it to do anything real, since
  // `getLatestBlockhash`/`sendRawTransaction`/confirmation are all faked.
  const noop = [new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) })];

  function chainWith(connection: CountingConnection): ChainService {
    const env: Partial<HexVaultEnv> = {
      OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
      POOL_ID: "1",
      PROGRAM_ID: DEFAULT_PROGRAM_ID,
      PRIORITY_FEE_MAX_MICROLAMPORTS: DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
    };
    // SAFETY: ChainService only reads those four keys through `get`.
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    return new ChainService(connection as unknown as Connection, config);
  }

  it("confirms off the signature subscription: two RPC calls, no block-height polling", async () => {
    const connection = new CountingConnection();
    const chain = chainWith(connection);

    // The fake only notifies listeners open when the transaction lands, so
    // this resolving at all (real timers, no 30 s wait) proves the
    // subscription opened before the send.
    const signature = await chain.send(noop);

    expect(connection.lastParams("onSignature")).toEqual([signature]);
    expect(connection.callsTo("getLatestBlockhash")).toBe(1);
    expect(connection.callsTo("sendRawTransaction")).toBe(1);
    // The two calls above are the whole cost of a confirmed send; the
    // subscription notification is a push, not a poll.
    expect(connection.callsTo("getSignatureStatuses")).toBe(0);
    expect(connection.callsTo("getBlockHeight")).toBe(0);
  });

  it("a still-live blockhash after the bounded wait reads as pending, not failed", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false; // the subscription never fires
      connection.blockHeight = connection.slot; // well under lastValidBlockHeight
      const chain = chainWith(connection);

      // The assertion attaches its rejection handler before the timer fires
      // (`advanceTimersByTimeAsync` below), so the rejection is never briefly
      // unhandled between the two `await`s.
      const rejected = expect(chain.send(noop)).rejects.toThrow(/still pending/);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await rejected;

      // The bounded fallback: one status query, one block-height read.
      expect(connection.callsTo("getSignatureStatuses")).toBe(1);
      expect(connection.callsTo("getBlockHeight")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a block height past the blockhash's last valid height surfaces as expired, never a hang", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false;
      connection.blockHeight = connection.slot + 1_000; // past lastValidBlockHeight
      const chain = chainWith(connection);

      const rejected = expect(chain.send(noop)).rejects.toThrow(/expired/);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a status query that finds the transaction landed after all still succeeds", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false; // subscription missed it
      connection.signatureStatus = { err: null }; // but it landed clean
      const chain = chainWith(connection);

      const sent = chain.send(noop);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await expect(sent).resolves.toBe(connection.lastParams("onSignature")?.[0]);
      expect(connection.callsTo("getBlockHeight")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Production-hardening ticket 04: rebroadcasts the identical signed bytes
  // every REBROADCAST_INTERVAL_MS while waiting for confirmation, instead of
  // trusting the RPC node's own retry queue.
  it("lands once a resend gets through, after the first two sends are dropped", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      // Call 1 (the initial send) and call 2 (the first rebroadcast, at
      // t=2s) are dropped; call 3 (the second rebroadcast, at t=4s) lands.
      connection.dropSendsBeforeCall = 2;
      const chain = chainWith(connection);

      const sent = chain.send(noop);
      await vi.advanceTimersByTimeAsync(REBROADCAST_INTERVAL_MS * 2 + 50);

      await expect(sent).resolves.toBeDefined();
      expect(connection.callsTo("sendRawTransaction")).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // Production-hardening ticket 04: the compute-unit limit comes from
  // simulating first, not the runtime's 200k-per-instruction default.
  describe("compute unit limit", () => {
    /** The compute-budget limit instruction `send` put on the wire, or
     *  undefined when simulation failed and none was prepended. */
    function sentComputeLimit(connection: CountingConnection): number | undefined {
      const raw = connection.lastParams("sendRawTransaction")?.[0] as Buffer;
      const maybeLimitIx = Transaction.from(raw).instructions[1];
      if (
        !maybeLimitIx ||
        !maybeLimitIx.programId.equals(ComputeBudgetProgram.programId)
      ) {
        return undefined;
      }
      return Number(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(maybeLimitIx).units,
      );
    }

    it("sizes the limit from the simulation, plus a 10% margin", async () => {
      const connection = new CountingConnection();
      connection.simulateUnitsConsumed = 10_000;
      const chain = chainWith(connection);

      await chain.send(noop);

      expect(connection.callsTo("simulateTransaction")).toBe(1);
      expect(sentComputeLimit(connection)).toBe(11_000); // ceil(10_000 * 1.1)
    });

    it("sends without a limit when simulation fails, same as before this ticket", async () => {
      const connection = new CountingConnection();
      connection.simulateError = { InstructionError: [0, "ProgramFailedToComplete"] };
      const chain = chainWith(connection);

      await expect(chain.send(noop)).resolves.toBeDefined();

      expect(sentComputeLimit(connection)).toBeUndefined();
    });

    // A program error in simulation is deterministic: preflight would refuse
    // the same bytes, so `send` throws the named error without going to the
    // wire (seen as a daily NothingToHarvest warning in the operator log).
    it("throws the program's named error when simulation fails inside the program", async () => {
      const connection = new CountingConnection();
      connection.simulateError = { InstructionError: [1, { Custom: 6071 }] };
      const chain = chainWith(connection);

      await expect(chain.send(noop)).rejects.toThrow("NothingToHarvest");

      expect(connection.callsTo("sendRawTransaction")).toBe(0);
    });
  });

  // Ticket 10: every send prepends a priority fee, priced off
  // getRecentPrioritizationFees over the transaction's own writable accounts.
  // Production-hardening ticket 04: the fee now prefers Helius's own
  // `getPriorityFeeEstimate`, over `getRecentPrioritizationFees`'s floor.
  // Every test below leaves `priorityFeeEstimateMicroLamports` unset, so
  // Helius answers "method not found" and each one also proves the fallback.
  describe("priority fee", () => {
    /** The compute-budget instruction `send` actually put on the wire, decoded
     *  from the raw bytes handed to `sendRawTransaction`. */
    function sentPriceInstruction(connection: CountingConnection): number {
      const raw = connection.lastParams("sendRawTransaction")?.[0] as Buffer;
      const priceIx = Transaction.from(raw).instructions[0];
      // SAFETY: `send` always prepends the compute-budget instruction, so a
      // transaction it built always has at least this one.
      return Number(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(priceIx as TransactionInstruction)
          .microLamports,
      );
    }

    it("prices the fee at the 75th percentile of the writable accounts' recent samples", async () => {
      const connection = new CountingConnection();
      connection.prioritizationFees = [100, 400, 200, 300].map((prioritizationFee, i) => ({
        slot: i,
        prioritizationFee,
      }));
      const chain = chainWith(connection);
      const writable = Keypair.generate().publicKey;
      const ix = new TransactionInstruction({
        programId: PublicKey.default,
        keys: [{ pubkey: writable, isSigner: false, isWritable: true }],
        data: Buffer.alloc(0),
      });

      await chain.send([ix]);

      expect(connection.lastParams("getRecentPrioritizationFees")).toEqual([writable]);
      expect(sentPriceInstruction(connection)).toBe(300);
    });

    it("caps the fee at PRIORITY_FEE_MAX_MICROLAMPORTS", async () => {
      const connection = new CountingConnection();
      connection.prioritizationFees = [
        { slot: 0, prioritizationFee: DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS + 10_000 },
      ];
      const chain = chainWith(connection);

      await chain.send(noop);

      expect(sentPriceInstruction(connection)).toBe(DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS);
    });

    it("prices at 0 with no samples, rather than failing the send", async () => {
      const connection = new CountingConnection();
      const chain = chainWith(connection);

      await chain.send(noop);

      expect(sentPriceInstruction(connection)).toBe(0);
    });

    it("caches the fee per writable-account set, so a burst of sends costs one read", async () => {
      const connection = new CountingConnection();
      connection.prioritizationFees = [{ slot: 0, prioritizationFee: 500 }];
      const chain = chainWith(connection);

      await chain.send(noop);
      await chain.send(noop);

      expect(connection.callsTo("getRecentPrioritizationFees")).toBe(1);
    });

    it("prefers the Helius estimate over the p75 fallback when it is available", async () => {
      const connection = new CountingConnection();
      connection.priorityFeeEstimateMicroLamports = 4_200;
      // Would win if the fallback ran instead: proves Helius short-circuits it.
      connection.prioritizationFees = [{ slot: 0, prioritizationFee: 999_999 }];
      const chain = chainWith(connection);

      await chain.send(noop);

      expect(sentPriceInstruction(connection)).toBe(4_200);
      expect(connection.callsTo("getRecentPrioritizationFees")).toBe(0);
    });

    it("caps the Helius estimate at PRIORITY_FEE_MAX_MICROLAMPORTS too", async () => {
      const connection = new CountingConnection();
      connection.priorityFeeEstimateMicroLamports =
        DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS + 10_000;
      const chain = chainWith(connection);

      await chain.send(noop);

      expect(sentPriceInstruction(connection)).toBe(DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS);
    });
  });
});
