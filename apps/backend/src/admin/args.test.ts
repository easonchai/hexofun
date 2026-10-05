import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { parseAdminCommand } from "./args";

describe("parseAdminCommand", () => {
  it("parses pause and unpause with no flags", () => {
    expect(parseAdminCommand(["pause"])).toEqual({ kind: "pause" });
    expect(parseAdminCommand(["unpause"])).toEqual({ kind: "unpause" });
  });

  it("parses the four feature pause commands with no flags", () => {
    for (const kind of ["pause-game", "pause-jackpot", "start-game", "start-jackpot"]) {
      expect(parseAdminCommand([kind])).toEqual({ kind });
    }
    expect(() => parseAdminCommand(["start-game", "now"])).toThrow(/unexpected argument/);
  });

  it("parses pause-deploy and start-deploy with no flags", () => {
    for (const kind of ["pause-deploy", "start-deploy"]) {
      expect(parseAdminCommand([kind])).toEqual({ kind });
    }
    expect(() => parseAdminCommand(["pause-deploy", "now"])).toThrow(/unexpected argument/);
  });

  it("rejects stray arguments to pause/unpause", () => {
    expect(() => parseAdminCommand(["pause", "now"])).toThrow(/unexpected argument/);
  });

  it("parses fund-jackpot's amount", () => {
    expect(parseAdminCommand(["fund-jackpot", "--amount", "50000000"])).toEqual({
      kind: "fund-jackpot",
      amount: 50_000_000n,
    });
  });

  it("rejects fund-jackpot without an amount, or a bad one", () => {
    expect(() => parseAdminCommand(["fund-jackpot"])).toThrow(/needs --amount/);
    // node:util parseArgs only accepts a "-"-leading value via "=" syntax;
    // see positiveBigInt's own check for the "-5" example without it.
    expect(() => parseAdminCommand(["fund-jackpot", "--amount=-5"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseAdminCommand(["fund-jackpot", "--amount", "1.5"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses grant-tickets' owner and amount", () => {
    const owner = Keypair.generate().publicKey;
    expect(
      parseAdminCommand([
        "grant-tickets",
        "--owner",
        owner.toBase58(),
        "--amount",
        "500",
      ]),
    ).toEqual({ kind: "grant-tickets", owner, amount: 500n });
  });

  it("rejects grant-tickets missing either flag, or a bad one", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    expect(() => parseAdminCommand(["grant-tickets", "--amount", "1"])).toThrow(
      /needs --owner/,
    );
    expect(() => parseAdminCommand(["grant-tickets", "--owner", owner])).toThrow(
      /needs --amount/,
    );
    expect(() =>
      parseAdminCommand(["grant-tickets", "--owner", "nope", "--amount", "1"]),
    ).toThrow(/base58 pubkey/);
    expect(() =>
      parseAdminCommand(["grant-tickets", "--owner", owner, "--amount=-1"]),
    ).toThrow(/positive whole number/);
  });

  it("parses only the set-params flags given", () => {
    expect(parseAdminCommand(["set-params", "--epoch-seconds", "900"])).toEqual({
      kind: "set-params",
      params: { epochSeconds: 900 },
    });
    expect(
      parseAdminCommand([
        "set-params",
        "--round-seconds",
        "20",
        "--close-buffer",
        "0",
      ]),
    ).toEqual({
      kind: "set-params",
      params: { roundSeconds: 20, closeBuffer: 0 },
    });
    expect(parseAdminCommand(["set-params", "--min-deposit", "0"])).toEqual({
      kind: "set-params",
      params: { minDeposit: 0n },
    });
    expect(
      parseAdminCommand(["set-params", "--house-cut-bps", "600"]),
    ).toEqual({
      kind: "set-params",
      params: { houseCutBps: 600 },
    });
  });

  it("rejects set-params with no flags at all", () => {
    expect(() => parseAdminCommand(["set-params"])).toThrow(/at least one flag/);
  });

  it("rejects out-of-range set-params values", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--epoch-seconds", "0"]),
    ).toThrow(/positive whole number/);
    expect(() =>
      parseAdminCommand(["set-params", "--close-buffer=-1"]),
    ).toThrow(/non-negative whole number/);
  });

  it("rejects a House cut rate above 10000", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--house-cut-bps", "10001"]),
    ).toThrow(/0 to 10000/);
    expect(() =>
      parseAdminCommand(["set-params", "--house-cut-bps=-1"]),
    ).toThrow(/0 to 10000/);
  });

  it("parses the base yield, bought and granted tickets flags (ticket 05)", () => {
    expect(
      parseAdminCommand([
        "set-params",
        "--base-rate-bps",
        "488",
        "--tickets-per-usdc",
        "10",
        "--bonus-cap-bps",
        "500",
      ]),
    ).toEqual({
      kind: "set-params",
      params: { baseRateBps: 488, ticketsPerUsdc: 10, bonusCapBps: 500 },
    });
  });

  it("rejects a base yield or bonus cap rate outside 0..=10000", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--base-rate-bps", "10001"]),
    ).toThrow(/0 to 10000/);
    expect(() =>
      parseAdminCommand(["set-params", "--bonus-cap-bps=-1"]),
    ).toThrow(/0 to 10000/);
  });

  it("rejects a tickets-per-usdc rate of zero or above a u16", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--tickets-per-usdc", "0"]),
    ).toThrow(/1 to 65535/);
    expect(() =>
      parseAdminCommand(["set-params", "--tickets-per-usdc", "65536"]),
    ).toThrow(/1 to 65535/);
  });

  it("parses the two flags ticket 10 added to the program", () => {
    expect(
      parseAdminCommand(["set-params", "--min-jackpot", "42", "--payout-timeout", "86400"]),
    ).toEqual({
      kind: "set-params",
      params: {
        minJackpot: 42_000_000n,
        payoutTimeout: 86_400,
      },
    });
  });

  it("rejects the registration window the program no longer has", () => {
    expect(() => parseAdminCommand(["set-params", "--registration-window", "600"])).toThrow();
  });

  it("rejects a payout timeout of zero", () => {
    expect(() => parseAdminCommand(["set-params", "--payout-timeout", "0"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses the two key commands and accept-admin", () => {
    const key = Keypair.generate().publicKey;
    expect(parseAdminCommand(["set-operator", "--key", key.toBase58()])).toEqual({
      kind: "set-operator",
      key,
    });
    expect(parseAdminCommand(["propose-admin", "--key", key.toBase58()])).toEqual({
      kind: "propose-admin",
      key,
    });
    expect(parseAdminCommand(["accept-admin"])).toEqual({ kind: "accept-admin" });
    expect(() => parseAdminCommand(["set-operator"])).toThrow(/needs --key/);
    expect(() => parseAdminCommand(["propose-admin", "--key", "nope"])).toThrow(
      /base58 pubkey/,
    );
    expect(() => parseAdminCommand(["accept-admin", "now"])).toThrow(
      /unexpected argument/,
    );
  });

  it("parses create-invite, owner and count optional", () => {
    expect(parseAdminCommand(["create-invite", "--max-uses", "5"])).toEqual({
      kind: "create-invite",
      maxUses: 5,
      count: 1,
    });
    const owner = Keypair.generate().publicKey;
    expect(
      parseAdminCommand([
        "create-invite",
        "--max-uses",
        "1",
        "--owner",
        owner.toBase58(),
        "--count",
        "3",
      ]),
    ).toEqual({
      kind: "create-invite",
      maxUses: 1,
      count: 3,
      owner,
    });
  });

  it("defaults create-invite's --max-uses to 1 when omitted (ticket 07)", () => {
    expect(parseAdminCommand(["create-invite"])).toEqual({
      kind: "create-invite",
      maxUses: 1,
      count: 1,
    });
  });

  it("rejects a bad --max-uses or --owner", () => {
    expect(() => parseAdminCommand(["create-invite", "--max-uses", "0"])).toThrow(
      /positive whole number/,
    );
    expect(() =>
      parseAdminCommand(["create-invite", "--max-uses", "5", "--owner", "nope"]),
    ).toThrow(/base58 pubkey/);
  });

  it("parses sweep-house with no flags", () => {
    expect(parseAdminCommand(["sweep-house"])).toEqual({ kind: "sweep-house" });
    expect(() => parseAdminCommand(["sweep-house", "now"])).toThrow(/unexpected argument/);
  });

  it("no longer knows the commands that moved principal by hand or funded a Yield budget", () => {
    for (const command of ["fund-yield", "withdraw-principal", "principal-out", "return-principal"]) {
      expect(() => parseAdminCommand([command])).toThrow();
    }
  });

  it("parses shutdown's confirm as the pool id", () => {
    expect(parseAdminCommand(["shutdown", "--confirm", "1"])).toEqual({
      kind: "shutdown",
      confirm: 1n,
    });
    expect(() => parseAdminCommand(["shutdown"])).toThrow(/needs --confirm/);
    expect(() => parseAdminCommand(["shutdown", "--confirm=-1"])).toThrow(
      /non-negative whole number/,
    );
  });

  it("parses emergency-crank's batch, defaulting when not given", () => {
    expect(parseAdminCommand(["emergency-crank"])).toEqual({
      kind: "emergency-crank",
      batch: 5,
    });
    expect(parseAdminCommand(["emergency-crank", "--batch", "10"])).toEqual({
      kind: "emergency-crank",
      batch: 10,
    });
    expect(() => parseAdminCommand(["emergency-crank", "--batch", "0"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses void-round and rollover-epoch ids as bigints", () => {
    expect(parseAdminCommand(["void-round", "--round", "17"])).toEqual({
      kind: "void-round",
      roundId: 17n,
    });
    expect(parseAdminCommand(["rollover-epoch", "--epoch", "3"])).toEqual({
      kind: "rollover-epoch",
      epochId: 3n,
    });
    expect(() => parseAdminCommand(["void-round"])).toThrow(/--round/);
    expect(() => parseAdminCommand(["rollover-epoch", "--epoch", "-1"])).toThrow(/whole number/);
  });

  it("rejects an unknown command", () => {
    expect(() => parseAdminCommand(["nuke-everything"])).toThrow(/usage/);
    expect(() => parseAdminCommand([])).toThrow(/usage/);
  });
});
