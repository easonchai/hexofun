import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  jackpotVaultAddress,
  playerAddress,
  principalVaultAddress,
  PROGRAM_ID,
  roundAddress,
  epochAddress,
  type HexVaultProgram,
} from "../chain.js";
import { idl } from "../idl.js";
import {
  coverDeficit,
  deployToVenue,
  harvest,
  parseUsdcAmount,
  processWithdraw,
  recall,
  rolloverEpoch,
  voidRound,
  type VenuePool,
} from "./instructions.js";

const key = () => Keypair.generate().publicKey;
const program = new Program(
  { ...idl, address: PROGRAM_ID.toBase58() },
  { connection: new Connection("http://127.0.0.1:1") },
) as unknown as HexVaultProgram;

const pool: VenuePool = {
  address: key(),
  acceptedMint: key(),
  treasury: key(),
  weightTree: key(),
  klendProgram: key(),
  klendMarket: key(),
  klendReserve: key(),
  klendCtoken: key(),
};
const caller = key();
const idlAccounts = (name: string) => idl.instructions.find((ix) => ix.name === name)!.accounts.length;
const keysOf = (ix: { keys: { pubkey: PublicKey }[] }) => ix.keys.map((k) => k.pubkey.toBase58());
/** Klend extras ride along after the IDL accounts: market authority, supply vault, cToken mint, sysvar. */
const KLEND_EXTRAS = 4;

describe("parseUsdcAmount", () => {
  it("parses to 6-decimal base units", () => {
    expect(parseUsdcAmount("1")).toBe(1_000_000n);
    expect(parseUsdcAmount(" 12.345678 ")).toBe(12_345_678n);
    expect(parseUsdcAmount("0.000001")).toBe(1n);
  });
  it("rejects zero, blanks, signs and extra precision", () => {
    for (const bad of ["", "0", "0.0", "-1", "1e3", "abc", "1.0000001", "1,5"]) {
      expect(parseUsdcAmount(bad)).toBeNull();
    }
  });
});

describe("venue crank account lists", () => {
  const venue = [pool.klendProgram, pool.klendMarket, pool.klendReserve, pool.klendCtoken].map((k) => k.toBase58());

  it("deploy_to_venue and recall match the IDL plus the klend extras", async () => {
    for (const [build, name] of [
      [deployToVenue, "deploy_to_venue"],
      [recall, "recall"],
    ] as const) {
      const ix = await build(program, pool, 5n);
      expect(ix.keys).toHaveLength(idlAccounts(name) + KLEND_EXTRAS);
      expect(keysOf(ix)).toEqual(
        expect.arrayContaining([
          pool.address.toBase58(),
          principalVaultAddress(pool.address).toBase58(),
          pool.acceptedMint.toBase58(),
          ...venue,
        ]),
      );
    }
  });

  it("harvest names the vaults and the treasury", async () => {
    const ix = await harvest(program, pool);
    expect(ix.keys).toHaveLength(idlAccounts("harvest") + KLEND_EXTRAS);
    expect(keysOf(ix)).toEqual(
      expect.arrayContaining([
        jackpotVaultAddress(pool.address).toBase58(),
        pool.treasury.toBase58(),
        ...venue,
      ]),
    );
  });

  it("a pool pinned to this program as its own klend gets no extras", async () => {
    const stub = { ...pool, klendProgram: PROGRAM_ID };
    expect((await harvest(program, stub)).keys).toHaveLength(idlAccounts("harvest"));
  });

  it("cover_deficit pays from the wallet's USDC account", async () => {
    const ix = await coverDeficit(program, pool, caller);
    expect(ix.keys).toHaveLength(idlAccounts("cover_deficit") + KLEND_EXTRAS);
    expect(ix.keys[0]!.pubkey.equals(caller)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
  });
});

describe("recovery instructions", () => {
  it("process_withdraw prepends an idempotent ATA create and leaves the owner signer out", async () => {
    const owner = key();
    const [ata, ix] = await processWithdraw(program, pool, caller, owner);
    expect(ata!.programId.toBase58()).not.toBe(PROGRAM_ID.toBase58());
    expect(ix!.keys).toHaveLength(idlAccounts("process_withdraw"));
    expect(keysOf(ix!)).toContain(playerAddress(pool.address, owner).toBase58());
    expect(ix!.keys.some((k) => k.isSigner)).toBe(false);
  });

  it("void_round and rollover_epoch name the stuck item and its randomness account", async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const round = await voidRound(program, pool, caller, { roundId: 7n, vrfSeed: seed });
    const epoch = await rolloverEpoch(program, pool, caller, { epochId: 3n, vrfSeed: seed });
    expect(round.keys).toHaveLength(idlAccounts("void_round"));
    expect(epoch.keys).toHaveLength(idlAccounts("rollover_epoch"));
    expect(keysOf(round)).toContain(roundAddress(pool.address, 7n).toBase58());
    expect(keysOf(epoch)).toContain(epochAddress(pool.address, 3n).toBase58());
    // Same seed, same randomness account in both.
    expect(keysOf(round)[3]).toBe(keysOf(epoch)[3]);
  });
});
