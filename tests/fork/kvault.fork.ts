// kVault spike against a Surfpool mainnet fork (venue-switch ticket 01).
// Deposits into the RockawayX RWA USDC Kamino Earn vault from a throwaway
// signer, values the position the way a program would (shares x AUM / shares
// issued, after refreshing every allocation reserve), and withdraws it all.
// Every transaction's compute is logged as `CU <label> <units>`, every
// account list as `ACC <label> ...`; the write-up in
// docs/plan/venue-switch/research/01-kvault-spike.md is built from those lines.
//
// Needs no hex_vault build: it only talks to klend and the kVault program.
// Run against a fork you started yourself (a keyed datasource goes in the
// environment, never a file):
//
//   SURF_RPC=http://127.0.0.1:9419 pnpm exec vitest run --config tests/fork/vitest.config.ts tests/fork/kvault.fork.ts
//
// The instruction layouts and the VaultState offsets come from the published
// kVault IDL and Kamino's TypeScript SDK (@kamino-finance/klend-sdk 13.0.2,
// read from the npm tarball, not installed). Nothing is copied from the kVault
// program source.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const rpc = process.env.SURF_RPC ?? process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:9419";
const connection = new Connection(rpc, "confirmed");

// Klend, as in klend.fork.ts.
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// kVault, read from Kamino's public API 2026-10-07.
const KVAULT_PROGRAM = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const VAULT = new PublicKey("DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP");
const SHARES_MINT = new PublicKey("DgHN3q3dSYAchNX7V3D4aYiTWMx8RHTgHbfPiwiqBkE9");
const TOKEN_VAULT = new PublicKey("6ea6GorjfT2SmUH8HSwg4LLae5RCqVVEYzcznBJEge9e");
const BASE_VAULT_AUTHORITY = new PublicKey("D6hDbSjooxfjXrfKo7xBKVFeoaJrtnXY75uAbxeFbPgU");
const LOOKUP_TABLE = new PublicKey("GzavHphVhGp9PERAfT3NcQwFesevQD386puHtVtsbq6m");

const GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("global_config")], KVAULT_PROGRAM)[0];
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], KVAULT_PROGRAM)[0];

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const DEPOSIT = disc("deposit");
const WITHDRAW = disc("withdraw");
const REFRESH_RESERVES_BATCH = disc("refresh_reserves_batch");

// VaultState offsets, 8-byte discriminator included. Derived from the SDK's
// borsh layout; the test asserts the ones it relies on against pinned keys.
const VS = {
  baseVaultAuthority: 40,
  tokenMint: 80,
  tokenVault: 120,
  sharesMint: 184,
  tokenAvailable: 224,
  sharesIssued: 232,
  prevAumSf: 280,
  pendingFeesSf: 296,
  allocations: 312,
  allocationSize: 2160,
  allocationCount: 25,
  // inside one allocation
  reserve: 0,
  ctokenVault: 32,
  ctokenAllocation: 1104,
  lastInvestSlot: 1112,
};
const ZERO = PublicKey.default;

// klend Reserve offsets, as klend.fork.ts uses them.
const RES = { lendingMarket: 32, availableAmount: 224, borrowedSf: 232, protocolFeesSf: 344, referrerFeesSf: 360, pendingReferrerFeesSf: 376, ctokenSupply: 2592, liquiditySupplyVault: 160, collateralMint: 2560 };

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number): bigint => u64(d, o) + (u64(d, o + 8) << 64n);
const pk = (d: Buffer, o: number): PublicKey => new PublicKey(d.subarray(o, o + 32));
const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

interface Allocation {
  reserve: PublicKey;
  ctokenVault: PublicKey;
  ctokenAllocation: bigint;
}

async function surf(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function vaultData(): Promise<Buffer> {
  return (await connection.getAccountInfo(VAULT, "confirmed"))!.data;
}

function allocations(data: Buffer): Allocation[] {
  const out: Allocation[] = [];
  for (let i = 0; i < VS.allocationCount; i++) {
    const base = VS.allocations + i * VS.allocationSize;
    const reserve = pk(data, base + VS.reserve);
    if (reserve.equals(ZERO)) continue;
    out.push({
      reserve,
      ctokenVault: pk(data, base + VS.ctokenVault),
      ctokenAllocation: u64(data, base + VS.ctokenAllocation),
    });
  }
  return out;
}

/** Underlying value of `ctokens` in a klend reserve: floor(c x supply / cSupply). */
function reserveValue(reserve: Buffer, ctokens: bigint): bigint {
  const supplySf =
    (u64(reserve, RES.availableAmount) << 60n) +
    u128(reserve, RES.borrowedSf) -
    u128(reserve, RES.protocolFeesSf) -
    u128(reserve, RES.referrerFeesSf) -
    u128(reserve, RES.pendingReferrerFeesSf);
  const ctokenSupply = u64(reserve, RES.ctokenSupply);
  if (ctokenSupply === 0n) return ctokens;
  return ((ctokens * supplySf) / ctokenSupply) >> 60n;
}

interface Aum {
  gross: bigint;
  net: bigint;
  issued: bigint;
  /** Value of `shares`, gross of pending fees and net of them. */
  value: (shares: bigint) => { gross: bigint; net: bigint };
}

/** Assets under management from raw accounts, the way a program would read them. */
async function readAum(): Promise<Aum> {
  const data = await vaultData();
  const allocs = allocations(data);
  const reserves = await connection.getMultipleAccountsInfo(allocs.map((a) => a.reserve), "confirmed");
  let gross = u64(data, VS.tokenAvailable);
  allocs.forEach((a, i) => {
    gross += reserveValue(reserves[i]!.data, a.ctokenAllocation);
  });
  const pending = u128(data, VS.pendingFeesSf) >> 60n;
  const net = gross - pending;
  const issued = u64(data, VS.sharesIssued);
  return {
    gross,
    net,
    issued,
    value: (shares) => ({ gross: (shares * gross) / issued, net: (shares * net) / issued }),
  };
}

/** The reserve and market pairs, reserves first then markets, the order the
 *  kVault deposit and withdraw read them from the remaining accounts. */
async function remainingReserves(allocs: Allocation[]): Promise<AccountMeta[]> {
  const reserves = await connection.getMultipleAccountsInfo(allocs.map((a) => a.reserve), "confirmed");
  const markets = reserves.map((r) => pk(r!.data, RES.lendingMarket));
  return [...allocs.map((a) => meta(a.reserve, true)), ...markets.map((m) => meta(m, false))];
}

/** One klend batch refresh for every allocation reserve: (reserve, market) pairs. */
async function refreshIx(allocs: Allocation[]): Promise<TransactionInstruction> {
  const reserves = await connection.getMultipleAccountsInfo(allocs.map((a) => a.reserve), "confirmed");
  const keys = allocs.flatMap((a, i) => [meta(a.reserve, true), meta(pk(reserves[i]!.data, RES.lendingMarket), false)]);
  // skip_price_updates = true, as the hex_vault klend backing does.
  return new TransactionInstruction({ programId: KLEND, keys, data: Buffer.concat([REFRESH_RESERVES_BATCH, Buffer.from([1])]) });
}

function depositIx(user: PublicKey, amount: bigint, remaining: AccountMeta[]): TransactionInstruction {
  const keys = [
    meta(user, true, true),
    meta(VAULT, true),
    meta(TOKEN_VAULT, true),
    meta(USDC, false),
    meta(BASE_VAULT_AUTHORITY, false),
    meta(SHARES_MINT, true),
    meta(getAssociatedTokenAddressSync(USDC, user), true),
    meta(getAssociatedTokenAddressSync(SHARES_MINT, user), true),
    meta(KLEND, false),
    meta(TOKEN_PROGRAM_ID, false),
    meta(TOKEN_PROGRAM_ID, false),
    meta(EVENT_AUTHORITY, false),
    meta(KVAULT_PROGRAM, false),
    ...remaining,
  ];
  return new TransactionInstruction({ programId: KVAULT_PROGRAM, keys, data: Buffer.concat([DEPOSIT, u64le(amount)]) });
}

/** `withdraw` pulls from the vault's idle tokens first, then from one reserve
 *  (the instruction's named accounts). The remaining accounts are the same
 *  reserve and market lists as deposit. */
async function withdrawIx(
  user: PublicKey,
  shares: bigint,
  from: Allocation,
  remaining: AccountMeta[],
): Promise<TransactionInstruction> {
  const reserve = (await connection.getAccountInfo(from.reserve, "confirmed"))!.data;
  const market = pk(reserve, RES.lendingMarket);
  const lma = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND)[0];
  const keys = [
    meta(user, false, true),
    meta(VAULT, true),
    meta(GLOBAL_CONFIG, false),
    meta(TOKEN_VAULT, true),
    meta(BASE_VAULT_AUTHORITY, false),
    meta(getAssociatedTokenAddressSync(USDC, user), true),
    meta(USDC, true),
    meta(getAssociatedTokenAddressSync(SHARES_MINT, user), true),
    meta(SHARES_MINT, true),
    meta(TOKEN_PROGRAM_ID, false),
    meta(TOKEN_PROGRAM_ID, false),
    meta(KLEND, false),
    meta(EVENT_AUTHORITY, false),
    meta(KVAULT_PROGRAM, false),
    meta(VAULT, true),
    meta(from.reserve, true),
    meta(from.ctokenVault, true),
    meta(market, false),
    meta(lma, false),
    meta(pk(reserve, RES.liquiditySupplyVault), true),
    meta(pk(reserve, RES.collateralMint), true),
    meta(TOKEN_PROGRAM_ID, false),
    meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
    meta(EVENT_AUTHORITY, false),
    meta(KVAULT_PROGRAM, false),
    ...remaining,
  ];
  return new TransactionInstruction({ programId: KVAULT_PROGRAM, keys, data: Buffer.concat([WITHDRAW, u64le(shares)]) });
}

let lookupTable: AddressLookupTableAccount | null = null;
async function table(): Promise<AddressLookupTableAccount> {
  lookupTable ??= (await connection.getAddressLookupTable(LOOKUP_TABLE)).value;
  if (!lookupTable) throw new Error("vault lookup table not found on the fork");
  return lookupTable;
}

interface Outcome {
  ok: boolean;
  cu: number;
  logs: string[];
  error?: string;
  accounts: number;
  bytes: number;
}

/** Sends one transaction (v0, vault lookup table) and returns its compute and logs. */
async function attempt(label: string, payer: Keypair, ixs: TransactionInstruction[]): Promise<Outcome> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
  }).compileToV0Message([await table()]);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const accounts = message.staticAccountKeys.length + message.addressTableLookups.reduce((n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length, 0);
  const bytes = tx.serialize().length;
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  let out: Outcome = { ok: !sim.value.err, cu: sim.value.unitsConsumed ?? 0, logs: sim.value.logs ?? [], accounts, bytes };
  if (sim.value.err) out.error = JSON.stringify(sim.value.err);
  if (out.ok) {
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    const landed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    out = { ...out, cu: landed?.meta?.computeUnitsConsumed ?? out.cu, ok: !landed?.meta?.err, logs: landed?.meta?.logMessages ?? out.logs };
  }
  console.log(`CU ${label} ${out.ok ? "ok" : "FAILED"} ${out.cu} accounts=${accounts} bytes=${bytes}${out.error ? ` err=${out.error}` : ""}`);
  return out;
}

const tokenBalance = async (account: PublicKey): Promise<bigint> => {
  try {
    return BigInt((await connection.getTokenAccountBalance(account, "confirmed")).value.amount);
  } catch {
    return 0n;
  }
};

describe("kVault spike: RockawayX RWA USDC vault", () => {
  it("deposits, values and withdraws, with and without reserve refreshes", { timeout: 300_000 }, async () => {
    // The vault matches what is pinned.
    const data = await vaultData();
    expect(pk(data, VS.baseVaultAuthority).equals(BASE_VAULT_AUTHORITY)).toBe(true);
    expect(pk(data, VS.tokenMint).equals(USDC)).toBe(true);
    expect(pk(data, VS.tokenVault).equals(TOKEN_VAULT)).toBe(true);
    expect(pk(data, VS.sharesMint).equals(SHARES_MINT)).toBe(true);
    const allocs = allocations(data);
    console.log(`VAULT allocations=${allocs.length} funded=${allocs.filter((a) => a.ctokenAllocation > 0n).length} tokenAvailable=${u64(data, VS.tokenAvailable)} sharesIssued=${u64(data, VS.sharesIssued)}`);
    // Fields past the allocation list, offsets from the SDK layout (allocations 312 + 25 x 2160, padding1 4096).
    console.log(
      `CONFIG name=${data.subarray(58528, 58568).toString().replace(/\0+$/, "")} perfBps=${u64(data, 256)} mgmtBps=${u64(data, 264)} minDeposit=${u64(data, 58408)} minWithdraw=${u64(data, 58416)} minInvest=${u64(data, 58424)} lookupTable=${pk(data, 58568).toBase58()} farm=${pk(data, 58600).toBase58()} unallocatedCap=${u64(data, 58640)} penaltyLamports=${u64(data, 58680)} penaltyBps=${u64(data, 58688)} depositCap=${u64(data, 58736)} permissioning=${pk(data, 58840).toBase58()}`,
    );
    expect(pk(data, 58568).equals(LOOKUP_TABLE)).toBe(true);
    allocs.forEach((a, i) => console.log(`ALLOC ${i} reserve=${a.reserve.toBase58()} ctokenVault=${a.ctokenVault.toBase58()} ctokens=${a.ctokenAllocation}`));

    // Fund a throwaway signer.
    const user = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(user.publicKey, 5_000_000_000), "confirmed");
    await surf("surfnet_setTokenAccount", [user.publicKey.toBase58(), USDC.toBase58(), { amount: 10_000_000_000 }, TOKEN_PROGRAM_ID.toBase58()]);
    const userUsdc = getAssociatedTokenAddressSync(USDC, user.publicKey);
    const userShares = getAssociatedTokenAddressSync(SHARES_MINT, user.publicKey);
    const createShares = createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userShares, user.publicKey, SHARES_MINT);
    const usdcBefore = await tokenBalance(userUsdc);

    const remaining = await remainingReserves(allocs);
    const refresh = await refreshIx(allocs);
    const amount = 500_000_000n; // 500 USDC per deposit

    // Refresh alone: the cost a program pays for the klend batch refresh CPI,
    // measured here as a top-level instruction.
    const refreshAlone = await attempt("refresh-batch-alone", user, [refresh]);
    expect(refreshAlone.ok).toBe(true);

    // Value, after a refresh, before the deposit.
    const aum0 = await readAum();
    console.log(`AUM fresh gross=${aum0.gross} net=${aum0.net} issued=${aum0.issued}`);

    // The deposit refreshes every reserve itself (klend RefreshReservesBatch
    // CPI inside the kVault program), so the reserves are fresh as of its slot
    // and a read right after it needs no refresh of ours.
    const value = async (label: string, paid: bigint) => {
      const shares = await tokenBalance(userShares);
      const aum = await readAum();
      const state = await vaultData();
      // prev_aum is the vault's own AUM at its last fee charge, the deposit's slot right after a deposit.
      console.log(`STATE ${label} prevAum=${u128(state, VS.prevAumSf) >> 60n} pendingFees=${u128(state, VS.pendingFeesSf) >> 60n} myGross=${aum.gross} myNet=${aum.net} issued=${aum.issued}`);
      const v = aum.value(shares);
      console.log(`VALUE ${label} shares=${shares} gross=${v.gross} net=${v.net} paid=${paid} diffGross=${v.gross - paid} diffNet=${v.net - paid}`);
      return { shares, v };
    };

    await attempt("create-shares-ata", user, [createShares]);

    // Deposit without a refresh in the transaction. The reserves have sat for
    // a few seconds, as they do between other people's touches on mainnet.
    await new Promise((r) => setTimeout(r, 3_000));
    const noRefresh = await attempt("deposit-no-refresh", user, [depositIx(user.publicKey, amount, remaining)]);
    console.log(`LOGS deposit-no-refresh ${noRefresh.logs.filter((l) => /Instruction|failed|Error|stale/i.test(l)).join(" | ")}`);
    expect(noRefresh.ok).toBe(true);
    const first = await value("after-deposit-1", amount);
    expect(first.shares).toBeGreaterThan(0n);
    // ponytail: tolerance, not 1 unit; see the write-up for why the formula lags the program's AUM by about 2.6e-8.
    expect(first.v.net - amount <= 100n && amount - first.v.net <= 100n).toBe(true);

    // Warm: the next slot, the reserves were refreshed by the deposit above.
    const warm = await attempt("deposit-no-refresh-warm", user, [depositIx(user.publicKey, 1_000_000n, remaining)]);
    expect(warm.ok).toBe(true);

    // Deposit with the refresh prepended.
    await new Promise((r) => setTimeout(r, 3_000));
    const withRefresh = await attempt("deposit-with-refresh", user, [refresh, depositIx(user.publicKey, amount, remaining)]);
    console.log(`LOGS deposit-with-refresh ${withRefresh.logs.filter((l) => /Instruction|failed|Error|stale/i.test(l)).join(" | ")}`);
    expect(withRefresh.ok).toBe(true);
    const second = await value("after-deposit-2", amount * 2n + 1_000_000n);
    const shares = second.shares;
    console.log(`DEPOSIT spent=${usdcBefore - (await tokenBalance(userUsdc))} shares1=${first.shares} shares2=${shares - first.shares}`);

    // Value after a separate refresh tx a few slots later: interest accrues.
    await attempt("refresh-batch-after-deposit", user, [refresh]);
    const v = (await value("after-separate-refresh", amount * 2n)).v;

    // Value from the stale reserve (no refresh) for comparison: how far apart.
    // (The reserves were refreshed one slot ago; this reads the same accounts, so drift shows after time passes.)
    await new Promise((r) => setTimeout(r, 5_000));
    const aumStale = await readAum();
    console.log(`VALUE stale-after-5s net=${aumStale.value(shares).net} (fresh net=${v.net})`);

    // Withdraw half without a refresh, the rest with one. The reserve to pull
    // from is the funded one with the most liquidity.
    const pool = await connection.getMultipleAccountsInfo(allocs.map((a) => a.reserve), "confirmed");
    const ranked = allocs
      .map((a, i) => ({ a, liquidity: u64(pool[i]!.data, RES.availableAmount) }))
      .filter((x) => x.a.ctokenAllocation > 0n)
      .sort((x, y) => (x.liquidity > y.liquidity ? -1 : 1));
    console.log(`LIQUIDITY ${ranked.map((x) => `${x.a.reserve.toBase58().slice(0, 6)}=${x.liquidity}`).join(" ")}`);
    const source = ranked[0]!.a;
    console.log(`WITHDRAW source reserve=${source.reserve.toBase58()}`);

    /** Withdraws `burn` shares in one tx and logs what came back against what the formula said. */
    const withdrawStep = async (label: string, burn: bigint, prefix: TransactionInstruction[]): Promise<Outcome> => {
      const expected = (await readAum()).value(burn).net;
      const before = await tokenBalance(userUsdc);
      const out = await attempt(label, user, [...prefix, await withdrawIx(user.publicKey, burn, source, remaining)]);
      const got = (await tokenBalance(userUsdc)) - before;
      console.log(`PAYOUT ${label} burned=${burn} got=${got} formula=${expected} diff=${got - expected}`);
      return out;
    };
    const part = (await tokenBalance(userShares)) / 3n;
    await new Promise((r) => setTimeout(r, 3_000));
    const wNo = await withdrawStep("withdraw-no-refresh", part, []);
    const wWarm = await withdrawStep("withdraw-no-refresh-warm", part, []);
    expect(wWarm.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 3_000));
    console.log(`LOGS withdraw-no-refresh ${wNo.logs.filter((l) => /Instruction|failed|Error|stale/i.test(l)).join(" | ")}`);
    const left = await tokenBalance(userShares);
    // A small one, to see whether the shortfall against the formula scales with size.
    await withdrawStep("withdraw-small", 1_000_000n, []);
    const wYes = await withdrawStep("withdraw-with-refresh", left, [refresh]);
    console.log(`LOGS withdraw-with-refresh ${wYes.logs.filter((l) => /Instruction|failed|Error|stale/i.test(l)).join(" | ")}`);
    expect(wYes.ok).toBe(true);

    const sharesAfter = await tokenBalance(userShares);
    const usdcAfter = await tokenBalance(userUsdc);
    const net = BigInt(Number(usdcBefore - usdcAfter)); // USDC lost across the whole round trip
    console.log(`ROUNDTRIP sharesLeft=${sharesAfter} usdcBefore=${usdcBefore} usdcAfter=${usdcAfter} lost=${net} (deposits 500 + 500 + 1 USDC; no-refresh deposit ok=${noRefresh.ok}, no-refresh withdraw ok=${wNo.ok})`);
    expect(sharesAfter).toBe(0n);
  });
});
