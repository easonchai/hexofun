// klend backing against a Surfpool mainnet fork (yield-claimer ticket 12).
// Not part of `tests/run-local.sh`: the file name has no `.test.`, so vitest's
// default include skips it. Run it with `tests/fork/run-fork.sh`, which starts
// Surfpool, deploys the plain build (no test-vrf, no test-venue) and runs this
// file with `tests/fork/vitest.config.ts`.
//
// The pool pins mainnet's USDC reserve on Kamino's main market. Fork rules
// from yield-claimer progress-01, "Fork config for ticket 12":
//  - reset the reserve, the liquidity vault and the cToken mint back to back
//    before the first klend deposit or redeem, so the fork holds one coherent
//    snapshot (`resetKlend`);
//  - move the clock with `surfnet_timeTravel` and `absoluteTimestamp` only.
// The refresh is the batch one that skips prices, so the Scope feed does not
// matter here.
//
// Every transaction's compute is logged as `CU <label> <units>`; those lines
// are the numbers in progress-12.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type AccountMeta,
} from "@solana/web3.js";
import {
  createAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  nextPoolId,
  playerPda,
  poolPda,
  principalVaultPda,
  jackpotVaultPda,
  program,
  provider,
  sleep,
  sleepUntilOnChain,
  venueProposalPda,
  WEIGHT_TREE_SPACE,
} from "../helpers/hx.js";

const TIMEOUT = 180_000;
const USDC_UNIT = 1_000_000n;
const connection = provider.connection;

// Mainnet, read 2026-10-04 (progress-01).
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const LIQ_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6");
const CMINT = new PublicKey("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");
const LMA = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND)[0];
// Solana's account-compression no-op: accepts any instruction, does nothing.
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");

interface Venue {
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
}

interface ForkPool {
  poolId: bigint;
  pool: PublicKey;
  admin: Keypair;
  operator: Keypair;
  treasury: PublicKey;
  jackpotVault: PublicKey;
  principalVault: PublicKey;
  venue: Venue;
}

interface Wallet {
  keypair: Keypair;
  tokenAccount: PublicKey;
}

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable,
});

/** What a deposit or redeem hands klend beyond the four pinned accounts, in
 *  the order `klend.rs` documents. */
const klendRemaining = (): AccountMeta[] => [
  meta(LMA, false),
  meta(LIQ_SUPPLY, true),
  meta(CMINT, true),
  meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
];

async function surf(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Refetches the reserve, its liquidity vault and the cToken mint together. */
async function resetKlend(): Promise<void> {
  await Promise.all(
    [RESERVE, LIQ_SUPPLY, CMINT].map((key) => surf("surfnet_resetAccount", [key.toBase58()])),
  );
}

async function chainNowSeconds(): Promise<number> {
  const time = await connection.getBlockTime(await connection.getSlot());
  if (time === null) throw new Error("no block time");
  return time;
}

/** Jumps the fork clock forward. Never call `surfnet_timeTravel` with no
 *  params: it skips about 9,000 slots. */
async function timeTravel(seconds: number): Promise<void> {
  const target = (await chainNowSeconds()) + seconds;
  await surf("surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
  await sleep(1_500);
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * 1_000_000_000);
  await connection.confirmTransaction(signature, "confirmed");
}

async function setTokenBalance(owner: PublicKey, mint: PublicKey, amount: bigint): Promise<void> {
  await surf("surfnet_setTokenAccount", [
    owner.toBase58(),
    mint.toBase58(),
    { amount: Number(amount) },
    TOKEN_PROGRAM_ID.toBase58(),
  ]);
}

const tokenBalance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await connection.getTokenAccountBalance(account)).value.amount);

/** The pool's value in the reserve, worked out here from the raw account the
 *  way klend does: floor(cTokens x total supply / cToken supply). Offsets are
 *  klend's Reserve with its 8-byte discriminator. */
async function reserveValue(ctokens: bigint): Promise<bigint> {
  const data = (await connection.getAccountInfo(RESERVE, "confirmed"))!.data;
  const u64 = (o: number) => data.readBigUInt64LE(o);
  const u128 = (o: number) => u64(o) + (u64(o + 8) << 64n);
  const supplySf = (u64(224) << 60n) + u128(232) - u128(344) - u128(360) - u128(376);
  const ctokenSupply = u64(2592);
  if (ctokenSupply === 0n || supplySf === 0n) return ctokens;
  return ((ctokens * supplySf) / ctokenSupply) >> 60n;
}

const within = (a: bigint, b: bigint, tolerance = 1n): boolean =>
  (a > b ? a - b : b - a) <= tolerance;

async function createForkPool(pin?: Partial<Venue>): Promise<ForkPool> {
  const poolId = nextPoolId();
  const pool = poolPda(poolId);
  const admin = Keypair.generate();
  const operator = Keypair.generate();
  await airdrop(admin.publicKey, 10);
  await airdrop(operator.publicKey, 10);

  const venue: Venue = {
    klendProgram: KLEND,
    klendMarket: MARKET,
    klendReserve: RESERVE,
    klendCtoken: getAssociatedTokenAddressSync(CMINT, pool, true),
    ...pin,
  };
  // The pool's cToken account: the pool PDA's cUSDC ATA, empty.
  await setTokenBalance(pool, CMINT, 0n);

  const treasury = await createAccount(connection, operator, USDC, operator.publicKey, Keypair.generate());
  const buybackReserve = await createAccount(connection, operator, USDC, operator.publicKey, Keypair.generate());
  const principalVault = principalVaultPda(pool);
  const jackpotVault = jackpotVaultPda(pool);
  const weightTree = Keypair.generate();

  await program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(86_400),
      epochAnchor: new BN(await chainNowSeconds()),
      roundSeconds: new BN(60),
      closeBuffer: new BN(5),
      // 180 is the floor outside a test-vrf build.
      vrfTimeout: new BN(180),
      minDeposit: new BN(1_000_000),
      houseCutBps: 600,
      minJackpot: new BN(0),
      payoutTimeout: new BN(82_800),
      baseRateBps: 488,
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
      venueKind: 0,
    })
    .accountsPartial({
      payer: operator.publicKey,
      pool,
      acceptedMint: USDC,
      principalVault,
      jackpotVault,
      house: playerPda(pool, operator.publicKey),
      weightTree: weightTree.publicKey,
      treasury,
      buybackReserve,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      SystemProgram.createAccount({
        fromPubkey: operator.publicKey,
        newAccountPubkey: weightTree.publicKey,
        space: WEIGHT_TREE_SPACE,
        lamports: await connection.getMinimumBalanceForRentExemption(WEIGHT_TREE_SPACE),
        programId: program.programId,
      }),
    ])
    .signers([operator, weightTree])
    .rpc();

  return { poolId, pool, admin, operator, treasury, jackpotVault, principalVault, venue };
}

async function fundedWallet(usdc: bigint): Promise<Wallet> {
  const keypair = Keypair.generate();
  await airdrop(keypair.publicKey, 5);
  await setTokenBalance(keypair.publicKey, USDC, usdc * USDC_UNIT);
  return { keypair, tokenAccount: getAssociatedTokenAddressSync(USDC, keypair.publicKey) };
}

const fetchPool = (f: ForkPool) => program.account.pool.fetch(f.pool);

/** Waits until the chain clock is past the pool's last sync, so the next sync
 *  is not swallowed by the same-second no-op. */
async function pastLastSync(f: ForkPool): Promise<void> {
  await sleepUntilOnChain(Number((await fetchPool(f)).lastSyncAt.toString()) + 1);
}

const cus: Record<string, number> = {};

/** Sends the builder's instruction and logs the compute it used. */
async function send(
  label: string,
  builder: { rpc: () => Promise<string> },
): Promise<string> {
  const signature = await builder.rpc();
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const used = tx?.meta?.computeUnitsConsumed ?? 0;
  cus[label] = used;
  console.log(`CU ${label} ${used}`);
  return signature;
}

function depositMethod(f: ForkPool, owner: Wallet, amount: bigint, venue: Venue = f.venue) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: f.pool,
      player: playerPda(f.pool, owner.keypair.publicKey),
      acceptedMint: USDC,
      ownerToken: owner.tokenAccount,
      principalVault: f.principalVault,
      ...venue,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair]);
}

function deployMethod(f: ForkPool, amount: bigint) {
  return program.methods
    .deployToVenue(new BN(amount.toString()))
    .accountsPartial({
      pool: f.pool,
      principalVault: f.principalVault,
      acceptedMint: USDC,
      ...f.venue,
      venueProposal: venueProposalPda(f.pool),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(klendRemaining());
}

function recallMethod(f: ForkPool, amount: bigint) {
  return program.methods
    .recall(new BN(amount.toString()))
    .accountsPartial({
      pool: f.pool,
      principalVault: f.principalVault,
      acceptedMint: USDC,
      ...f.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(klendRemaining());
}

function harvestMethod(f: ForkPool) {
  return program.methods
    .harvest()
    .accountsPartial({
      pool: f.pool,
      principalVault: f.principalVault,
      jackpotVault: f.jackpotVault,
      treasury: f.treasury,
      acceptedMint: USDC,
      ...f.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(klendRemaining());
}

/** Runs `promise`, which must fail; returns the message and the logs. */
async function failure(promise: Promise<unknown>): Promise<{ text: string; logs: string[] }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { message?: string; logs?: string[]; transactionLogs?: string[] };
    const logs = e.logs ?? e.transactionLogs ?? [];
    return { text: `${e.message ?? String(error)}\n${logs.join("\n")}`, logs };
  }
  throw new Error("expected the call to fail");
}

describe("klend backing on a mainnet fork", () => {
  let f: ForkPool;
  let alice: Wallet;
  let ctoken: PublicKey;

  beforeAll(async () => {
    await resetKlend();
    f = await createForkPool();
    ctoken = f.venue.klendCtoken;
    alice = await fundedWallet(20_000n);
  }, TIMEOUT);

  afterAll(() => {
    console.log(`CU summary ${JSON.stringify(cus)}`);
  });

  it("deposits, then deploys into klend and books exactly the reserve's value", async () => {
    await send("deposit (sync, no gain yet)", depositMethod(f, alice, 10_000n * USDC_UNIT));
    await pastLastSync(f);

    const vaultBefore = await tokenBalance(f.principalVault);
    await send("deploy_to_venue 9000 USDC", deployMethod(f, 9_000n * USDC_UNIT));

    // klend deposits the liquidity that whole cTokens are worth, which can be a
    // unit under the amount asked, depending on the reserve's live rate.
    const moved = vaultBefore - (await tokenBalance(f.principalVault));
    expect(moved <= 9_000n * USDC_UNIT && within(moved, 9_000n * USDC_UNIT, 2n)).toBe(true);
    const held = await tokenBalance(ctoken);
    expect(held > 0n).toBe(true);
    const pool = await fetchPool(f);
    const value = await reserveValue(held);
    expect(within(big(pool.venueValue), value)).toBe(true);
    // The venue credits what was deposited, less rounding.
    expect(within(value, 9_000n * USDC_UNIT, 2n)).toBe(true);
  }, TIMEOUT);

  it("syncs after hours pass, with no refresh instruction from the caller", async () => {
    const before = await fetchPool(f);
    await timeTravel(6 * 3_600);

    // The reserve was last refreshed hours of chain time ago and nobody has
    // touched it since. A plain deposit syncs first.
    const bob = await fundedWallet(1_000n);
    await send("deposit with sync after 6h", depositMethod(f, bob, 100n * USDC_UNIT));

    const pool = await fetchPool(f);
    expect(big(pool.lastSyncAt) - big(before.lastSyncAt) >= 6n * 3_600n).toBe(true);
    expect(big(pool.venueValue) > big(before.venueValue)).toBe(true);
    expect(within(big(pool.venueValue), await reserveValue(await tokenBalance(ctoken)))).toBe(true);
    const gain = big(pool.venueValue) - big(before.venueValue);
    expect(big(pool.feeOwed) + big(pool.yieldOwed) + big(pool.prizeOwed)).toBe(gain);
  }, TIMEOUT);

  it("recalls into the vault at the reserve's exchange rate", async () => {
    // A refund of 1,000 of the pending deposit pays out the whole idle band,
    // which pulls free idle under target.
    await pastLastSync(f);
    await send("request_withdraw 1000 USDC (refund from free idle)", requestWithdrawMethod(f, alice, 1_000n * USDC_UNIT));
    await pastLastSync(f);

    const vaultBefore = await tokenBalance(f.principalVault);
    const ctokensBefore = await tokenBalance(ctoken);
    const amount = 800n * USDC_UNIT;
    await send("recall 800 USDC (redeem)", recallMethod(f, amount));

    const received = (await tokenBalance(f.principalVault)) - vaultBefore;
    expect(received >= amount && received <= amount + 2n).toBe(true);
    const ctokensAfter = await tokenBalance(ctoken);
    expect(ctokensAfter < ctokensBefore).toBe(true);
    const pool = await fetchPool(f);
    expect(within(big(pool.venueValue), await reserveValue(ctokensAfter))).toBe(true);
    // The cTokens burned were worth what came back.
    const burnedValue = (await reserveValue(ctokensBefore)) - (await reserveValue(ctokensAfter));
    expect(within(burnedValue, received, 2n)).toBe(true);
  }, TIMEOUT);

  it("harvests the fee into the treasury, redeeming from klend", async () => {
    await timeTravel(2 * 3_600);
    const before = await fetchPool(f);
    const treasuryBefore = await tokenBalance(f.treasury);
    const jackpotBefore = await tokenBalance(f.jackpotVault);

    await send("harvest (sync + redeem + 2 transfers)", harvestMethod(f));

    const pool = await fetchPool(f);
    expect(big(pool.feeOwed)).toBe(0n);
    expect(big(pool.prizeOwed)).toBe(0n);
    const paidFee = (await tokenBalance(f.treasury)) - treasuryBefore;
    const paidPrize = (await tokenBalance(f.jackpotVault)) - jackpotBefore;
    expect(paidFee > 0n).toBe(true);
    // Sync inside the call books the 2 h gain first, so paid is at least what
    // was owed before it, and the dust the redeem cost comes off the fee.
    expect(paidFee + paidPrize >= big(before.feeOwed) + big(before.prizeOwed) - 2n).toBe(true);
    expect(within(big(pool.venueValue), await reserveValue(await tokenBalance(ctoken)))).toBe(true);
  }, TIMEOUT);

  it("refuses a redeem above the reserve's free liquidity before any CPI", async () => {
    await send("shutdown", program.methods.shutdown().accountsPartial({ admin: f.admin.publicKey, pool: f.pool }).signers([f.admin]));
    // Move all but 100 USDC of the reserve's free liquidity into "borrowed",
    // keeping the total supply the same, so it holds less than the 800 USDC
    // asked for while the position is still worth far more.
    const info = (await connection.getAccountInfo(RESERVE, "confirmed"))!;
    const data = Buffer.from(info.data);
    const available = data.readBigUInt64LE(224);
    const keep = 100n * USDC_UNIT;
    const moved = available - keep;
    data.writeBigUInt64LE(keep, 224);
    const borrowedSf = data.readBigUInt64LE(232) + (data.readBigUInt64LE(240) << 64n);
    const next = borrowedSf + (moved << 60n);
    data.writeBigUInt64LE(next & 0xffff_ffff_ffff_ffffn, 232);
    data.writeBigUInt64LE(next >> 64n, 240);
    await surf("surfnet_setAccount", [
      RESERVE.toBase58(),
      { lamports: info.lamports, data: data.toString("hex"), owner: info.owner.toBase58(), executable: false },
    ]);

    await pastLastSync(f);
    const { text, logs } = await failure(recallMethod(f, 800n * USDC_UNIT).rpc());
    expect(text).toContain("VenueIlliquid");
    // The refresh CPI ran; the redeem CPI did not.
    expect(logs.join("\n")).toContain("Instruction: RefreshReservesBatch");
    expect(logs.join("\n")).not.toContain("Instruction: RedeemReserveCollateral");
    await resetKlend();
  }, TIMEOUT);

  it("refuses a reserve, market, program or cToken account the pool did not pin", async () => {
    const carol = await fundedWallet(1_000n);
    const other = Keypair.generate().publicKey;
    for (const [field, expected] of [
      ["klendReserve", "VenueMismatch"],
      ["klendMarket", "VenueMismatch"],
      ["klendProgram", "VenueMismatch"],
      ["klendCtoken", "VenueMismatch"],
    ] as const) {
      const { text, logs } = await failure(
        depositMethod(f, carol, 10n * USDC_UNIT, { ...f.venue, [field]: other }).rpc(),
      );
      expect(text, field).toContain(expected);
      expect(logs.join("\n"), field).not.toContain("Instruction: RefreshReservesBatch");
    }
  }, TIMEOUT);

  it("fails with ReserveStale when the refresh leaves the reserve stale", async () => {
    // A pool pinned to the no-op program, with a copy of the real reserve
    // that the no-op owns: its refresh CPI succeeds and changes nothing, so
    // the copy keeps the slot it was copied at.
    await resetKlend();
    const real = (await connection.getAccountInfo(RESERVE, "confirmed"))!;
    const fake = Keypair.generate().publicKey;
    await surf("surfnet_setAccount", [
      fake.toBase58(),
      { lamports: real.lamports, data: real.data.toString("hex"), owner: NOOP.toBase58(), executable: false },
    ]);
    const g = await createForkPool({ klendProgram: NOOP, klendReserve: fake });
    const dave = await fundedWallet(1_000n);
    await sleep(1_500);
    const { text } = await failure(depositMethod(g, dave, 10n * USDC_UNIT).rpc());
    expect(text).toContain("ReserveStale");
  }, TIMEOUT);
});

// Ticket 22: the one withdraw. The part of the amount that is still a pending
// deposit refunds in the same transaction. Every deposit on these pools is
// pending, since no epoch has begun.
function requestWithdrawMethod(f: ForkPool, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: f.pool,
      player: playerPda(f.pool, owner.keypair.publicKey),
      acceptedMint: USDC,
      ownerToken: owner.tokenAccount,
      principalVault: f.principalVault,
      ...f.venue,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(klendRemaining())
    .signers([owner.keypair]);
}

// Yield-claimer ticket 09: the owner is paid in the same transaction, with the
// gap above free idle redeemed from the real reserve inside the instruction.
describe("pending refund on a mainnet fork", () => {
  let f: ForkPool;
  let alice: Wallet;
  let ctoken: PublicKey;

  beforeAll(async () => {
    await resetKlend();
    f = await createForkPool();
    ctoken = f.venue.klendCtoken;
    alice = await fundedWallet(20_000n);
    await send("deposit 10000 (refund setup)", depositMethod(f, alice, 10_000n * USDC_UNIT));
    await pastLastSync(f);
    await send("deploy_to_venue 9000 USDC (refund setup)", deployMethod(f, 9_000n * USDC_UNIT));
  }, TIMEOUT);

  afterAll(() => {
    console.log(`CU summary (refund) ${JSON.stringify(cus)}`);
  });

  it("pays from free idle without touching the reserve", async () => {
    await timeTravel(3_600);
    const ctokensBefore = await tokenBalance(ctoken);
    const walletBefore = await tokenBalance(alice.tokenAccount);

    await send(
      "request_withdraw 200 USDC (refund from free idle, sync + tree debit)",
      requestWithdrawMethod(f, alice, 200n * USDC_UNIT),
    );

    expect((await tokenBalance(alice.tokenAccount)) - walletBefore).toBe(200n * USDC_UNIT);
    expect(await tokenBalance(ctoken)).toBe(ctokensBefore);
    expect(await tokenBalance(f.principalVault)).toBe(800n * USDC_UNIT);
  }, TIMEOUT);

  it("redeems the gap from klend and pays in the same transaction", async () => {
    await timeTravel(3_600);
    const vaultBefore = await tokenBalance(f.principalVault);
    const ctokensBefore = await tokenBalance(ctoken);
    const walletBefore = await tokenBalance(alice.tokenAccount);
    const amount = 3_000n * USDC_UNIT;
    const gap = amount - vaultBefore;

    await send(
      "request_withdraw 3000 USDC (refund with sync + redeem + tree debit)",
      requestWithdrawMethod(f, alice, amount),
    );

    expect((await tokenBalance(alice.tokenAccount)) - walletBefore).toBe(amount);
    // The vault took in at least the gap and paid out the amount, so it ends
    // at the rounding dust the redeem overshot by.
    const vaultAfter = await tokenBalance(f.principalVault);
    expect(vaultAfter <= 2n).toBe(true);
    const ctokensAfter = await tokenBalance(ctoken);
    expect(ctokensAfter < ctokensBefore).toBe(true);
    const pool = await fetchPool(f);
    expect(within(big(pool.venueValue), await reserveValue(ctokensAfter))).toBe(true);
    // The cTokens burned were worth the gap.
    const burned = (await reserveValue(ctokensBefore)) - (await reserveValue(ctokensAfter));
    expect(within(burned, gap, 2n)).toBe(true);
  }, TIMEOUT);

  it("fails before any redeem CPI when the reserve is illiquid, and a refund the reserve can cover still works", async () => {
    // Move all but 100 USDC of the reserve's free liquidity into "borrowed",
    // keeping the total supply the same: the position is worth thousands, the
    // reserve can hand back 100.
    const info = (await connection.getAccountInfo(RESERVE, "confirmed"))!;
    const data = Buffer.from(info.data);
    const available = data.readBigUInt64LE(224);
    const keep = 100n * USDC_UNIT;
    data.writeBigUInt64LE(keep, 224);
    const borrowedSf = data.readBigUInt64LE(232) + (data.readBigUInt64LE(240) << 64n);
    const next = borrowedSf + ((available - keep) << 60n);
    data.writeBigUInt64LE(next & 0xffff_ffff_ffff_ffffn, 232);
    data.writeBigUInt64LE(next >> 64n, 240);
    await surf("surfnet_setAccount", [
      RESERVE.toBase58(),
      { lamports: info.lamports, data: data.toString("hex"), owner: info.owner.toBase58(), executable: false },
    ]);

    await pastLastSync(f);
    const before = await fetchPool(f);
    const walletBefore = await tokenBalance(alice.tokenAccount);
    const { text, logs } = await failure(requestWithdrawMethod(f, alice, 3_000n * USDC_UNIT).rpc());
    expect(text).toContain("VenueIlliquid");
    // The refresh CPI ran; the redeem CPI did not.
    expect(logs.join("\n")).toContain("Instruction: RefreshReservesBatch");
    expect(logs.join("\n")).not.toContain("Instruction: RedeemReserveCollateral");
    const after = await fetchPool(f);
    expect(after.totalPrincipal.toString()).toBe(before.totalPrincipal.toString());
    expect(await tokenBalance(alice.tokenAccount)).toBe(walletBefore);
    await resetKlend();

    // With the reserve liquid again the same call goes through.
    const walletAfterReset = await tokenBalance(alice.tokenAccount);
    await send(
      "request_withdraw 1000 USDC (refund after the reserve recovers)",
      requestWithdrawMethod(f, alice, 1_000n * USDC_UNIT),
    );
    expect((await tokenBalance(alice.tokenAccount)) - walletAfterReset).toBe(1_000n * USDC_UNIT);
    expect(big((await fetchPool(f)).pendingWithdrawals)).toBe(0n);
  }, TIMEOUT);
});

function setVenueParamsMethod(f: ForkPool, params: Record<string, number | bigint | null>) {
  const arg = (key: string) => {
    const v = params[key];
    return v === undefined || v === null ? null : typeof v === "bigint" ? new BN(v.toString()) : v;
  };
  return program.methods
    .setVenueParams({
      yieldFeeBps: arg("yieldFeeBps"),
      idleFloorBps: arg("idleFloorBps"),
      idleTargetBps: arg("idleTargetBps"),
      reserveShareCapBps: arg("reserveShareCapBps"),
      reserveLiquidityFloorBps: arg("reserveLiquidityFloorBps"),
      minVenueMove: arg("minVenueMove"),
      lossToleranceBps: arg("lossToleranceBps"),
    })
    .accountsPartial({ admin: f.admin.publicKey, pool: f.pool })
    .signers([f.admin]);
}

// Yield-claimer ticket 10: deploy respects the reserve-share cap and the
// reserve's minimum free liquidity, both read from the real reserve. A refused
// deploy fails after the refresh CPI and before any deposit CPI.
describe("deploy caps on a mainnet fork", () => {
  let f: ForkPool;
  let alice: Wallet;

  beforeAll(async () => {
    await resetKlend();
    f = await createForkPool();
    alice = await fundedWallet(20_000n);
    await send("deposit 10000 (deploy caps setup)", depositMethod(f, alice, 10_000n * USDC_UNIT));
  }, TIMEOUT);

  const noDepositCpi = (logs: string[]) => {
    expect(logs.join("\n")).toContain("Instruction: RefreshReservesBatch");
    expect(logs.join("\n")).not.toContain("Instruction: DepositReserveLiquidity");
  };

  it("refuses a deploy that takes the pool past its share of the reserve's supply", async () => {
    await pastLastSync(f);
    // Total supply as klend counts it, in USDC atomic units, from the raw reserve.
    const data = (await connection.getAccountInfo(RESERVE, "confirmed"))!.data;
    const u64 = (o: number) => data.readBigUInt64LE(o);
    const u128 = (o: number) => u64(o) + (u64(o + 8) << 64n);
    const supply = ((u64(224) << 60n) + u128(232) - u128(344) - u128(360) - u128(376)) >> 60n;
    const amount = 9_000n * USDC_UNIT;
    // The share, in bps, the pool would hold after the deploy. The reserve
    // accrues a little interest between this read and the transaction, so the
    // cap is set a percent either side of it, not on the line.
    const share = Number((amount * 10_000n * 1_000n) / (supply + amount)) / 1_000;
    const tight = Math.floor(share * 0.99);
    const loose = Math.ceil(share * 1.01) + 1;
    expect(loose <= 2_000).toBe(true);

    await send("set_venue_params (share cap under)", setVenueParamsMethod(f, { reserveShareCapBps: tight }));
    const { text, logs } = await failure(deployMethod(f, amount).rpc());
    expect(text).toContain("ReserveShareCapExceeded");
    noDepositCpi(logs);
    expect(big((await fetchPool(f)).venueValue)).toBe(0n);

    // A little more room and the same deploy fits.
    await send("set_venue_params (share cap over)", setVenueParamsMethod(f, { reserveShareCapBps: loose }));
    await pastLastSync(f);
    await send("deploy_to_venue 9000 USDC (inside the cap)", deployMethod(f, amount));
    expect(big((await fetchPool(f)).venueValue) > 0n).toBe(true);
  }, TIMEOUT);

  it("refuses a deploy that would leave the reserve under its minimum free liquidity", async () => {
    await resetKlend();
    const g = await createForkPool();
    const bob = await fundedWallet(20_000n);
    await send("deposit 10000 (liquidity floor setup)", depositMethod(g, bob, 10_000n * USDC_UNIT));
    await pastLastSync(g);

    // Move all but 100 USDC of the reserve's free liquidity into "borrowed",
    // keeping the total supply the same. The default floor is twice the pool's
    // position: 9,000 in leaves 9,100 free against 18,000 wanted.
    const info = (await connection.getAccountInfo(RESERVE, "confirmed"))!;
    const data = Buffer.from(info.data);
    const available = data.readBigUInt64LE(224);
    const keep = 100n * USDC_UNIT;
    data.writeBigUInt64LE(keep, 224);
    const borrowedSf = data.readBigUInt64LE(232) + (data.readBigUInt64LE(240) << 64n);
    const next = borrowedSf + ((available - keep) << 60n);
    data.writeBigUInt64LE(next & 0xffff_ffff_ffff_ffffn, 232);
    data.writeBigUInt64LE(next >> 64n, 240);
    await surf("surfnet_setAccount", [
      RESERVE.toBase58(),
      { lamports: info.lamports, data: data.toString("hex"), owner: info.owner.toBase58(), executable: false },
    ]);

    const { text, logs } = await failure(deployMethod(g, 9_000n * USDC_UNIT).rpc());
    expect(text).toContain("ReserveLiquidityTooLow");
    noDepositCpi(logs);
    expect(big((await fetchPool(g)).venueValue)).toBe(0n);
    await resetKlend();
  }, TIMEOUT);
});
