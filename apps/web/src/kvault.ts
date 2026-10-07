// Mirror of apps/backend/src/chain/kvault.ts (the web and backend share no
// package). Keep the two in step.
// A Kamino Earn vault (kVault) as the pool's venue (venue-switch ticket 06,
// programs/hex_vault/src/kvault.rs). Reads the vault state and its allocation
// reserves and derives the accounts the program wants as remaining accounts,
// so the console never takes a venue address from env: the pool pins the
// vault, the vault names everything else.
//
// Offsets are the VaultState and klend Reserve layouts with their 8-byte
// discriminators, as the spike read them off the account and as the
// kvault-interface crate lays them out (a Rust test in kvault.rs pins the same
// numbers).
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type AccountMeta,
  type Connection,
} from "@solana/web3.js";

export const KVAULT_PROGRAM_ID = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
export const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const VAULT = {
  baseVaultAuthority: 40,
  tokenMint: 80,
  tokenVault: 120,
  tokenAvailable: 224,
  sharesMint: 184,
  allocations: 312,
  allocationSize: 2160,
  allocationCount: 25,
  // inside one allocation
  reserve: 0,
  ctokenVault: 32,
  ctokenAllocation: 1104,
  lookupTable: 58_568,
} as const;
const VAULT_ACCOUNT_SIZE = 8 + 62_544;

const RESERVE = {
  lendingMarket: 32,
  liquiditySupplyVault: 160,
  availableAmount: 224,
  collateralMint: 2560,
} as const;

const pk = (data: Buffer, offset: number): PublicKey =>
  new PublicKey(data.subarray(offset, offset + 32));

/** One non-empty allocation: the reserve, the vault's cToken vault for it and
 *  what the program needs to withdraw from it. */
export interface KvaultAllocation {
  readonly reserve: PublicKey;
  readonly ctokenVault: PublicKey;
  /** cTokens the vault holds in this reserve. */
  readonly ctokens: bigint;
  readonly market: PublicKey;
  readonly liquiditySupply: PublicKey;
  readonly collateralMint: PublicKey;
  /** The reserve's free liquidity, USDC atomic units. */
  readonly available: bigint;
}

export interface KvaultView {
  readonly vault: PublicKey;
  readonly program: PublicKey;
  readonly tokenMint: PublicKey;
  readonly tokenVault: PublicKey;
  readonly baseVaultAuthority: PublicKey;
  readonly sharesMint: PublicKey;
  /** The vault's idle tokens, USDC atomic units. */
  readonly idle: bigint;
  /** The vault's own address lookup table; the pool's transactions need it. */
  readonly lookupTable: PublicKey;
  /** Non-empty allocation slots, in slot order: the order the program reads. */
  readonly allocations: readonly KvaultAllocation[];
}

const isDefault = (key: PublicKey): boolean => key.equals(PublicKey.default);

/** The reserves a vault allocates to, in slot order. Fetch these, then decode. */
export function allocationReserves(vaultData: Buffer): PublicKey[] {
  if (vaultData.length < VAULT_ACCOUNT_SIZE) {
    throw new Error(`kVault state is ${vaultData.length} bytes, expected ${VAULT_ACCOUNT_SIZE}`);
  }
  const reserves: PublicKey[] = [];
  for (let i = 0; i < VAULT.allocationCount; i++) {
    const reserve = pk(vaultData, VAULT.allocations + i * VAULT.allocationSize + VAULT.reserve);
    if (!isDefault(reserve)) reserves.push(reserve);
  }
  return reserves;
}

/**
 * Decodes the vault state and its allocation reserves. `reserveData` holds
 * each reserve's account data by base58 address; a missing reserve is an
 * error, because the program refuses a reserve list that is not the vault's.
 */
export function decodeKvaultView(
  vault: PublicKey,
  vaultData: Buffer,
  reserveData: ReadonlyMap<string, Buffer>,
  program: PublicKey = KVAULT_PROGRAM_ID,
): KvaultView {
  const allocations: KvaultAllocation[] = [];
  for (let i = 0; i < VAULT.allocationCount; i++) {
    const base = VAULT.allocations + i * VAULT.allocationSize;
    const reserve = pk(vaultData, base + VAULT.reserve);
    if (isDefault(reserve)) continue;
    const data = reserveData.get(reserve.toBase58());
    if (!data) throw new Error(`no data for allocation reserve ${reserve.toBase58()}`);
    allocations.push({
      reserve,
      ctokenVault: pk(vaultData, base + VAULT.ctokenVault),
      ctokens: vaultData.readBigUInt64LE(base + VAULT.ctokenAllocation),
      market: pk(data, RESERVE.lendingMarket),
      liquiditySupply: pk(data, RESERVE.liquiditySupplyVault),
      collateralMint: pk(data, RESERVE.collateralMint),
      available: data.readBigUInt64LE(RESERVE.availableAmount),
    });
  }
  return {
    vault,
    program,
    tokenMint: pk(vaultData, VAULT.tokenMint),
    tokenVault: pk(vaultData, VAULT.tokenVault),
    baseVaultAuthority: pk(vaultData, VAULT.baseVaultAuthority),
    sharesMint: pk(vaultData, VAULT.sharesMint),
    idle: vaultData.readBigUInt64LE(VAULT.tokenAvailable),
    lookupTable: pk(vaultData, VAULT.lookupTable),
    allocations,
  };
}

/** Reads the vault and its reserves in two RPC calls. */
export async function fetchKvaultView(
  connection: Connection,
  vault: PublicKey,
  program: PublicKey = KVAULT_PROGRAM_ID,
): Promise<KvaultView> {
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`kVault state ${vault.toBase58()} does not exist`);
  const reserves = allocationReserves(info.data);
  const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
  const data = new Map<string, Buffer>();
  reserves.forEach((reserve, i) => {
    const reserveInfo = infos[i];
    if (!reserveInfo) throw new Error(`allocation reserve ${reserve.toBase58()} does not exist`);
    data.set(reserve.toBase58(), reserveInfo.data);
  });
  return decodeKvaultView(vault, info.data, data, program);
}

/**
 * The reserve a redeem draws from after the vault's idle tokens: the funded
 * allocation with the most free liquidity, which is what the spike used. A
 * redeem larger than idle plus that reserve's liquidity pays short, and the
 * program books what arrived.
 */
export function pickSource(view: KvaultView): KvaultAllocation {
  const funded = view.allocations.filter((a) => a.ctokens > 0n);
  const [best] = [...funded].sort((a, b) => (a.available > b.available ? -1 : a.available < b.available ? 1 : 0));
  if (!best) throw new Error(`kVault ${view.vault.toBase58()} has no funded allocation to redeem from`);
  return best;
}

const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable,
});

export interface KvaultRemainingOptions {
  /** The pool's accepted mint, passed writable because the vault's withdraw
   *  writes it. Only a redeem needs it. */
  readonly writableMint?: PublicKey;
  /** Skips the extras: a call that only values the position (sync). */
  readonly valueOnly?: boolean;
}

/**
 * The remaining accounts of a kVault pool, in the order kvault.rs documents:
 * the klend program, the allocation reserves (writable), their markets, then
 * nine extras, then the writable duplicates a CPI needs.
 *
 * The vault state is pinned in the `klend_market` slot, which every
 * instruction declares read-only, and the deposit and withdraw CPIs write it.
 * A transaction message gives a key the union of its flags, so the duplicate
 * writable meta at the end is what makes it writable. The same goes for the
 * accepted mint on a redeem.
 */
export function kvaultRemaining(
  view: KvaultView,
  options: KvaultRemainingOptions = {},
): AccountMeta[] {
  const prefix = [
    meta(KLEND_PROGRAM_ID, false),
    ...view.allocations.map((a) => meta(a.reserve, true)),
    ...view.allocations.map((a) => meta(a.market, false)),
  ];
  if (options.valueOnly) return prefix;
  const source = pickSource(view);
  const derive = (seeds: Buffer[], program: PublicKey): PublicKey =>
    PublicKey.findProgramAddressSync(seeds, program)[0];
  return [
    ...prefix,
    meta(view.tokenVault, true),
    meta(view.baseVaultAuthority, false),
    meta(derive([Buffer.from("__event_authority")], view.program), false),
    meta(derive([Buffer.from("global_config")], view.program), false),
    meta(source.ctokenVault, true),
    meta(derive([Buffer.from("lma"), source.market.toBuffer()], KLEND_PROGRAM_ID), false),
    meta(source.liquiditySupply, true),
    meta(source.collateralMint, true),
    meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
    meta(view.vault, true),
    ...(options.writableMint ? [meta(options.writableMint, true)] : []),
  ];
}
