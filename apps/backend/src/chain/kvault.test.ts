import { SYSVAR_INSTRUCTIONS_PUBKEY, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  allocationReserves,
  decodeKvaultView,
  KLEND_PROGRAM_ID,
  KVAULT_PROGRAM_ID,
  kvaultRemaining,
  pickSource,
  withdrawable,
} from "./kvault";
import { IDLE, kvaultFixture } from "./kvault.fixture";

describe("the kVault view", () => {
  const f = kvaultFixture([
    { ctokens: 0n, available: 50n },
    { ctokens: 10n, available: 1_000n },
    { ctokens: 10n, available: 9_000n, emptyBefore: true },
    { ctokens: 10n, available: 400n },
  ]);

  it("what a redeem can pay now is the idle tokens plus the source reserve's liquidity", () => {
    expect(f.view.idle).toBe(IDLE);
    expect(withdrawable(f.view)).toBe(IDLE + 9_000n);
  });

  it("lists the non-empty allocation slots in slot order, skipping gaps", () => {
    expect(allocationReserves(f.vaultData).map((k) => k.toBase58())).toEqual(
      f.reserves.map((k) => k.toBase58()),
    );
    expect(f.view.allocations).toHaveLength(4);
  });

  it("reads each reserve's market, liquidity supply, cToken mint and free liquidity", () => {
    const second = f.view.allocations[1]!;
    const data = f.reserveData.get(second.reserve.toBase58())!;
    expect(second.market.toBase58()).toBe(new PublicKey(data.subarray(32, 64)).toBase58());
    expect(second.liquiditySupply.toBase58()).toBe(new PublicKey(data.subarray(160, 192)).toBase58());
    expect(second.collateralMint.toBase58()).toBe(new PublicKey(data.subarray(2560, 2592)).toBase58());
    expect(second.available).toBe(1_000n);
    expect(second.ctokens).toBe(10n);
  });

  it("refuses a reserve list it has no data for", () => {
    expect(() => decodeKvaultView(f.view.vault, f.vaultData, new Map())).toThrow(/no data for allocation reserve/);
  });

  it("redeems from the funded reserve with the most free liquidity", () => {
    // Slot 0 is unfunded; slot 2 has the most liquidity.
    expect(pickSource(f.view).reserve.toBase58()).toBe(f.view.allocations[2]!.reserve.toBase58());
    const unfunded = kvaultFixture([{ ctokens: 0n, available: 5n }]);
    expect(() => pickSource(unfunded.view)).toThrow(/no funded allocation/);
  });
});

describe("kvaultRemaining", () => {
  const f = kvaultFixture([
    { ctokens: 10n, available: 100n },
    { ctokens: 10n, available: 900n },
  ]);
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const n = f.view.allocations.length;

  it("is the klend program, the reserves writable, then their markets, in allocation order", () => {
    const metas = kvaultRemaining(f.view, { valueOnly: true });
    expect(metas).toHaveLength(1 + 2 * n);
    expect(metas[0]).toMatchObject({ pubkey: KLEND_PROGRAM_ID, isWritable: false });
    f.view.allocations.forEach((a, i) => {
      expect(metas[1 + i]).toMatchObject({ pubkey: a.reserve, isWritable: true });
      expect(metas[1 + n + i]).toMatchObject({ pubkey: a.market, isWritable: false });
    });
  });

  it("adds the nine extras in kvault.rs's order, then the writable duplicates", () => {
    const metas = kvaultRemaining(f.view, { writableMint: mint });
    const extras = metas.slice(1 + 2 * n);
    const source = pickSource(f.view);
    const event = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], KVAULT_PROGRAM_ID)[0];
    const config = PublicKey.findProgramAddressSync([Buffer.from("global_config")], KVAULT_PROGRAM_ID)[0];
    const lma = PublicKey.findProgramAddressSync([Buffer.from("lma"), source.market.toBuffer()], KLEND_PROGRAM_ID)[0];
    expect(extras.map((m) => m.pubkey.toBase58())).toEqual(
      [
        f.view.tokenVault,
        f.view.baseVaultAuthority,
        event,
        config,
        source.ctokenVault,
        lma,
        source.liquiditySupply,
        source.collateralMint,
        SYSVAR_INSTRUCTIONS_PUBKEY,
        // The vault state and the mint, passed writable again: the message
        // takes the union of a key's flags, which is what makes the pinned
        // read-only slot writable for the CPI.
        f.view.vault,
        mint,
      ].map((k) => k.toBase58()),
    );
    expect(extras.slice(-2).every((m) => m.isWritable)).toBe(true);
    // The two writable accounts the vault's withdraw writes in the source reserve.
    expect(extras[6]).toMatchObject({ isWritable: true });
    expect(extras[7]).toMatchObject({ isWritable: true });
  });

  it("leaves the mint out unless a redeem asks for it", () => {
    const metas = kvaultRemaining(f.view);
    expect(metas.map((m) => m.pubkey.toBase58())).not.toContain(mint.toBase58());
    expect(metas.at(-1)?.pubkey.toBase58()).toBe(f.view.vault.toBase58());
  });
});
