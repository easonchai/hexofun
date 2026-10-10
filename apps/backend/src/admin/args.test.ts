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

  it("parses grant-tickets as a signed backend request", () => {
    const owner = Keypair.generate().publicKey;
    const flags = ["--owner", owner.toBase58(), "--amount", "500", "--reason", "launch bonus", "--keypair", "team.json"];
    expect(parseAdminCommand(["grant-tickets", ...flags])).toEqual({
      kind: "grant-tickets",
      owner,
      amount: 500n,
      reason: "launch bonus",
      keypair: "team.json",
    });
    expect(parseAdminCommand(["grant-tickets", ...flags, "--backend", "http://b"])).toMatchObject({ backend: "http://b" });
  });

  it("rejects grant-tickets missing a flag, or with a bad amount or reason", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const flags = ["--owner", owner, "--amount", "5", "--reason", "r", "--keypair", "k.json"];
    for (const flag of ["owner", "amount", "reason", "keypair"]) {
      const at = flags.indexOf(`--${flag}`);
      const without = flags.filter((_, i) => i !== at && i !== at + 1);
      expect(() => parseAdminCommand(["grant-tickets", ...without])).toThrow(new RegExp(`needs --${flag}`));
    }
    const withFlag = (flag: string, value: string) => {
      const copy = [...flags];
      copy[copy.indexOf(flag) + 1] = value;
      return ["grant-tickets", ...copy];
    };
    expect(() => parseAdminCommand(withFlag("--amount", "0"))).toThrow(/positive whole number/);
    expect(() => parseAdminCommand(withFlag("--amount", "9007199254740993"))).toThrow(/at most/);
    expect(() => parseAdminCommand(withFlag("--reason", "x".repeat(201)))).toThrow(/1 to 200/);
    expect(() => parseAdminCommand(withFlag("--owner", "nope"))).toThrow(/base58 pubkey/);
  });

  it("no longer has void-round or the round and ticket-rate flags", () => {
    // The program dropped them (off-chain-tickets ticket 10).
    expect(() => parseAdminCommand(["void-round", "--round", "1"])).toThrow(/usage/);
    for (const flag of ["--round-seconds", "--close-buffer", "--house-cut-bps", "--tickets-per-usdc", "--bonus-cap-bps"]) {
      expect(() => parseAdminCommand(["set-params", flag, "1"])).toThrow(/usage/);
    }
  });

  it("parses only the set-params flags given", () => {
    expect(parseAdminCommand(["set-params", "--epoch-seconds", "900"])).toEqual({
      kind: "set-params",
      params: { epochSeconds: 900 },
    });
    expect(parseAdminCommand(["set-params", "--min-deposit", "0"])).toEqual({
      kind: "set-params",
      params: { minDeposit: 0n },
    });
  });

  it("rejects set-params with no flags at all", () => {
    expect(() => parseAdminCommand(["set-params"])).toThrow(/at least one flag/);
  });

  it("rejects out-of-range set-params values", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--epoch-seconds", "0"]),
    ).toThrow(/positive whole number/);
  });

  it("parses the base yield flag (ticket 05)", () => {
    expect(parseAdminCommand(["set-params", "--base-rate-bps", "488"])).toEqual({
      kind: "set-params",
      params: { baseRateBps: 488 },
    });
  });

  it("rejects a base yield rate outside 0..=10000", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--base-rate-bps", "10001"]),
    ).toThrow(/0 to 10000/);
  });

  it("refuses a basis-point value that is not plain digits, naming the flag (audit-2026-10-09 09)", () => {
    for (const bad of ["", "1e2", "0x10"]) {
      expect(() => parseAdminCommand(["set-params", "--base-rate-bps", bad])).toThrow(/--base-rate-bps must be/);
      expect(() => parseAdminCommand(["set-venue-params", "--yield-fee-bps", bad])).toThrow(/--yield-fee-bps must be/);
    }
    expect(parseAdminCommand(["set-venue-params", "--yield-fee-bps", "1000"])).toEqual({
      kind: "set-venue-params",
      params: { yieldFeeBps: 1000 },
    });
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

  it("parses propose-venue by kind name or number, and cancel-venue", () => {
    const [program, market, reserve, ctoken] = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
    const flags = (kind: string) => [
      "propose-venue",
      "--kind", kind,
      "--program", program!.toBase58(),
      "--market", market!.toBase58(),
      "--reserve", reserve!.toBase58(),
      "--ctoken", ctoken!.toBase58(),
    ];
    expect(parseAdminCommand(flags("klend"))).toEqual({
      kind: "propose-venue", venueKind: 0, program, market, reserve, ctoken,
    });
    expect(parseAdminCommand(flags("kvault"))).toMatchObject({ venueKind: 2 });
    expect(parseAdminCommand(flags("7"))).toMatchObject({ venueKind: 7 });
    expect(() => parseAdminCommand(flags("vault"))).toThrow(/--kind must be one of/);
    expect(() => parseAdminCommand(flags("256"))).toThrow(/--kind must be one of/);
    expect(() => parseAdminCommand(["propose-venue", "--kind", "klend"])).toThrow(/needs --program/);
    expect(() => parseAdminCommand([...flags("klend").slice(0, 7), "--reserve", "nope", "--ctoken", ctoken!.toBase58()]))
      .toThrow(/--reserve must be a base58 pubkey/);
    expect(parseAdminCommand(["cancel-venue"])).toEqual({ kind: "cancel-venue" });
    expect(() => parseAdminCommand(["cancel-venue", "now"])).toThrow(/unexpected argument/);
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

  it("parses pause-buy-tickets and start-buy-tickets with no flags", () => {
    for (const kind of ["pause-buy-tickets", "start-buy-tickets"]) {
      expect(parseAdminCommand([kind])).toEqual({ kind });
    }
    expect(() => parseAdminCommand(["start-buy-tickets", "now"])).toThrow(/unexpected argument/);
  });

  it("parses only the set-venue-params flags given", () => {
    expect(parseAdminCommand(["set-venue-params", "--yield-fee-bps", "500"])).toEqual({
      kind: "set-venue-params",
      params: { yieldFeeBps: 500 },
    });
    expect(
      parseAdminCommand([
        "set-venue-params",
        "--idle-floor-bps",
        "0",
        "--idle-target-bps",
        "1000",
        "--reserve-share-cap-bps",
        "1500",
        "--reserve-liquidity-floor-bps",
        "20000",
        "--min-venue-move",
        "100000000",
        "--loss-tolerance-bps",
        "50",
      ]),
    ).toEqual({
      kind: "set-venue-params",
      params: {
        idleFloorBps: 0,
        idleTargetBps: 1000,
        reserveShareCapBps: 1500,
        reserveLiquidityFloorBps: 20_000,
        minVenueMove: 100_000_000n,
        lossToleranceBps: 50,
      },
    });
  });

  it("rejects set-venue-params with no flags, or a value that does not fit", () => {
    expect(() => parseAdminCommand(["set-venue-params"])).toThrow(/at least one flag/);
    expect(() => parseAdminCommand(["set-venue-params", "--yield-fee-bps", "65536"])).toThrow(
      /0 to 65535/,
    );
    expect(() => parseAdminCommand(["set-venue-params", "--idle-floor-bps=-1"])).toThrow(
      /0 to 65535/,
    );
    expect(() => parseAdminCommand(["set-venue-params", "--min-venue-move", "0"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseAdminCommand(["set-venue-params", "--bogus", "1"])).toThrow(/usage/);
  });

  it("parses set-treasury-accounts' two token accounts", () => {
    const treasury = Keypair.generate().publicKey;
    const buybackReserve = Keypair.generate().publicKey;
    expect(
      parseAdminCommand([
        "set-treasury-accounts",
        "--treasury",
        treasury.toBase58(),
        "--buyback-reserve",
        buybackReserve.toBase58(),
      ]),
    ).toEqual({ kind: "set-treasury-accounts", treasury, buybackReserve });
  });

  it("rejects set-treasury-accounts missing either flag, or a bad one", () => {
    const key = Keypair.generate().publicKey.toBase58();
    expect(() => parseAdminCommand(["set-treasury-accounts", "--buyback-reserve", key])).toThrow(
      /needs --treasury/,
    );
    expect(() => parseAdminCommand(["set-treasury-accounts", "--treasury", key])).toThrow(
      /needs --buyback-reserve/,
    );
    expect(() =>
      parseAdminCommand(["set-treasury-accounts", "--treasury", "nope", "--buyback-reserve", key]),
    ).toThrow(/base58 pubkey/);
  });

  it("parses drain-venue's amount and refuses a missing, zero or fractional one", () => {
    expect(parseAdminCommand(["drain-venue", "--amount", "1500000"])).toEqual({
      kind: "drain-venue",
      amount: 1_500_000n,
    });
    expect(() => parseAdminCommand(["drain-venue"])).toThrow(/needs --amount/);
    expect(() => parseAdminCommand(["drain-venue", "--amount", "0"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseAdminCommand(["drain-venue", "--amount", "1.5"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses migrate-venue, which takes no flags", () => {
    expect(parseAdminCommand(["migrate-venue"])).toEqual({ kind: "migrate-venue" });
    expect(() => parseAdminCommand(["migrate-venue", "now"])).toThrow(/unexpected argument/);
  });

  it("parses cover-deficit's amount", () => {
    expect(parseAdminCommand(["cover-deficit", "--amount", "2500000"])).toEqual({
      kind: "cover-deficit",
      amount: 2_500_000n,
    });
    expect(() => parseAdminCommand(["cover-deficit"])).toThrow(/needs --amount/);
    expect(() => parseAdminCommand(["cover-deficit", "--amount", "0"])).toThrow(
      /positive whole number/,
    );
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

  it("parses the rollover-epoch id as a bigint", () => {
    expect(parseAdminCommand(["rollover-epoch", "--epoch", "3"])).toEqual({
      kind: "rollover-epoch",
      epochId: 3n,
    });
    expect(() => parseAdminCommand(["rollover-epoch", "--epoch", "-1"])).toThrow(/usage/);
  });

  it("rejects an unknown command", () => {
    expect(() => parseAdminCommand(["nuke-everything"])).toThrow(/usage/);
    expect(() => parseAdminCommand([])).toThrow(/usage/);
  });
});
