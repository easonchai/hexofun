/**
 * Ticket 08 (production-hardening): `sendMany`'s own behavior, stubbed at
 * `program.provider.connection` and `.wallet` — no network, no real Program.
 * The exported action functions (`deposit`, `buyTickets`, ...) are thin
 * builders on top of this and stay untested here; `sendMany` is where the
 * compute-budget, signing and confirmation logic actually lives.
 */
import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { awaitSendResult, resolveUnknownSend, sendMany, type SendResult } from "./actions.js";
import type { HexVaultProgram } from "./chain.js";

const BLOCKHASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LAST_VALID_BLOCK_HEIGHT = 1_000;
const FEE_MICROLAMPORTS = 4_242;

/** One real, harmless instruction: a zero-lamport self-transfer. What it does
 *  never matters here — only that `sendMany` carries it through unmodified. */
function realInstruction(payer: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 });
}

interface FakeConnectionOptions {
  simulate?: () => Promise<{ value: { err: unknown; unitsConsumed?: number; logs?: string[] } }>;
  confirm?: () => Promise<{ value: { err: unknown } }>;
  sendRawTransaction?: () => Promise<string>;
  signatureStatuses?: () => Promise<{ value: (SignatureStatus | null)[] }>;
  blockHeight?: () => Promise<number>;
}

interface SignatureStatus {
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

/** The `Connection` methods `sendMany` and `resolveUnknownSend` call, nothing
 *  else — see `SendProvider` in actions.ts for why a stub needs no more than
 *  this. */
function fakeConnection(options: FakeConnectionOptions = {}): Connection {
  return {
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    }),
    simulateTransaction:
      options.simulate ?? (async () => ({ value: { err: null, unitsConsumed: 100_000 } })),
    sendRawTransaction: options.sendRawTransaction ?? (async () => "fake-signature"),
    confirmTransaction: options.confirm ?? (async () => ({ value: { err: null } })),
    getSignatureStatuses: options.signatureStatuses ?? (async () => ({ value: [null] })),
    getBlockHeight: options.blockHeight ?? (async () => 0),
  } as unknown as Connection;
}

/** Signs with a real `Keypair` (so `.serialize()` after it succeeds, the same
 *  as a real wallet's `signTransaction`) and records the built transaction
 *  for the caller to inspect. */
function fakeWallet(signer: Keypair, captured: { tx: Transaction | null }) {
  return {
    signTransaction: async <T,>(tx: T): Promise<T> => {
      captured.tx = tx as unknown as Transaction;
      (tx as unknown as Transaction).sign(signer);
      return tx;
    },
  };
}

function fakeProgram(
  connection: Connection,
  wallet: ReturnType<typeof fakeWallet>,
): HexVaultProgram {
  return { provider: { connection, wallet } } as unknown as HexVaultProgram;
}

describe("sendMany", () => {
  it("prepends a priced compute-unit-price and a simulation-sized compute-unit-limit instruction", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({
      simulate: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
    });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "fake-signature" });
    const instructions = captured.tx?.instructions ?? [];
    expect(instructions).toHaveLength(3);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[0]!)).toEqual({
      microLamports: BigInt(FEE_MICROLAMPORTS),
    });
    // Math.ceil(100_000 × 1.1) — the simulation's unitsConsumed times the
    // margin (chain.service.ts's backend counterpart uses the same 1.1).
    // 110_001, not 110_000: 100_000 × 1.1 lands a hair over in floating
    // point, and ceil takes the hair with it — same as the backend's.
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[1]!)).toEqual({
      units: 110_001,
    });
  });

  it("falls back to a per-instruction compute limit when simulation throws", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({
      simulate: async () => {
        throw new Error("simulated RPC hiccup");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey), realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result.kind).toBe("landed");
    const instructions = captured.tx?.instructions ?? [];
    // Two real instructions: 200_000 CUs each (solana.com's per-instruction
    // runtime default), the fallback when a simulation can't be trusted.
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[1]!)).toEqual({
      units: 400_000,
    });
  });

  it("maps a clean confirmation to landed", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({ confirm: async () => ({ value: { err: null } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "fake-signature" });
  });

  it("maps a blockhash-expiry confirm error to expired", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "expired" });
  });

  it("maps a landed-but-failed confirmation to failed with the decoded Custom code", async () => {
    const signer = Keypair.generate();
    const err = { InstructionError: [0, { Custom: 6012 }] };
    const connection = fakeConnection({ confirm: async () => ({ value: { err } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "failed",
      code: 6012,
      message: JSON.stringify(err),
    });
  });

  it("maps a failure with no Custom code to failed with a null code", async () => {
    const signer = Keypair.generate();
    const err = "AccountInUse";
    const connection = fakeConnection({ confirm: async () => ({ value: { err } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "failed",
      code: null,
      message: JSON.stringify(err),
    });
  });

  it("confirms the Privy sponsored path's signature instead of returning as soon as it sends", async () => {
    // No `provider.wallet` needed on this path — `owner.sendTransaction`
    // stands in for Privy's own sign-and-broadcast.
    const signer = Keypair.generate();
    const connection = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("privy-signature");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      {
        publicKey: signer.publicKey,
        sendTransaction: async () => "privy-signature",
      },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    // Had this path returned the moment `sendTransaction` resolved, the
    // result would be `landed`; it is `expired` because confirm ran too.
    expect(result).toEqual<SendResult>({ kind: "expired" });
  });

  it("ticket 15: maps a confirm failure that is not an expiry to unknown, carrying the signature", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({
      confirm: async () => {
        throw new Error("fetch failed");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "unknown",
      signature: "fake-signature",
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    });
  });

  it("ticket 15: a simulation that runs but reports a program error fails before anything signs", async () => {
    const signer = Keypair.generate();
    let signed = false;
    const err = { InstructionError: [0, { Custom: 6003 }] };
    const connection = fakeConnection({
      simulate: async () => ({ value: { err, unitsConsumed: 100_000 } }),
    });
    const wallet = {
      signTransaction: async <T,>(tx: T): Promise<T> => {
        signed = true;
        return tx;
      },
    };
    const program = { provider: { connection, wallet } } as unknown as HexVaultProgram;

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "failed", code: 6003, message: JSON.stringify(err) });
    expect(signed).toBe(false);
  });

  // A first deposit from a Privy embedded wallet with no SOL: our simulation
  // runs with the wallet as payer and fails opening the Player account, but
  // Privy's sponsored send tops the wallet up by that rent on chain.
  const SHORT_OF_RENT = {
    err: { InstructionError: [2, { Custom: 1 }] },
    unitsConsumed: 20_000,
    logs: [
      "Program 11111111111111111111111111111111 invoke [2]",
      "Transfer: insufficient lamports 1102360, need 2250440",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    ],
  };

  it("a sponsored send short only of rent still goes to Privy, on the fallback compute limit", async () => {
    const signer = Keypair.generate();
    const sent: Transaction[] = [];
    const connection = fakeConnection({ simulate: async () => ({ value: SHORT_OF_RENT }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      {
        publicKey: signer.publicKey,
        sendTransaction: async (tx) => {
          sent.push(tx);
          return "sponsored-signature";
        },
      },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "sponsored-signature" });
    expect(sent).toHaveLength(1);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(sent[0]!.instructions[1]!)).toEqual({
      units: 200_000,
    });
  });

  it("a sponsored send from a wallet with 0 SOL, which has no account yet, still goes to Privy", async () => {
    const signer = Keypair.generate();
    const sent: Transaction[] = [];
    // The runtime's answer when the fee payer has never held lamports: no
    // instruction runs, so there are no logs to read.
    const connection = fakeConnection({ simulate: async () => ({ value: { err: "AccountNotFound" } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      {
        publicKey: signer.publicKey,
        sendTransaction: async (tx) => {
          sent.push(tx);
          return "sponsored-signature";
        },
      },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "sponsored-signature" });
    expect(sent).toHaveLength(1);
  });

  it("an unsponsored send from a wallet with 0 SOL fails before anything signs", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({ simulate: async () => ({ value: { err: "AccountNotFound" } }) });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "failed", code: null, message: '"AccountNotFound"' });
    expect(captured.tx).toBeNull();
  });

  it("an unsponsored send short of rent fails before anything signs", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({ simulate: async () => ({ value: SHORT_OF_RENT }) });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "failed",
      code: 1,
      message: JSON.stringify(SHORT_OF_RENT.err),
    });
    expect(captured.tx).toBeNull();
  });

  it("a sponsored send with a real program error still fails before Privy sees it", async () => {
    const signer = Keypair.generate();
    let sent = false;
    const err = { InstructionError: [2, { Custom: 6003 }] };
    const connection = fakeConnection({
      simulate: async () => ({ value: { err, unitsConsumed: 20_000, logs: ["Program log: AnchorError"] } }),
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      {
        publicKey: signer.publicKey,
        sendTransaction: async () => {
          sent = true;
          return "sponsored-signature";
        },
      },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "failed", code: 6003, message: JSON.stringify(err) });
    expect(sent).toBe(false);
  });
});

describe("resolveUnknownSend", () => {
  it("resolves to landed once the signature confirms", async () => {
    const connection = fakeConnection({
      signatureStatuses: async () => ({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      }),
    });

    const result = await resolveUnknownSend(connection, "sig", LAST_VALID_BLOCK_HEIGHT, 0);

    expect(result).toEqual({ kind: "landed", signature: "sig" });
  });

  it("resolves to failed with the decoded code once the signature lands with an on-chain error", async () => {
    const err = { InstructionError: [0, { Custom: 6012 }] };
    const connection = fakeConnection({
      signatureStatuses: async () => ({
        value: [{ err, confirmationStatus: "confirmed" }],
      }),
    });

    const result = await resolveUnknownSend(connection, "sig", LAST_VALID_BLOCK_HEIGHT, 0);

    expect(result).toEqual({ kind: "failed", code: 6012, message: JSON.stringify(err) });
  });

  it("resolves to expired once the blockhash's lastValidBlockHeight passes with no status yet", async () => {
    const connection = fakeConnection({
      signatureStatuses: async () => ({ value: [null] }),
      blockHeight: async () => LAST_VALID_BLOCK_HEIGHT + 1,
    });

    const result = await resolveUnknownSend(connection, "sig", LAST_VALID_BLOCK_HEIGHT, 0);

    expect(result).toEqual({ kind: "expired" });
  });

  it("keeps polling while the signature is unseen and the blockhash is still valid", async () => {
    let calls = 0;
    const connection = fakeConnection({
      signatureStatuses: async () => {
        calls += 1;
        return {
          value: [calls < 3 ? null : { err: null, confirmationStatus: "confirmed" }],
        };
      },
      blockHeight: async () => LAST_VALID_BLOCK_HEIGHT - 1,
    });

    const result = await resolveUnknownSend(connection, "sig", LAST_VALID_BLOCK_HEIGHT, 0);

    expect(calls).toBe(3);
    expect(result).toEqual({ kind: "landed", signature: "sig" });
  });
});

describe("awaitSendResult", () => {
  it("passes a landed/expired/failed result through unchanged", async () => {
    const program = { provider: { connection: fakeConnection() } } as unknown as HexVaultProgram;
    const landed: SendResult = { kind: "landed", signature: "sig" };

    expect(await awaitSendResult(program, landed)).toEqual(landed);
  });

  it("resolves an unknown result through the same connection the send used", async () => {
    const connection = fakeConnection({
      signatureStatuses: async () => ({
        value: [{ err: null, confirmationStatus: "finalized" }],
      }),
    });
    const program = { provider: { connection } } as unknown as HexVaultProgram;
    const unknown: SendResult = {
      kind: "unknown",
      signature: "sig",
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    };

    expect(await awaitSendResult(program, unknown)).toEqual({ kind: "landed", signature: "sig" });
  });
});
