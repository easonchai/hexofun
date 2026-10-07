import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POOL_PARAMS,
  MAINNET_GENESIS_HASH,
  assertMainnetSafe,
  buyTicketsPausedFor,
  envInt,
  isoSeconds,
  nextSundayAnchor,
  parsePoolParams,
  venuePinsFor,
} from "./params";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

describe("parsePoolParams", () => {
  it("returns the spec §7 defaults with no flags", () => {
    expect(parsePoolParams([])).toEqual(DEFAULT_POOL_PARAMS);
  });

  it("defaults round_seconds to 90, with close_buffer safely under it", () => {
    expect(DEFAULT_POOL_PARAMS.roundSeconds).toBe(90);
    expect(DEFAULT_POOL_PARAMS.closeBuffer).toBeLessThan(
      DEFAULT_POOL_PARAMS.roundSeconds,
    );
  });

  it("overrides only the flags given", () => {
    // Above a payout timeout, which has to be shorter than the epoch.
    expect(
      parsePoolParams(["--epoch-seconds", "1200", "--payout-timeout", "700"]),
    ).toEqual({
      ...DEFAULT_POOL_PARAMS,
      epochSeconds: 1200,
      payoutTimeout: 700,
    });
    expect(
      parsePoolParams([
        "--epoch-seconds=1200",
        "--round-seconds=20",
        "--payout-timeout=700",
      ]),
    ).toEqual({
      ...DEFAULT_POOL_PARAMS,
      epochSeconds: 1200,
      roundSeconds: 20,
      payoutTimeout: 700,
    });
  });

  it("takes a positive payout timeout", () => {
    expect(parsePoolParams(["--payout-timeout", "60"])).toEqual({
      ...DEFAULT_POOL_PARAMS,
      payoutTimeout: 60,
    });
    expect(() => parsePoolParams(["--payout-timeout", "0"])).toThrow(
      /positive/,
    );
  });

  it("no longer has a registration window", () => {
    expect(DEFAULT_POOL_PARAMS).not.toHaveProperty("registrationWindow");
    expect(() => parsePoolParams(["--registration-window", "0"])).toThrow(
      /usage/,
    );
  });

  it("rejects a payout timeout at or above the epoch length", () => {
    // set_params requires payout_timeout < epoch_seconds (beta-launch-fixes
    // ticket 03); the 82_800s default payout timeout against a 1_200s epoch
    // would otherwise fail the pool's very first set_params call.
    expect(() => parsePoolParams(["--epoch-seconds", "1200"])).toThrow(
      /payout timeout/,
    );
  });

  it("rejects values create_pool would reject", () => {
    expect(() => parsePoolParams(["--round-seconds", "0"])).toThrow(/positive/);
    expect(() => parsePoolParams(["--epoch-seconds", "1.5"])).toThrow(/whole/);
    // close_buffer is 5, so a 4 second round cannot satisfy
    // close_buffer < round_seconds.
    expect(() => parsePoolParams(["--round-seconds", "4"])).toThrow(
      /close buffer/,
    );
  });

  // game-jackpot-pause ticket 02: paused unless asked.
  it("leaves the pool paused by default and takes --start", () => {
    expect(parsePoolParams([]).start).toBeUndefined();
    expect(parsePoolParams(["--start"]).start).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parsePoolParams(["--pool-id", "2"])).toThrow(/usage/);
  });

  it("overrides the House cut rate", () => {
    expect(parsePoolParams(["--house-cut-bps", "0"])).toEqual({
      ...DEFAULT_POOL_PARAMS,
      houseCutBps: 0,
    });
    expect(parsePoolParams(["--house-cut-bps", "10000"])).toEqual({
      ...DEFAULT_POOL_PARAMS,
      houseCutBps: 10_000,
    });
  });

  it("rejects a House cut rate outside 0..=10000", () => {
    // node:util parseArgs only accepts a "-"-leading value via "=" syntax.
    expect(() => parsePoolParams(["--house-cut-bps=-1"])).toThrow(
      /0 to 10000/,
    );
    expect(() => parsePoolParams(["--house-cut-bps", "10001"])).toThrow(
      /0 to 10000/,
    );
    expect(() => parsePoolParams(["--house-cut-bps", "1.5"])).toThrow(
      /0 to 10000/,
    );
  });

  it("takes the two role keys as base58 pubkeys", () => {
    const admin = Keypair.generate().publicKey;
    const operator = Keypair.generate().publicKey;
    const params = parsePoolParams([
      "--admin",
      admin.toBase58(),
      "--operator",
      operator.toBase58(),
    ]);
    expect(params.admin?.equals(admin)).toBe(true);
    expect(params.operator?.equals(operator)).toBe(true);
  });

  it("leaves both role keys unset when neither flag is given", () => {
    // bootstrap.ts falls back to ADMIN_ADDRESS and then to the signer, so
    // "absent" has to stay absent rather than becoming the default pubkey.
    expect(parsePoolParams([])).not.toHaveProperty("admin");
    expect(parsePoolParams([])).not.toHaveProperty("operator");
  });

  it("rejects a role key that is not a pubkey", () => {
    // create_pool refuses a default admin or operator, and a typo caught
    // here costs nothing, while one caught on chain costs the mint and both
    // vaults that bootstrap has already created.
    expect(() => parsePoolParams(["--admin", "not-a-pubkey"])).toThrow(
      /--admin must be a base58 pubkey/,
    );
    expect(() =>
      parsePoolParams(["--operator", Keypair.generate().publicKey.toBase58().slice(0, 10)]),
    ).toThrow(/--operator must be a base58 pubkey/);
  });

  it("takes the anchor as an ISO 8601 time", () => {
    expect(
      parsePoolParams(["--epoch-anchor", "2026-09-13T16:00:00Z"]).epochAnchor,
    ).toBe(1_789_315_200);
    expect(() => parsePoolParams(["--epoch-anchor", "next sunday"])).toThrow(
      /ISO 8601/,
    );
  });

  it("takes explicit treasury and buyback reserve as base58 pubkeys", () => {
    const treasury = Keypair.generate().publicKey;
    const buybackReserve = Keypair.generate().publicKey;
    const params = parsePoolParams([
      "--treasury",
      treasury.toBase58(),
      "--buyback-reserve",
      buybackReserve.toBase58(),
    ]);
    expect(params.treasury?.equals(treasury)).toBe(true);
    expect(params.buybackReserve?.equals(buybackReserve)).toBe(true);
  });

  it("leaves treasury and buyback reserve unset when neither flag is given", () => {
    expect(parsePoolParams([])).not.toHaveProperty("treasury");
    expect(parsePoolParams([])).not.toHaveProperty("buybackReserve");
  });

  it("rejects a treasury equal to the buyback reserve", () => {
    const same = Keypair.generate().publicKey.toBase58();
    expect(() =>
      parsePoolParams(["--treasury", same, "--buyback-reserve", same]),
    ).toThrow(/--treasury and --buyback-reserve must differ/);
  });
});

describe("assertMainnetSafe", () => {
  const operator = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const buybackReserve = Keypair.generate().publicKey;
  const acceptedMint = Keypair.generate().publicKey.toBase58();

  it("proceeds on any non-mainnet genesis hash regardless of what is given", () => {
    expect(() =>
      assertMainnetSafe({ genesisHash: DEVNET_GENESIS_HASH, operator }),
    ).not.toThrow();
  });

  it("refuses mainnet missing any of admin, treasury, buyback reserve or mint", () => {
    expect(() =>
      assertMainnetSafe({ genesisHash: MAINNET_GENESIS_HASH, operator }),
    ).toThrow(/--admin.*--treasury.*--buyback-reserve.*ACCEPTED_MINT/s);
    expect(() =>
      assertMainnetSafe({
        genesisHash: MAINNET_GENESIS_HASH,
        operator,
        admin,
        treasury,
        buybackReserve,
      }),
    ).toThrow(/ACCEPTED_MINT/);
    expect(() =>
      assertMainnetSafe({
        genesisHash: MAINNET_GENESIS_HASH,
        operator,
        admin,
        treasury,
        acceptedMint,
      }),
    ).toThrow(/--buyback-reserve/);
  });

  it("refuses mainnet with Admin equal to Operator", () => {
    expect(() =>
      assertMainnetSafe({
        genesisHash: MAINNET_GENESIS_HASH,
        operator,
        admin: operator,
        treasury,
        buybackReserve,
        acceptedMint,
      }),
    ).toThrow(/refuses an Admin equal to the Operator key/);
  });

  it("proceeds on mainnet when everything is explicit and Admin differs from Operator", () => {
    expect(() =>
      assertMainnetSafe({
        genesisHash: MAINNET_GENESIS_HASH,
        operator,
        admin,
        treasury,
        buybackReserve,
        acceptedMint,
      }),
    ).not.toThrow();
  });
});

describe("envInt", () => {
  it("takes the fallback when the value is unset or blank", () => {
    expect(envInt("X", undefined, 488)).toBe(488);
    expect(envInt("X", "  ", 488)).toBe(488);
  });

  it("parses a given value", () => {
    expect(envInt("X", "250", 488)).toBe(250);
    expect(envInt("X", "0", 488)).toBe(0);
  });

  it("rejects a negative or non-numeric value", () => {
    expect(() => envInt("X", "-1", 488)).toThrow(/non-negative/);
    expect(() => envInt("X", "abc", 488)).toThrow(/non-negative/);
    expect(() => envInt("X", "1.5", 488)).toThrow(/non-negative/);
  });
});

describe("DEFAULT_POOL_PARAMS", () => {
  it("defaults the ticket-economy rates spec.md and ADR 0011 ask for", () => {
    expect(DEFAULT_POOL_PARAMS.baseRateBps).toBe(488);
    expect(DEFAULT_POOL_PARAMS.ticketsPerUsdc).toBe(10);
    expect(DEFAULT_POOL_PARAMS.bonusCapBps).toBe(500);
  });
});

describe("nextSundayAnchor", () => {
  it("takes the following Sunday from a midweek now", () => {
    // Thursday 2026-09-10, so the anchor is Sunday the 13th at 16:00 UTC,
    // which is 00:00 MYT on Monday the 14th.
    expect(nextSundayAnchor(new Date("2026-09-10T09:41:07Z"))).toBe(
      1_789_315_200,
    );
  });

  it("keeps a now that is already on a Sunday 16:00 UTC", () => {
    expect(nextSundayAnchor(new Date("2026-09-13T16:00:00Z"))).toBe(
      1_789_315_200,
    );
  });

  it("skips to next week once that Sunday's 16:00 has gone", () => {
    expect(nextSundayAnchor(new Date("2026-09-13T16:00:01Z"))).toBe(
      1_789_315_200 + 7 * 86_400,
    );
  });
});

describe("isoSeconds", () => {
  it("round-trips an ISO string to unix seconds", () => {
    expect(isoSeconds("epoch-anchor", "2026-09-13T16:00:00Z")).toBe(
      1_789_315_200,
    );
    // A non-UTC offset is the same instant, so it resolves to the same value.
    expect(isoSeconds("epoch-anchor", "2026-09-14T00:00:00+08:00")).toBe(
      1_789_315_200,
    );
  });

  it("rejects a value Date cannot parse", () => {
    expect(() => isoSeconds("epoch-anchor", "2026-13-01")).toThrow(/ISO 8601/);
    expect(() => isoSeconds("epoch-anchor", "")).toThrow(/ISO 8601/);
  });
});

describe("venuePinsFor", () => {
  const pool = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const key = () => Keypair.generate().publicKey.toBase58();

  it("defaults to Kamino's USDC reserve on mainnet, with the pool's cToken ATA", () => {
    const pins = venuePinsFor(MAINNET_GENESIS_HASH, {}, pool, programId);
    expect(pins.klendProgram.toBase58()).toBe("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
    expect(pins.klendMarket.toBase58()).toBe("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
    expect(pins.klendReserve.toBase58()).toBe("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
    expect(pins.ctokenMint?.toBase58()).toBe("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");
    expect(pins.klendCtoken.equals(getAssociatedTokenAddressSync(pins.ctokenMint!, pool, true))).toBe(true);
  });

  it("takes an explicit cToken account as is, without asking bootstrap to create one", () => {
    const klendCtoken = key();
    const pins = venuePinsFor(MAINNET_GENESIS_HASH, { KLEND_CTOKEN: klendCtoken }, pool, programId);
    expect(pins.klendCtoken.toBase58()).toBe(klendCtoken);
    expect(pins).not.toHaveProperty("ctokenMint");
  });

  it("makes a mainnet reserve override bring its own cToken account", () => {
    expect(() =>
      venuePinsFor(MAINNET_GENESIS_HASH, { KLEND_RESERVE: key() }, pool, programId),
    ).toThrow(/KLEND_CTOKEN must be set/);
  });

  it("has no default off mainnet and names every missing variable", () => {
    expect(() => venuePinsFor(DEVNET_GENESIS_HASH, {}, pool, programId)).toThrow(
      /KLEND_PROGRAM, KLEND_MARKET, KLEND_RESERVE, KLEND_CTOKEN must be set/,
    );
    const env = {
      KLEND_PROGRAM: key(),
      KLEND_MARKET: key(),
      KLEND_RESERVE: key(),
      KLEND_CTOKEN: key(),
    };
    expect(venuePinsFor(DEVNET_GENESIS_HASH, env, pool, programId).klendReserve.toBase58()).toBe(
      env.KLEND_RESERVE,
    );
  });

  it("rejects a value that is not a pubkey", () => {
    expect(() =>
      venuePinsFor(DEVNET_GENESIS_HASH, { KLEND_PROGRAM: "nope" }, pool, programId),
    ).toThrow(/KLEND_PROGRAM must be a base58 pubkey/);
  });

  it("defaults to the klend kind and reads the kind from VENUE_KIND", () => {
    const env = { KLEND_PROGRAM: key(), KLEND_MARKET: key(), KLEND_RESERVE: key(), KLEND_CTOKEN: key() };
    expect(venuePinsFor(DEVNET_GENESIS_HASH, env, pool, programId).kind).toBe(0);
    expect(venuePinsFor(DEVNET_GENESIS_HASH, { ...env, VENUE_KIND: "klend" }, pool, programId).kind).toBe(0);
    expect(venuePinsFor(DEVNET_GENESIS_HASH, { VENUE_KIND: "stub" }, pool, programId).kind).toBe(1);
    expect(venuePinsFor(DEVNET_GENESIS_HASH, { KLEND_VENUE: "test" }, pool, programId).kind).toBe(1);
    expect(venuePinsFor(MAINNET_GENESIS_HASH, {}, pool, programId).kind).toBe(0);
  });

  it("refuses an unknown kind, a contradiction, and the stub kind on mainnet", () => {
    expect(() => venuePinsFor(DEVNET_GENESIS_HASH, { VENUE_KIND: "kvault" }, pool, programId)).toThrow(
      /VENUE_KIND must be/,
    );
    expect(() =>
      venuePinsFor(DEVNET_GENESIS_HASH, { VENUE_KIND: "klend", KLEND_VENUE: "test" }, pool, programId),
    ).toThrow(/contradict/);
    expect(() => venuePinsFor(MAINNET_GENESIS_HASH, { VENUE_KIND: "stub" }, pool, programId)).toThrow(
      /VENUE_KIND=stub is refused on mainnet/,
    );
  });

  it("pins the test-venue stub on KLEND_VENUE=test, never on mainnet", () => {
    const pins = venuePinsFor(DEVNET_GENESIS_HASH, { KLEND_VENUE: "test" }, pool, programId);
    expect(pins.klendProgram.equals(programId)).toBe(true);
    expect(pins.klendMarket.equals(pool)).toBe(true);
    expect(() =>
      venuePinsFor(MAINNET_GENESIS_HASH, { KLEND_VENUE: "test" }, pool, programId),
    ).toThrow(/refused on mainnet/);
  });
});

describe("buyTicketsPausedFor", () => {
  it("defaults on for mainnet-beta and off everywhere else", () => {
    expect(buyTicketsPausedFor(MAINNET_GENESIS_HASH, undefined)).toBe(true);
    expect(buyTicketsPausedFor(MAINNET_GENESIS_HASH, " ")).toBe(true);
    expect(buyTicketsPausedFor(DEVNET_GENESIS_HASH, undefined)).toBe(false);
  });

  it("lets the env value win in either direction", () => {
    expect(buyTicketsPausedFor(DEVNET_GENESIS_HASH, "true")).toBe(true);
    expect(buyTicketsPausedFor(MAINNET_GENESIS_HASH, "false")).toBe(false);
  });

  it("rejects anything else", () => {
    expect(() => buyTicketsPausedFor(DEVNET_GENESIS_HASH, "yes")).toThrow(
      /BUY_TICKETS_PAUSED/,
    );
  });
});
