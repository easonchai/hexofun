/**
 * `safePriorityFee` (ticket 08, production-hardening): `/state` is
 * unauthenticated input, so this is the one gate between whatever a
 * compromised or misbehaving backend sends and a signature.
 */
import { describe, expect, it } from "vitest";

import { isMissingTokenAccount, MIN_SOL_LAMPORTS, safePriorityFee, solRentWarning } from "./read.js";

const FLOOR = 1_000;
const CEILING = 50_000;

describe("safePriorityFee", () => {
  it("passes an ordinary estimate through unchanged", () => {
    expect(safePriorityFee(4_242)).toBe(4_242);
  });

  it("floors a zero or missing estimate instead of signing with no fee", () => {
    expect(safePriorityFee(0)).toBe(FLOOR);
  });

  it("caps an estimate above the ceiling, whatever the backend sent", () => {
    expect(safePriorityFee(1_000_000)).toBe(CEILING);
  });

  it("floors a negative number rather than trusting it", () => {
    expect(safePriorityFee(-5)).toBe(FLOOR);
  });

  it("floors a non-integer number rather than trusting it", () => {
    expect(safePriorityFee(1_234.5)).toBe(FLOOR);
  });

  it("floors NaN and Infinity rather than trusting them", () => {
    expect(safePriorityFee(Number.NaN)).toBe(FLOOR);
    expect(safePriorityFee(Number.POSITIVE_INFINITY)).toBe(FLOOR);
  });

  it("floors a non-number value a malformed response could send", () => {
    // `/state` is parsed with no runtime schema (api.ts), so the wire value
    // can disagree with StateDto's declared `number` type.
    expect(safePriorityFee(undefined as unknown as number)).toBe(FLOOR);
    expect(safePriorityFee("4242" as unknown as number)).toBe(FLOOR);
  });
});

describe("isMissingTokenAccount", () => {
  it("treats the RPC's missing-account message as a real zero balance", () => {
    expect(
      isMissingTokenAccount(
        new Error("failed to get token account balance: could not find account"),
      ),
    ).toBe(true);
  });

  it("treats Surfpool's missing-account message as a real zero balance", () => {
    expect(
      isMissingTokenAccount(
        new Error(
          "failed to get token account balance: Account 25y3UAQcpu1jocbidRRcdWErSz7drFDwS4xtbtrVirow not found",
        ),
      ),
    ).toBe(true);
  });

  it("treats any other failure as unknown, not zero", () => {
    expect(isMissingTokenAccount(new Error("fetch failed"))).toBe(false);
    expect(isMissingTokenAccount(new Error("429 Too Many Requests"))).toBe(false);
  });
});

const UNSPONSORED = { sponsored: false };

describe("solRentWarning", () => {
  it("says nothing for a Privy-sponsored wallet, whose send covers rent", () => {
    expect(solRentWarning(0n, { sponsored: true })).toBeNull();
  });

  it("warns naming the amount when SOL is below the rent floor", () => {
    const warning = solRentWarning(0n, UNSPONSORED);
    expect(warning).toContain("SOL");
    expect(warning).toMatch(/0\.003/);
  });

  it("says nothing once the wallet covers the floor", () => {
    expect(solRentWarning(MIN_SOL_LAMPORTS, UNSPONSORED)).toBeNull();
    expect(solRentWarning(MIN_SOL_LAMPORTS + 1n, UNSPONSORED)).toBeNull();
  });

  it("says nothing while the balance is still unknown", () => {
    expect(solRentWarning(null, UNSPONSORED)).toBeNull();
  });
});
