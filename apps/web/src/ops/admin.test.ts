import { Program, utils } from "@anchor-lang/core";
import { Keypair, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { HexVaultProgram } from "../chain.js";
import { idl } from "../idl.js";
import {
  adminMode,
  checkBounds,
  diffParams,
  encodeForSquads,
  fundJackpotIx,
  parseUsdc,
  pauseIx,
  PARAMS_FIELDS,
  setParamsIx,
  setVenueParamsIx,
  VENUE_FIELDS,
  type Values,
} from "./admin.js";

const key = () => Keypair.generate().publicKey;
const program = new Program(idl, {
  connection: { rpcEndpoint: "http://127.0.0.1:1" } as unknown as Connection,
}) as unknown as HexVaultProgram;

const params: Values = {
  epochSeconds: 86_400n,
  epochAnchor: 1_700_000_000n,
  vrfTimeout: 300n,
  minDeposit: 1_000_000n,
  minJackpot: 5_000_000n,
  payoutTimeout: 900n,
  baseRateBps: 8_000n,
};
const venue: Values = {
  yieldFeeBps: 1_000n,
  idleFloorBps: 500n,
  idleTargetBps: 1_000n,
  reserveShareCapBps: 500n,
  reserveLiquidityFloorBps: 20_000n,
  minVenueMove: 100_000_000n,
  lossToleranceBps: 1n,
};

describe("adminMode", () => {
  const admin = key().toBase58();
  it("signs only when the connected wallet is the Admin", () => {
    expect(adminMode(admin, admin)).toBe("sign");
    expect(adminMode(key().toBase58(), admin)).toBe("prepare");
    expect(adminMode(null, admin)).toBe("prepare");
  });
  it("is unknown until the summary names an Admin", () => {
    expect(adminMode(admin, null)).toBe("unknown");
  });
});

describe("diffParams", () => {
  it("leaves out blank and unchanged fields", () => {
    const { changes, errors } = diffParams(PARAMS_FIELDS, params, {
      epochSeconds: "86400",
      minJackpot: "",
      baseRateBps: "7500",
    });
    expect(errors).toEqual([]);
    expect(changes).toEqual([{ key: "baseRateBps", label: "Base rate (bps)", old: 8_000n, next: 7_500n }]);
  });

  it("shows old and new for every changed field", () => {
    const { changes } = diffParams(VENUE_FIELDS, venue, { yieldFeeBps: "1200", lossToleranceBps: "2" });
    expect(changes.map((c) => [c.key, c.old, c.next])).toEqual([
      ["yieldFeeBps", 1_000n, 1_200n],
      ["lossToleranceBps", 1n, 2n],
    ]);
  });

  it("reports input that is not a whole number or does not fit the field", () => {
    const { changes, errors } = diffParams(PARAMS_FIELDS, params, {
      epochSeconds: "6.5",
      baseRateBps: "70000",
      minDeposit: "-1",
    });
    expect(changes).toEqual([]);
    expect(errors).toHaveLength(3);
  });

  it("sends nothing when nothing changed", () => {
    expect(diffParams(PARAMS_FIELDS, params, {}).changes).toEqual([]);
  });
});

describe("checkBounds", () => {
  const bounds = (fields: typeof PARAMS_FIELDS, cur: Values, input: Record<string, string>, kind: "params" | "venue") =>
    checkBounds(kind, cur, diffParams(fields, cur, input).changes);

  it("refuses a Yield fee over the 20% cap and accepts the cap", () => {
    expect(bounds(VENUE_FIELDS, venue, { yieldFeeBps: "2001" }, "venue")).toHaveLength(1);
    expect(bounds(VENUE_FIELDS, venue, { yieldFeeBps: "2000" }, "venue")).toEqual([]);
  });

  it("judges the idle floor against the target it ends at", () => {
    expect(bounds(VENUE_FIELDS, venue, { idleFloorBps: "1100" }, "venue")).toHaveLength(1);
    expect(bounds(VENUE_FIELDS, venue, { idleFloorBps: "1100", idleTargetBps: "2000" }, "venue")).toEqual([]);
    expect(bounds(VENUE_FIELDS, venue, { idleTargetBps: "400" }, "venue")).toHaveLength(1);
  });

  it("holds the other venue caps", () => {
    for (const input of [
      { idleTargetBps: "5001" },
      { reserveShareCapBps: "2001" },
      { reserveLiquidityFloorBps: "9999" },
      { reserveLiquidityFloorBps: "60001" },
      { minVenueMove: "0" },
      { minVenueMove: "10000000001" },
      { lossToleranceBps: "101" },
    ]) {
      expect(bounds(VENUE_FIELDS, venue, input, "venue"), JSON.stringify(input)).toHaveLength(1);
    }
  });

  it("holds the set_params rules, judged on the merged result", () => {
    for (const input of [
      { baseRateBps: "10001" },
      { epochSeconds: "0" },
      { vrfTimeout: "179" },
      { payoutTimeout: "599" },
      { payoutTimeout: "86400" },
    ]) {
      expect(bounds(PARAMS_FIELDS, params, input, "params"), JSON.stringify(input)).not.toEqual([]);
    }
    expect(bounds(PARAMS_FIELDS, params, { epochSeconds: "900", payoutTimeout: "600" }, "params")).toEqual([]);
  });
});

describe("parseUsdc", () => {
  it("turns a decimal amount into atomic units", () => {
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
  });
  it("rejects zero, too many decimals and junk", () => {
    for (const bad of ["", "0", "0.0000001", "-1", "1e3", "abc"]) expect(parseUsdc(bad), bad).toBeNull();
  });
});

describe("Admin instructions and the Squads encoding", () => {
  const admin = key();
  const pool = key();
  const blockhash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const roundTrip = (ixs: TransactionInstruction[]) => {
    const tx = Transaction.from(utils.bytes.bs58.decode(encodeForSquads(ixs, admin, blockhash)));
    expect(tx.feePayer?.equals(admin)).toBe(true);
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    return tx;
  };
  const same = (a: TransactionInstruction, b: TransactionInstruction) => {
    expect(a.programId.equals(b.programId)).toBe(true);
    expect(a.data.equals(b.data)).toBe(true);
    // The fee payer is promoted to writable when the message compiles, so compare signer, not writable.
    expect(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner])).toEqual(
      b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner]),
    );
  };

  it("round-trips every pause switch in both directions with the Admin as signer", async () => {
    const ixs: TransactionInstruction[] = [];
    for (const sw of ["pool", "game", "jackpot", "deploy", "buyTickets"] as const) {
      for (const paused of [true, false]) ixs.push(await pauseIx(program, sw, paused, admin, pool));
    }
    const tx = roundTrip(ixs);
    expect(tx.instructions).toHaveLength(10);
    tx.instructions.forEach((ix, i) => {
      same(ix, ixs[i]!);
      expect(ix.keys.find((k) => k.isSigner)?.pubkey.equals(admin)).toBe(true);
    });
  });

  it("game and jackpot differ only in the feature argument", async () => {
    const game = await pauseIx(program, "game", true, admin, pool);
    const jackpot = await pauseIx(program, "jackpot", true, admin, pool);
    expect(game.data.equals(jackpot.data)).toBe(false);
  });

  it("round-trips set_params and set_venue_params and sends null for unchanged fields", async () => {
    const p = await setParamsIx(program, admin, pool, diffParams(PARAMS_FIELDS, params, { baseRateBps: "7500" }).changes);
    const v = await setVenueParamsIx(program, admin, pool, diffParams(VENUE_FIELDS, venue, { yieldFeeBps: "1200" }).changes);
    const tx = roundTrip([p, v]);
    same(tx.instructions[0]!, p);
    same(tx.instructions[1]!, v);
    // SAFETY: BorshInstructionCoder has decode at runtime; the abstract type only declares encode.
    const coder = program.coder.instruction as unknown as {
      decode(data: Buffer): { name: string; data: { params: Record<string, unknown> } };
    };
    const decoded = coder.decode(p.data);
    expect(decoded.name).toBe("setParams");
    expect(decoded.data.params.baseRateBps).toBe(7_500);
    expect(decoded.data.params.minJackpot).toBeNull();
    expect(decoded.data.params.epochSeconds).toBeNull();
  });

  it("fund_jackpot signs with the given wallet and draws from its token account", async () => {
    const wallet = key();
    const mint = key();
    const ix = await fundJackpotIx(program, wallet, pool, mint, 5_000_000n);
    expect(ix.keys.find((k) => k.isSigner)?.pubkey.equals(wallet)).toBe(true);
  });
});
