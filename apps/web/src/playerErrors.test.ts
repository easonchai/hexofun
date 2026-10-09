import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BET_REFUSALS } from "./bet.js";
import {
  decodeBetRefusal,
  decodeErrorCode,
  decodePlayerError,
  decodeSendFailure,
  NOTHING_PENDING_CODE,
} from "./playerErrors.js";

beforeEach(() => {
  // Every path under test logs the raw error; keep it out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // decodeSendFailure posts an error report to VITE_API_URL, which in a
  // checkout is a live local backend; keep test failures out of its table.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("decodeErrorCode", () => {
  it.each([
    [6001, "The pool is paused right now. Try again once it reopens."], // PoolPaused
    [6003, "Enter an amount greater than zero."], // ZeroAmount
    [6005, "You don't have enough Tickets for that."], // InsufficientEntries
    [6012, "This round is closed to new plays. Wait for the next one."], // RoundClosed
    [6088, "This round is closed to new plays. Wait for the next one."], // RoundEpochNotCurrent
    [6085, "This round would end after the day does. Wait for the new day's first round."], // RoundStraddlesEpoch
    [
      6036,
      "The vault is being topped up. Try the payout again in a few minutes.",
    ], // InsufficientVaultLiquidity
    [NOTHING_PENDING_CODE, "Already paid out. Refreshing your balance."], // NothingPending
    [6051, "This pool is closed. Withdrawals still work; nothing else does."], // PoolShutDown
    [
      6058,
      "The game is paused right now. Try again once it restarts.",
    ], // GamePaused
    [
      6059,
      "The daily draw is paused, so Tickets can't be bought right now.",
    ], // JackpotPaused
    [
      6063,
      "The pool is short on cash and can't refund that deposit yet. Nothing changed on your account. Try again later.",
    ], // VenueIlliquid
  ])("has player copy for code %i", (code, copy) => {
    expect(decodeErrorCode(code)).toBe(copy);
  });

  it("falls back to the IDL's own message for a code with no hand-written copy", () => {
    // Unauthorized (6034): a real program code, never hand-written.
    expect(decodeErrorCode(6034)).toBe(
      "signer is not authorized for this instruction",
    );
  });

  it("falls back to a generic line for a code the IDL doesn't know either", () => {
    expect(decodeErrorCode(99_999)).toBe(
      "Something went wrong. Try again in a moment.",
    );
  });
});

describe("decodePlayerError", () => {
  it("decodes an AnchorError's 'Error Number: N' text", () => {
    const error = new Error(
      "AnchorError thrown in programs/hex_vault/src/custody.rs:120. Error Code: PoolPaused. Error Number: 6001. Error Message: the pool is paused.",
    );
    expect(decodePlayerError(error)).toBe(
      "The pool is paused right now. Try again once it reopens.",
    );
  });

  it("decodes a simulation result's '\"Custom\":N' shape", () => {
    const error = new Error(
      '{"err":{"InstructionError":[0,{"Custom":6036}]}}',
    );
    expect(decodePlayerError(error)).toBe(
      "The vault is being topped up. Try the payout again in a few minutes.",
    );
  });

  it("decodes a bare 'custom program error: 0x...' hex code", () => {
    // 6012 (RoundClosed) in hex.
    const error = new Error(
      "failed to send transaction: custom program error: 0x177c",
    );
    expect(decodePlayerError(error)).toBe(
      "This round is closed to new plays. Wait for the next one.",
    );
  });

  it("falls back to the exact error name when no code number is present", () => {
    const error = new Error("simulation failed: RoundClosed");
    expect(decodePlayerError(error)).toBe(
      "This round is closed to new plays. Wait for the next one.",
    );
  });

  it("does not let a name match a longer name it's a prefix of", () => {
    // InsufficientVault (6054) must not steal InsufficientVaultLiquidity's (6036) text.
    const error = new Error("custom error: InsufficientVaultLiquidity");
    expect(decodePlayerError(error)).toBe(
      "The vault is being topped up. Try the payout again in a few minutes.",
    );
  });

  it("decodes the two feature-pause errors by name", () => {
    expect(decodePlayerError(new Error("simulation failed: GamePaused"))).toBe(
      "The game is paused right now. Try again once it restarts.",
    );
    expect(decodePlayerError(new Error("simulation failed: JackpotPaused"))).toBe(
      "The daily draw is paused, so Tickets can't be bought right now.",
    );
  });

  it("tells the player the refund failed and to try later, with no raw error", () => {
    const sent = decodeSendFailure({
      kind: "failed",
      code: 6063,
      message: '{"InstructionError":[2,{"Custom":6063}]}',
    });
    const thrown = decodePlayerError(
      new Error("AnchorError. Error Code: VenueIlliquid. Error Number: 6063. Error Message: x"),
    );
    for (const text of [sent, thrown]) {
      expect(text).toMatch(/refund that deposit/);
      expect(text).toMatch(/Try again later/);
      expect(text).not.toMatch(/6063|Custom|VenueIlliquid|Instruction/);
    }
  });

  it("falls back to a generic line for a non-program error", () => {
    expect(decodePlayerError(new Error("Failed to fetch"))).toBe(
      "Something went wrong. Try again in a moment.",
    );
  });

  it("handles a thrown non-Error value the same way", () => {
    expect(decodePlayerError("network down")).toBe(
      "Something went wrong. Try again in a moment.",
    );
  });

  it("still logs the raw error for debugging", () => {
    decodePlayerError(new Error("boom"));
    expect(console.error).toHaveBeenCalledWith("boom");
  });
});

describe("decodeBetRefusal", () => {
  const GENERIC = "Something went wrong. Try again in a moment.";

  it("has its own copy for every refusal the bet route names", () => {
    const lines = BET_REFUSALS.map((code) => decodeBetRefusal(code));
    expect(lines).not.toContain(GENERIC);
    expect(new Set(lines).size).toBe(BET_REFUSALS.length);
  });

  it("covers the web client's own throttle and network codes", () => {
    expect(decodeBetRefusal("Throttled")).toMatch(/too many bets/i);
    expect(decodeBetRefusal("network")).toMatch(/reach the server/i);
  });

  it("says the generic line for a code it does not know", () => {
    expect(decodeBetRefusal("http_500")).toBe(GENERIC);
  });
});
