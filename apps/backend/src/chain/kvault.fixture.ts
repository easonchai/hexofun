// A synthetic Kamino Earn vault for unit tests: a VaultState buffer with the
// fields `kvault.ts` reads, and one klend Reserve buffer per allocation. Not a
// full account, only the offsets the decoder touches.
import { Keypair, PublicKey } from "@solana/web3.js";

import { decodeKvaultView, KVAULT_PROGRAM_ID, type KvaultView } from "./kvault";

const ALLOCATIONS = 312;
const ALLOCATION_SIZE = 2160;
/** The fixture vault's idle tokens. */
export const IDLE = 700n;

export interface FixtureAllocation {
  readonly ctokens: bigint;
  readonly available: bigint;
  /** An empty slot between two real ones, to prove slot order is by slot. */
  readonly emptyBefore?: boolean;
}

export interface KvaultFixture {
  readonly view: KvaultView;
  readonly vaultData: Buffer;
  readonly reserveData: Map<string, Buffer>;
  readonly reserves: PublicKey[];
}

const key = (): PublicKey => Keypair.generate().publicKey;

export function kvaultFixture(allocations: readonly FixtureAllocation[]): KvaultFixture {
  const vault = key();
  const data = Buffer.alloc(8 + 62_544);
  const put = (offset: number, value: PublicKey) => value.toBuffer().copy(data, offset);
  put(40, key()); // base vault authority
  put(80, key()); // token mint
  put(120, key()); // token vault
  put(184, key()); // shares mint
  put(58_568, key()); // lookup table
  data.writeBigUInt64LE(IDLE, 224); // idle tokens

  const reserveData = new Map<string, Buffer>();
  const reserves: PublicKey[] = [];
  let slot = 0;
  for (const allocation of allocations) {
    if (allocation.emptyBefore) slot += 1;
    const base = ALLOCATIONS + slot * ALLOCATION_SIZE;
    const reserve = key();
    reserves.push(reserve);
    put(base, reserve);
    put(base + 32, key()); // ctoken vault
    data.writeBigUInt64LE(allocation.ctokens, base + 1104);
    const reserveBytes = Buffer.alloc(2600);
    key().toBuffer().copy(reserveBytes, 32); // lending market
    key().toBuffer().copy(reserveBytes, 160); // liquidity supply
    reserveBytes.writeBigUInt64LE(allocation.available, 224);
    key().toBuffer().copy(reserveBytes, 2560); // collateral mint
    reserveData.set(reserve.toBase58(), reserveBytes);
    slot += 1;
  }
  return {
    view: decodeKvaultView(vault, data, reserveData),
    vaultData: data,
    reserveData,
    reserves,
  };
}

export { KVAULT_PROGRAM_ID };
