// The boot contract: what a missing var says, and that the mint rename does
// not strand a deployment still holding the old name (ticket 03).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { INVITE_CIRCULATION_CAP, INVITE_REDEEM_GRANT_COUNT } from "../api/invite-code";
import { DEFAULT_REFERRAL_QUALIFY_SECONDS } from "../api/referral";
import {
  DEFAULT_ALERT_IDLE_LOW_S,
  DEFAULT_ALERT_INDEXER_STALE_S,
  DEFAULT_ALERT_RESERVE_FREE_MIN,
  DEFAULT_ALERT_TICK_STALE_S,
  DEFAULT_OPERATOR_SOL_WARN,
  DEFAULT_RPC_TIMEOUT_MS,
  validateEnv,
} from "./env";

const MINT = Keypair.generate().publicKey.toBase58();

const base = {
  DATABASE_URL: "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault",
  RPC_URL: "http://127.0.0.1:8899",
  OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
  CORS_ORIGIN: "http://localhost:5173",
  PROGRAM_ID: "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6",
  POOL_ID: "1",
  CLUSTER: "devnet",
};

describe("validateEnv", () => {
  it("takes the mint under its new name", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).ACCEPTED_MINT).toBe(MINT);
  });

  it("still takes it under the old HEXUSDC_MINT", () => {
    expect(validateEnv({ ...base, HEXUSDC_MINT: MINT }).ACCEPTED_MINT).toBe(MINT);
  });

  it("prefers the new name when a deployment carries both", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, HEXUSDC_MINT: other }).ACCEPTED_MINT,
    ).toBe(MINT);
  });

  it("names the mint by its new name when neither is set", () => {
    expect(() => validateEnv(base)).toThrow(/ACCEPTED_MINT/);
  });

  // ADR 0019: the Sparring player is off unless SPARRING_ENABLED says so, and
  // a keypair in the env does not turn it on by itself.
  it("keeps the Sparring player off when SPARRING_ENABLED is unset or empty", () => {
    const withKey = { ...base, ACCEPTED_MINT: MINT, SPARRING_KEYPAIR: "x" };
    expect(validateEnv(withKey).SPARRING_ENABLED).toBe(false);
    expect(validateEnv({ ...withKey, SPARRING_ENABLED: "" }).SPARRING_ENABLED).toBe(false);
    expect(validateEnv({ ...withKey, SPARRING_ENABLED: "false" }).SPARRING_ENABLED).toBe(false);
  });

  it("turns the Sparring player on only for an explicit true", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT, SPARRING_ENABLED: "true" }).SPARRING_ENABLED).toBe(true);
  });

  it("refuses a SPARRING_ENABLED that is neither true nor false", () => {
    expect(() => validateEnv({ ...base, ACCEPTED_MINT: MINT, SPARRING_ENABLED: "yes" })).toThrow(
      /SPARRING_ENABLED must be true or false/,
    );
  });

  it("defaults the operator SOL warning", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).OPERATOR_SOL_WARN).toBe(
      DEFAULT_OPERATOR_SOL_WARN,
    );
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "1.5" })
        .OPERATOR_SOL_WARN,
    ).toBe(1.5);
  });

  it("takes a blank operator SOL warning as unset", () => {
    // How a compose file spells "leave this one alone".
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "   " })
        .OPERATOR_SOL_WARN,
    ).toBe(DEFAULT_OPERATOR_SOL_WARN);
  });

  it("fails the boot on an operator SOL warning that is not a number", () => {
    // Number("0.3 SOL") is NaN, and a NaN threshold would report the
    // operator's balance as healthy for the life of the process.
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "0.3 SOL" }),
    ).toThrow(/OPERATOR_SOL_WARN/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "-1" }),
    ).toThrow(/OPERATOR_SOL_WARN/);
  });

  it("defaults the RPC timeout", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).RPC_TIMEOUT_MS).toBe(
      DEFAULT_RPC_TIMEOUT_MS,
    );
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, RPC_TIMEOUT_MS: "5000" }).RPC_TIMEOUT_MS,
    ).toBe(5000);
  });

  it("fails the boot on an RPC timeout that is not a positive whole number", () => {
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, RPC_TIMEOUT_MS: "0" }),
    ).toThrow(/RPC_TIMEOUT_MS/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, RPC_TIMEOUT_MS: "1.5" }),
    ).toThrow(/RPC_TIMEOUT_MS/);
  });

  it("takes RPC_FALLBACK_URL when set, and leaves it out when not", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, RPC_FALLBACK_URL: "http://127.0.0.1:8900" })
        .RPC_FALLBACK_URL,
    ).toBe("http://127.0.0.1:8900");
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).RPC_FALLBACK_URL).toBeUndefined();
  });

  it("defaults the referral qualify hold period", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT }).REFERRAL_QUALIFY_SECONDS,
    ).toBe(DEFAULT_REFERRAL_QUALIFY_SECONDS);
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, REFERRAL_QUALIFY_SECONDS: "60" })
        .REFERRAL_QUALIFY_SECONDS,
    ).toBe(60);
  });

  it("takes a blank referral qualify hold period as unset", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, REFERRAL_QUALIFY_SECONDS: "  " })
        .REFERRAL_QUALIFY_SECONDS,
    ).toBe(DEFAULT_REFERRAL_QUALIFY_SECONDS);
  });

  it("fails the boot on a referral qualify hold period that is not a whole number", () => {
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, REFERRAL_QUALIFY_SECONDS: "-1" }),
    ).toThrow(/REFERRAL_QUALIFY_SECONDS/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, REFERRAL_QUALIFY_SECONDS: "1.5" }),
    ).toThrow(/REFERRAL_QUALIFY_SECONDS/);
  });

  it("defaults the /alerts staleness thresholds", () => {
    const env = validateEnv({ ...base, ACCEPTED_MINT: MINT });
    expect(env.ALERT_TICK_STALE_S).toBe(DEFAULT_ALERT_TICK_STALE_S);
    expect(env.ALERT_INDEXER_STALE_S).toBe(DEFAULT_ALERT_INDEXER_STALE_S);
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_TICK_STALE_S: "60" })
        .ALERT_TICK_STALE_S,
    ).toBe(60);
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_INDEXER_STALE_S: "120" })
        .ALERT_INDEXER_STALE_S,
    ).toBe(120);
  });

  it("fails the boot on an /alerts staleness threshold that is not a whole number", () => {
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_TICK_STALE_S: "-1" }),
    ).toThrow(/ALERT_TICK_STALE_S/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_INDEXER_STALE_S: "1.5" }),
    ).toThrow(/ALERT_INDEXER_STALE_S/);
  });

  // Yield-claimer ticket 14: the free idle and reserve liquidity thresholds.
  it("defaults the live-yield alert thresholds and fails the boot on a bad one", () => {
    const env = validateEnv({ ...base, ACCEPTED_MINT: MINT });
    expect(env.ALERT_IDLE_LOW_S).toBe(DEFAULT_ALERT_IDLE_LOW_S);
    expect(env.ALERT_RESERVE_FREE_MIN).toBe(DEFAULT_ALERT_RESERVE_FREE_MIN);
    const set = validateEnv({
      ...base,
      ACCEPTED_MINT: MINT,
      ALERT_IDLE_LOW_S: "600",
      ALERT_RESERVE_FREE_MIN: "5000000",
    });
    expect(set.ALERT_IDLE_LOW_S).toBe(600);
    expect(set.ALERT_RESERVE_FREE_MIN).toBe(5_000_000);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_IDLE_LOW_S: "-1" }),
    ).toThrow(/ALERT_IDLE_LOW_S/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, ALERT_RESERVE_FREE_MIN: "1.5" }),
    ).toThrow(/ALERT_RESERVE_FREE_MIN/);
  });

  // ticket 10: a mainnet stack must never crank a devnet Pool because
  // PROGRAM_ID or POOL_ID were silently defaulted.
  it("fails the boot when PROGRAM_ID is missing", () => {
    const { PROGRAM_ID, ...rest } = { ...base, ACCEPTED_MINT: MINT };
    expect(() => validateEnv(rest)).toThrow(/PROGRAM_ID/);
  });

  it("fails the boot when POOL_ID is missing", () => {
    const { POOL_ID, ...rest } = { ...base, ACCEPTED_MINT: MINT };
    expect(() => validateEnv(rest)).toThrow(/POOL_ID/);
  });

  it("takes PROGRAM_ID and POOL_ID when given", () => {
    const env = validateEnv({ ...base, ACCEPTED_MINT: MINT });
    expect(env.PROGRAM_ID).toBe(base.PROGRAM_ID);
    expect(env.POOL_ID).toBe("1");
  });

  it("fails the boot when CLUSTER is missing or not a known cluster", () => {
    const { CLUSTER, ...rest } = { ...base, ACCEPTED_MINT: MINT };
    expect(() => validateEnv(rest)).toThrow(/CLUSTER/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, CLUSTER: "mainnet" }),
    ).toThrow(/CLUSTER/);
  });

  it("takes CLUSTER=devnet or mainnet-beta", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, CLUSTER: "mainnet-beta" }).CLUSTER,
    ).toBe("mainnet-beta");
  });

  // beta-launch-fixes ticket 05: an optional launch time gates the
  // Operator's first begin_epoch (see tick.ts step 3).
  it("leaves LAUNCH_AT out when unset", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).LAUNCH_AT).toBeUndefined();
  });

  it("takes a blank LAUNCH_AT as unset", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, LAUNCH_AT: "  " }).LAUNCH_AT,
    ).toBeUndefined();
  });

  it("takes LAUNCH_AT as a valid ISO timestamp", () => {
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, LAUNCH_AT: "2026-10-01T00:00:00Z" })
        .LAUNCH_AT,
    ).toBe("2026-10-01T00:00:00Z");
  });

  it("fails the boot on a malformed LAUNCH_AT", () => {
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, LAUNCH_AT: "not-a-date" }),
    ).toThrow(/LAUNCH_AT/);
  });

  it("defaults the invite quota and takes overrides", () => {
    const defaults = validateEnv({ ...base, ACCEPTED_MINT: MINT });
    expect(defaults.INVITE_CIRCULATION_CAP).toBe(INVITE_CIRCULATION_CAP);
    expect(defaults.INVITE_REDEEM_GRANT_COUNT).toBe(INVITE_REDEEM_GRANT_COUNT);
    const set = validateEnv({
      ...base,
      ACCEPTED_MINT: MINT,
      INVITE_CIRCULATION_CAP: "200",
      INVITE_REDEEM_GRANT_COUNT: "0",
    });
    expect(set.INVITE_CIRCULATION_CAP).toBe(200);
    expect(set.INVITE_REDEEM_GRANT_COUNT).toBe(0);
  });

  it("fails the boot on a malformed invite quota", () => {
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, INVITE_CIRCULATION_CAP: "lots" }),
    ).toThrow(/INVITE_CIRCULATION_CAP/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, INVITE_REDEEM_GRANT_COUNT: "-1" }),
    ).toThrow(/INVITE_REDEEM_GRANT_COUNT/);
  });
});
