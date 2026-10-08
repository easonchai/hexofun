// The kVault backing against a Surfpool mainnet fork (venue-switch ticket 06):
// a pool pinned to the RockawayX RWA USDC Earn vault, bootstrapped through the
// real bootstrap script (VENUE_KIND=kvault), then driven through the operator's
// own instruction builders. Not part of `tests/run-local.sh` (no `.test.`).
//
// Run it against a fork `scripts/surf.sh up` started (the plain build is
// deployed there; the keyed datasource stays in the environment of surf.sh):
//
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:9471 ANCHOR_WALLET=$HOME/.config/solana/id.json \
//   HEXVAULT_IDL_PATH=.surf/hex_vault.json \
//   pnpm exec vitest run --config tests/fork/vitest.config.ts tests/fork/kvault.pool.fork.ts
//
// Fork rules from klend.fork.ts apply: reset every account of the position
// back to back before the first transaction so the fork holds one coherent
// snapshot, and move the clock with `surfnet_timeTravel` and
// `absoluteTimestamp` only.
//
// Every transaction's compute and size is logged as `CU <label> <units>
// bytes=<n>`; those lines are the numbers recorded next to the spike's.
//
// hex_vault's own transactions here are v0 with the vault's lookup table: the
// instructions name 40 to 60 accounts, which a legacy transaction cannot hold.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, type Idl, type Program } from "@anchor-lang/core";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { utils } from "@anchor-lang/core";

import {
  allocationReserves,
  fetchKvaultView,
  KVAULT_PROGRAM_ID,
  kvaultRemaining,
  sharesMintAddress,
  type KvaultView,
} from "../../apps/backend/src/chain/kvault";
import { decodePool, type PoolState } from "../../apps/backend/src/operator/chain-state";
import { OperatorInstructions } from "../../apps/backend/src/operator/instructions";
import {
  DEVNET_VRF_NETWORK_STATE,
  nextPoolId,
  playerPda,
  poolPda,
  principalVaultPda,
  jackpotVaultPda,
  program,
  provider,
  onChainNowSeconds,
  sleep,
  sleepUntilOnChain,
  PROGRAM_DATA,
} from "../helpers/hx.js";

const run = promisify(execFile);

/** The calls this file makes on an Anchor methods builder. */
interface Builder {
  accountsPartial(accounts: Record<string, PublicKey>): {
    remainingAccounts(metas: AccountMeta[]): { instruction(): Promise<TransactionInstruction> };
  };
}
const TIMEOUT = 300_000;
const USDC_UNIT = 1_000_000n;
const connection = provider.connection;
const idlProgram = program as unknown as Program<Idl>;

// Mainnet, read from Kamino's API 2026-10-07 and re-read from the vault state.
const VAULT = new PublicKey("DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP");
const SHARES_MINT = new PublicKey("DgHN3q3dSYAchNX7V3D4aYiTWMx8RHTgHbfPiwiqBkE9");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NOOP = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
// What the program takes off a position and prices a redeem with (kvault.rs `EXIT_COST`).
const EXIT_COST = 1_010n;
// The most a full redeem was measured to fall short of the formula by (the
// vault keeps 1,000, klend floors one more on a disinvest).
const MEASURED_EXIT = 1_001n;

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const bn = (n: bigint): BN => new BN(n.toString());

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

/** Never call `surfnet_timeTravel` with no params: it skips about 9,000 slots. */
async function timeTravel(seconds: number): Promise<void> {
  const target = (await onChainNowSeconds()) + seconds;
  await surf("surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
  await sleep(1_500);
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  await connection.confirmTransaction(await connection.requestAirdrop(to, sol * 1_000_000_000), "confirmed");
}

async function setUsdc(owner: PublicKey, amount: bigint): Promise<void> {
  await surf("surfnet_setTokenAccount", [owner.toBase58(), USDC.toBase58(), { amount: Number(amount) }, TOKEN_PROGRAM_ID.toBase58()]);
}

const tokenBalance = async (account: PublicKey): Promise<bigint> => {
  try {
    return BigInt((await connection.getTokenAccountBalance(account, "confirmed")).value.amount);
  } catch {
    return 0n;
  }
};

/** Every account of the position, refetched together. */
async function resetPosition(): Promise<void> {
  const info = await connection.getAccountInfo(VAULT, "confirmed");
  const reserves = allocationReserves(info!.data);
  const view = await fetchKvaultView(connection, VAULT);
  const keys = [
    VAULT,
    view.tokenVault,
    SHARES_MINT,
    ...reserves,
    ...view.allocations.flatMap((a) => [a.ctokenVault, a.liquiditySupply, a.collateralMint]),
  ];
  await Promise.all(keys.map((key) => surf("surfnet_resetAccount", [key.toBase58()])));
}

// ---- The vault, worked out here from raw accounts ---------------------------

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number): bigint => u64(d, o) + (u64(d, o + 8) << 64n);

/** The spike's formula: what `shares` would be paid if redeemed now, from the
 *  vault's own recorded pending fees, less what the vault keeps. */
async function liquidationValue(shares: bigint): Promise<bigint> {
  const vault = (await connection.getAccountInfo(VAULT, "confirmed"))!.data;
  const reserves = allocationReserves(vault);
  const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
  let gross = u64(vault, 224);
  reserves.forEach((reserve, i) => {
    const slot = allocationSlot(vault, reserve);
    const data = infos[i]!.data;
    const supplySf = (u64(data, 224) << 60n) + u128(data, 232) - u128(data, 344) - u128(data, 360) - u128(data, 376);
    const ctokenSupply = u64(data, 2592);
    const held = u64(vault, 312 + slot * 2160 + 1104);
    gross += ctokenSupply === 0n ? held : ((held * supplySf) / ctokenSupply) >> 60n;
  });
  const pendingSf = u128(vault, 296);
  const pending = (pendingSf >> 60n) + (pendingSf % (1n << 60n) === 0n ? 0n : 1n);
  const issued = u64(vault, 232);
  const worth = (shares * (gross - pending)) / issued;
  return worth > MEASURED_EXIT ? worth - MEASURED_EXIT : 0n;
}

function allocationSlot(vault: Buffer, reserve: PublicKey): number {
  for (let i = 0; i < 25; i++) {
    if (new PublicKey(vault.subarray(312 + i * 2160, 312 + i * 2160 + 32)).equals(reserve)) return i;
  }
  throw new Error("reserve is not in the vault");
}

// ---- Sending: v0 with the vault's table -------------------------------------

let table: AddressLookupTableAccount | null = null;
async function vaultTable(view: KvaultView): Promise<AddressLookupTableAccount> {
  table ??= (await connection.getAddressLookupTable(view.lookupTable)).value;
  if (!table) throw new Error("the vault's lookup table is not on the fork");
  return table;
}

const cus: Record<string, number> = {};

async function compile(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  view: KvaultView,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signers[0]!.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions],
  }).compileToV0Message([await vaultTable(view)]);
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  return tx;
}

async function sendV0(
  label: string,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  view: KvaultView,
): Promise<{ cu: number; bytes: number }> {
  const tx = await compile(instructions, signers, view);
  const bytes = tx.serialize().length;
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) {
    throw new Error(`${label} failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  const landed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (landed?.meta?.err) throw new Error(`${label} landed with an error: ${JSON.stringify(landed.meta.err)}`);
  const cu = landed?.meta?.computeUnitsConsumed ?? sim.value.unitsConsumed ?? 0;
  cus[label] = cu;
  console.log(`CU ${label} ${cu} bytes=${bytes}`);
  return { cu, bytes };
}

/** Simulates `instructions`, which must fail; returns the error and the logs. */
async function failure(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  view: KvaultView,
): Promise<{ text: string; logs: string }> {
  const tx = await compile(instructions, signers, view);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (!sim.value.err) throw new Error("expected the call to fail");
  const logs = (sim.value.logs ?? []).join("\n");
  return { text: `${JSON.stringify(sim.value.err)}\n${logs}`, logs };
}

// ---- The pool ----------------------------------------------------------------

interface ForkPool {
  poolId: bigint;
  pool: PublicKey;
  admin: Keypair;
  operator: Keypair;
  treasury: PublicKey;
  principalVault: PublicKey;
  jackpotVault: PublicKey;
  shares: PublicKey;
}

interface Wallet {
  keypair: Keypair;
  tokenAccount: PublicKey;
}

async function fundedWallet(usdc: bigint): Promise<Wallet> {
  const keypair = Keypair.generate();
  await airdrop(keypair.publicKey, 5);
  await setUsdc(keypair.publicKey, usdc * USDC_UNIT);
  return { keypair, tokenAccount: getAssociatedTokenAddressSync(USDC, keypair.publicKey) };
}

/** Bootstraps through the real script: VENUE_KIND=kvault, the vault the only input. */
async function bootstrapPool(): Promise<ForkPool> {
  const poolId = nextPoolId();
  const admin = Keypair.generate();
  const operator = Keypair.generate();
  await airdrop(admin.publicKey, 20);
  await airdrop(operator.publicKey, 5);
  const treasury = await createAccount(connection, admin, USDC, admin.publicKey, Keypair.generate());
  const buyback = await createAccount(connection, admin, USDC, admin.publicKey, Keypair.generate());
  const pool = poolPda(poolId);
  const { stderr } = await run(
    "pnpm",
    [
      "exec", "tsx", "src/bootstrap.ts",
      "--admin", admin.publicKey.toBase58(),
      "--operator", operator.publicKey.toBase58(),
      "--treasury", treasury.toBase58(),
      "--buyback-reserve", buyback.toBase58(),
      "--epoch-seconds", "86400",
    ],
    {
      cwd: new URL("../../apps/backend", import.meta.url).pathname,
      env: {
        ...process.env,
        VENUE_KIND: "kvault",
        KVAULT_ADDRESS: VAULT.toBase58(),
        OPERATOR_KEYPAIR: utils.bytes.bs58.encode(admin.secretKey),
        RPC_URL: connection.rpcEndpoint,
        PROGRAM_ID: program.programId.toBase58(),
        POOL_ID: poolId.toString(),
        ACCEPTED_MINT: USDC.toBase58(),
        HEXVAULT_IDL_PATH: process.env.HEXVAULT_IDL_PATH ?? new URL("../../target/idl/hex_vault.json", import.meta.url).pathname,
        BUY_TICKETS_PAUSED: "true",
      },
      timeout: 120_000,
    },
  );
  void stderr;
  return {
    poolId,
    pool,
    admin,
    operator,
    treasury,
    principalVault: principalVaultPda(pool),
    jackpotVault: jackpotVaultPda(pool),
    shares: getAssociatedTokenAddressSync(SHARES_MINT, pool, true),
  };
}

async function poolState(f: ForkPool): Promise<PoolState> {
  const info = await connection.getAccountInfo(f.pool, "confirmed");
  const decoded = decodePool(idlProgram, f.pool, info!.data);
  return { ...decoded, kvault: await fetchKvaultView(connection, VAULT) };
}

const fetchPool = (f: ForkPool) => program.account.pool.fetch(f.pool);

async function pastLastSync(f: ForkPool): Promise<void> {
  await sleepUntilOnChain(Number((await fetchPool(f)).lastSyncAt.toString()) + 1);
}

/** The invariant of the spec, with the vault's own number for the position. */
async function assertSolvent(f: ForkPool, dust: bigint): Promise<void> {
  const pool = await fetchPool(f);
  const vault = await tokenBalance(f.principalVault);
  const position = await liquidationValue(await tokenBalance(f.shares));
  const claims =
    big(pool.totalPrincipal) + big(pool.yieldOwed) + big(pool.feeOwed) + big(pool.prizeOwed) - big(pool.deficit);
  const assets = vault + position;
  expect(assets + dust >= claims, `insolvent: vault ${vault} + position ${position} < claims ${claims} (dust allowed ${dust})`).toBe(true);
  // The booked value never overstates what a redeem returns.
  expect(big(pool.venueValue) <= position + 1n, `booked ${pool.venueValue} over the vault's ${position}`).toBe(true);
}

describe("kVault backing on a mainnet fork", () => {
  let f: ForkPool;
  let alice: Wallet;
  let ix: OperatorInstructions;
  let view: KvaultView;
  // Each venue operation can cost the pool a unit or two of rounding and the
  // vault's exit cost; the helper allows this much per operation so far.
  const PER_OP_DUST = 1_500n;
  let ops = 0n;
  const solvent = () => assertSolvent(f, PER_OP_DUST * ops);

  beforeAll(async () => {
    await resetPosition();
    f = await bootstrapPool();
    ix = new OperatorInstructions(idlProgram, program.programId, f.operator.publicKey, false);
    view = await fetchKvaultView(connection, VAULT);
    alice = await fundedWallet(20_000n);
  }, TIMEOUT);

  afterAll(() => {
    console.log(`CU summary ${JSON.stringify(cus)}`);
  });

  /** A user instruction against the pool, with the kVault remaining accounts. */
  function userInstruction(builder: unknown, owner: Wallet, redeem: boolean): Promise<TransactionInstruction> {
    return (builder as Builder)
      .accountsPartial({
        owner: owner.keypair.publicKey,
        pool: f.pool,
        player: playerPda(f.pool, owner.keypair.publicKey),
        acceptedMint: USDC,
        ownerToken: owner.tokenAccount,
        principalVault: f.principalVault,
        klendProgram: KVAULT_PROGRAM_ID,
        klendMarket: VAULT,
        klendReserve: SHARES_MINT,
        klendCtoken: f.shares,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(kvaultRemaining(view, redeem ? { writableMint: USDC } : { valueOnly: true }))
      .instruction();
  }

  const deposit = (owner: Wallet, amount: bigint) => userInstruction(program.methods.deposit(bn(amount)), owner, false);
  const requestWithdraw = (owner: Wallet, amount: bigint) =>
    userInstruction(program.methods.requestWithdraw(bn(amount)), owner, true);

  it("bootstraps a pool pinned to the vault, its shares mint and the pool's shares account", async () => {
    const pool = await fetchPool(f);
    expect(pool.venueKind).toBe(2);
    expect(pool.klendProgram.equals(KVAULT_PROGRAM_ID)).toBe(true);
    expect(pool.klendMarket.equals(VAULT)).toBe(true);
    expect(pool.klendReserve.equals(sharesMintAddress(VAULT))).toBe(true);
    expect(pool.klendReserve.equals(SHARES_MINT)).toBe(true);
    expect(pool.klendCtoken.equals(f.shares)).toBe(true);
    // The shares account exists and is empty.
    expect(await tokenBalance(f.shares)).toBe(0n);
  }, TIMEOUT);

  it("refuses pins that are not the vault's, each by name", async () => {
    type Pins = { klendProgram: PublicKey; klendMarket: PublicKey; klendReserve: PublicKey; klendCtoken: PublicKey };
    /** create_pool with the real pins, except what `over` swaps. */
    const attempt = async (over: (pins: Pins, usdcAta: PublicKey) => Pins): Promise<string> => {
      const poolId = nextPoolId();
      const pool = poolPda(poolId);
      const operator = Keypair.generate();
      await airdrop(operator.publicKey, 10);
      const treasury = await createAccount(connection, operator, USDC, operator.publicKey, Keypair.generate());
      const buyback = await createAccount(connection, operator, USDC, operator.publicKey, Keypair.generate());
      const sharesAta = getAssociatedTokenAddressSync(SHARES_MINT, pool, true);
      const usdcAta = getAssociatedTokenAddressSync(USDC, pool, true);
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, sharesAta, pool, SHARES_MINT),
          createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, usdcAta, pool, USDC),
        ),
        [operator],
      );
      const venue = over(
        { klendProgram: KVAULT_PROGRAM_ID, klendMarket: VAULT, klendReserve: SHARES_MINT, klendCtoken: sharesAta },
        usdcAta,
      );
      return program.methods
        .createPool({
          poolId: bn(poolId),
          admin: operator.publicKey,
          operator: operator.publicKey,
          vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
          epochSeconds: new BN(86_400),
          epochAnchor: new BN(await onChainNowSeconds()),
          vrfTimeout: new BN(180),
          minDeposit: new BN(1_000_000),
          minJackpot: new BN(0),
          payoutTimeout: new BN(82_800),
          baseRateBps: 488,
          venueKind: 2,
        })
        .accountsPartial({
          payer: provider.wallet.publicKey,
          programData: PROGRAM_DATA,
          pool,
          acceptedMint: USDC,
          principalVault: principalVaultPda(pool),
          jackpotVault: jackpotVaultPda(pool),
          house: playerPda(pool, operator.publicKey),
          treasury,
          buybackReserve: buyback,
          ...venue,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
        .then(
          () => "created",
          (error: unknown) => {
            const e = error as { message?: string; logs?: string[] };
            return `${e.message ?? String(error)}\n${(e.logs ?? []).join("\n")}`;
          },
        );
    };
    const other = Keypair.generate().publicKey;
    // Sanity: the right pins are accepted.
    expect(await attempt((pins) => pins)).toBe("created");
    // A vault state that is not a VaultState (any account the program does not own).
    expect(await attempt((pins) => ({ ...pins, klendMarket: USDC }))).toContain("VaultStateUnreadable");
    // Not the kVault program.
    expect(await attempt((pins) => ({ ...pins, klendProgram: other }))).toContain("VaultPinMismatch");
    // A mint that is not the vault's shares mint.
    expect(await attempt((pins) => ({ ...pins, klendReserve: USDC }))).toContain("VaultPinMismatch");
    // The pool's own token account, but of the wrong mint.
    expect(await attempt((pins, usdcAta) => ({ ...pins, klendCtoken: usdcAta }))).toContain("VaultPinMismatch");
  }, TIMEOUT);

  it("deploys into the vault and books a value that never passes what a redeem returns", async () => {
    const first = await sendV0("deposit (sync, no position yet)", [await deposit(alice, 10_000n * USDC_UNIT)], [alice.keypair], view);
    expect(first.bytes).toBeLessThanOrEqual(1_232);
    await pastLastSync(f);
    await solvent();

    const pool0 = await poolState(f);
    const vaultBefore = await tokenBalance(f.principalVault);
    await sendV0("deploy_to_venue 9000 USDC", await ix.deployToVenue(pool0, 9_000n * USDC_UNIT), [f.operator], view);
    ops += 1n;

    const moved = vaultBefore - (await tokenBalance(f.principalVault));
    expect(moved).toBe(9_000n * USDC_UNIT);
    const shares = await tokenBalance(f.shares);
    expect(shares > 0n).toBe(true);
    const pool = await fetchPool(f);
    const worth = await liquidationValue(shares);
    // The pool books what the vault will return, within a few units of the
    // program's more conservative fee estimate.
    expect(big(pool.venueValue) <= worth + 1n).toBe(true);
    expect(worth - big(pool.venueValue) <= 50n).toBe(true);
    // And it is the deposit less the vault's own pricing gap and the exit cost.
    const short = 9_000n * USDC_UNIT - big(pool.venueValue);
    console.log(`DEPLOY booked=${pool.venueValue} short of deposit by ${short}`);
    expect(short >= EXIT_COST && short < EXIT_COST + 200n).toBe(true);
    await solvent();
  }, TIMEOUT);

  const setParams = (params: Record<string, number>) =>
    program.methods
      .setVenueParams({
        yieldFeeBps: null, idleFloorBps: null, idleTargetBps: null, reserveShareCapBps: null,
        reserveLiquidityFloorBps: null, minVenueMove: null, lossToleranceBps: null, ...params,
      })
      .accountsPartial({ admin: f.admin.publicKey, pool: f.pool })
      .signers([f.admin])
      .rpc();

  it("refuses a deploy past the share cap before any deposit CPI, and takes it once the cap allows", async () => {
    // A second 10,000 deposit puts 11,000 idle; the target is 10% of the pool.
    const bob = await fundedWallet(20_000n);
    await sendV0("deposit 10000 (second wallet)", [await deposit(bob, 10_000n * USDC_UNIT)], [bob.keypair], view);
    await pastLastSync(f);
    // One bp of the vault's ~66M is about 6,600 USDC; the position would pass it.
    await setParams({ reserveShareCapBps: 1 });
    const refused = await failure(await ix.deployToVenue(await poolState(f), 8_000n * USDC_UNIT), [f.operator], view);
    expect(refused.text).toContain("ReserveShareCapExceeded");
    expect(refused.logs).toContain("Instruction: RefreshReservesBatch");
    expect(refused.logs).not.toContain("Instruction: Deposit");
    await setParams({ reserveShareCapBps: 500 });
    await pastLastSync(f);
    await sendV0("deploy_to_venue 8000 USDC (second)", await ix.deployToVenue(await poolState(f), 8_000n * USDC_UNIT), [f.operator], view);
    ops += 1n;
    await solvent();
  }, TIMEOUT);

  it("syncs a gain after hours pass, with no refresh from the caller", async () => {
    const before = await fetchPool(f);
    await timeTravel(6 * 3_600);
    const carol = await fundedWallet(1_000n);
    await sendV0("deposit with sync after 6h", [await deposit(carol, 100n * USDC_UNIT)], [carol.keypair], view);
    const pool = await fetchPool(f);
    expect(big(pool.lastSyncAt) - big(before.lastSyncAt) >= 6n * 3_600n).toBe(true);
    expect(big(pool.venueValue) > big(before.venueValue)).toBe(true);
    const gain = big(pool.venueValue) - big(before.venueValue);
    const owed = (p: typeof pool) => big(p.feeOwed) + big(p.yieldOwed) + big(p.prizeOwed);
    expect(owed(pool) - owed(before)).toBe(gain);
    console.log(`GAIN 6h booked=${gain} on ${before.venueValue}`);
    await solvent();
  }, TIMEOUT);

  it("harvests the fee into the treasury, redeeming from the vault", async () => {
    await timeTravel(2 * 3_600);
    await pastLastSync(f);
    const before = await fetchPool(f);
    const treasuryBefore = await tokenBalance(f.treasury);
    const jackpotBefore = await tokenBalance(f.jackpotVault);
    await sendV0("harvest (sync + redeem + 2 transfers)", await ix.harvest(await poolState(f)), [f.operator], view);
    ops += 1n;
    const pool = await fetchPool(f);
    expect(big(pool.feeOwed)).toBe(0n);
    expect(big(pool.prizeOwed)).toBe(0n);
    const paidFee = (await tokenBalance(f.treasury)) - treasuryBefore;
    const paidPrize = (await tokenBalance(f.jackpotVault)) - jackpotBefore;
    expect(paidFee > 0n).toBe(true);
    // The sync inside the call books the 2 h gain first, so what is paid is at
    // least what was owed before it, less the exit cost the fee bears.
    expect(paidFee + paidPrize >= big(before.feeOwed) + big(before.prizeOwed) - 2n * EXIT_COST).toBe(true);
    await solvent();
  }, TIMEOUT);

  it("recalls into the principal vault, receiving at least what was asked", async () => {
    await pastLastSync(f);
    // A refund of the first deposit's pending amount pulls free idle under the target.
    await sendV0("request_withdraw 2500 USDC (refund from free idle)", [await requestWithdraw(alice, 2_500n * USDC_UNIT)], [alice.keypair], view);
    await pastLastSync(f);
    const vaultBefore = await tokenBalance(f.principalVault);
    const sharesBefore = await tokenBalance(f.shares);
    const amount = 800n * USDC_UNIT;
    await sendV0("recall 800 USDC (redeem)", await ix.recall(await poolState(f), amount), [f.operator], view);
    ops += 1n;
    const received = (await tokenBalance(f.principalVault)) - vaultBefore;
    expect(received >= amount && received <= amount + 20n).toBe(true);
    expect((await tokenBalance(f.shares)) < sharesBefore).toBe(true);
    await solvent();
  }, TIMEOUT);

  it("redeems the gap of a refund inside the instruction and pays in the same transaction", async () => {
    await timeTravel(3_600);
    const vault = await tokenBalance(f.principalVault);
    // Alice's deposit is still pending (no epoch has begun), so her request is a
    // refund; asking for 2,000 more than the vault holds makes the program
    // redeem the gap from the kVault before it pays.
    const walletBefore = await tokenBalance(alice.tokenAccount);
    const amount = vault + 2_000n * USDC_UNIT;
    await sendV0("request_withdraw (refund with sync + redeem)", [await requestWithdraw(alice, amount)], [alice.keypair], view);
    ops += 1n;
    expect((await tokenBalance(alice.tokenAccount)) - walletBefore).toBe(amount);
    await solvent();
  }, TIMEOUT);

  it("refuses to value a vault whose reserves a refresh did not bring up to date", async () => {
    // Give every allocation reserve to a program that accepts any instruction
    // and does nothing, and point the refresh at it: the refresh CPI succeeds,
    // the reserves keep their old slot, and the value is refused by name.
    const reserves = view.allocations.map((a) => a.reserve);
    const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
    await Promise.all(
      reserves.map((reserve, i) =>
        surf("surfnet_setAccount", [reserve.toBase58(), { lamports: infos[i]!.lamports, data: infos[i]!.data.toString("hex"), owner: NOOP.toBase58(), executable: false }]),
      ),
    );
    await sleep(2_000);
    const dave = await fundedWallet(1_000n);
    const remaining = kvaultRemaining(view, { valueOnly: true });
    remaining[0] = { ...remaining[0]!, pubkey: NOOP };
    const instruction = await (program.methods.deposit(bn(10n * USDC_UNIT)) as unknown as Builder)
      .accountsPartial({
        owner: dave.keypair.publicKey, pool: f.pool, player: playerPda(f.pool, dave.keypair.publicKey), acceptedMint: USDC,
        ownerToken: dave.tokenAccount, principalVault: f.principalVault, klendProgram: KVAULT_PROGRAM_ID, klendMarket: VAULT,
        klendReserve: SHARES_MINT, klendCtoken: f.shares, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remaining)
      .instruction();
    const { text } = await failure([instruction], [dave.keypair], view);
    expect(text).toContain("ReserveStale");
    await resetPosition();
  }, TIMEOUT);

  it("takes the whole position home after shutdown at no less than the booked value", async () => {
    await pastLastSync(f);
    await program.methods.shutdown().accountsPartial({ admin: f.admin.publicKey, pool: f.pool }).signers([f.admin]).rpc();
    await pastLastSync(f);
    const pool = await poolState(f);
    const shares = await tokenBalance(f.shares);
    const vaultBefore = await tokenBalance(f.principalVault);
    // What the sync books for the position is what a full redeem has to return.
    const value = big(pool.venueValue);
    await sendV0("recall whole position after shutdown", await ix.recall(pool, value), [f.operator], view);
    const received = (await tokenBalance(f.principalVault)) - vaultBefore;
    expect(received >= value).toBe(true);
    // Almost every share is gone: what is left is the sync's gain and rounding.
    const left = await tokenBalance(f.shares);
    console.log(`EXIT shares ${shares} -> ${left}, received ${received}, booked ${value}`);
    expect(left * 1_000n <= shares).toBe(true);
  }, TIMEOUT);
});

// A second pool, so nothing above is disturbed: the liquidity floor judged on
// the vault's real liquidity, and a redeem the vault cannot fill.
describe("kVault backing, liquidity limits", () => {
  let g: ForkPool;
  let ix: OperatorInstructions;
  let view: KvaultView;
  let wallet: Wallet;

  beforeAll(async () => {
    await resetPosition();
    g = await bootstrapPool();
    ix = new OperatorInstructions(idlProgram, program.programId, g.operator.publicKey, false);
    view = await fetchKvaultView(connection, VAULT);
    wallet = await fundedWallet(6_000_000n);
  }, TIMEOUT);

  const setParams = (params: Record<string, number>) =>
    program.methods
      .setVenueParams({
        yieldFeeBps: null, idleFloorBps: null, idleTargetBps: null, reserveShareCapBps: null,
        reserveLiquidityFloorBps: null, minVenueMove: null, lossToleranceBps: null, ...params,
      })
      .accountsPartial({ admin: g.admin.publicKey, pool: g.pool })
      .signers([g.admin])
      .rpc();

  const walletInstruction = (builder: unknown, redeem: boolean) =>
    (builder as Builder)
      .accountsPartial({
        owner: wallet.keypair.publicKey, pool: g.pool, player: playerPda(g.pool, wallet.keypair.publicKey), acceptedMint: USDC,
        ownerToken: wallet.tokenAccount, principalVault: g.principalVault, klendProgram: KVAULT_PROGRAM_ID, klendMarket: VAULT,
        klendReserve: SHARES_MINT, klendCtoken: g.shares, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(kvaultRemaining(view, redeem ? { writableMint: USDC } : { valueOnly: true }))
      .instruction();
  const depositInstruction = (amount: bigint) => walletInstruction(program.methods.deposit(bn(amount)), false);
  const requestWithdrawInstruction = (amount: bigint) =>
    walletInstruction(program.methods.requestWithdraw(bn(amount)), true);

  /** What the vault can pay now before the exit cost: idle plus each reserve's
   *  free liquidity up to what the vault holds there, worked out from raw accounts. */
  async function withdrawable(): Promise<bigint> {
    const vault = (await connection.getAccountInfo(VAULT, "confirmed"))!.data;
    const reserves = allocationReserves(vault);
    const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
    let total = u64(vault, 224);
    reserves.forEach((reserve, i) => {
      const data = infos[i]!.data;
      const supplySf = (u64(data, 224) << 60n) + u128(data, 232) - u128(data, 344) - u128(data, 360) - u128(data, 376);
      const held = u64(vault, 312 + allocationSlot(vault, reserve) * 2160 + 1104);
      const ctokenSupply = u64(data, 2592);
      const worth = ctokenSupply === 0n ? held : ((held * supplySf) / ctokenSupply) >> 60n;
      total += worth < u64(data, 224) ? worth : u64(data, 224);
    });
    return total;
  }

  it("judges the liquidity floor on the vault's real liquidity, and the cap on its real size", async () => {
    // The widest settings the program allows: a fifth of the vault, six times
    // the position in free liquidity. The boundary is then A/5 for liquidity A.
    await sendV0("deposit 5M USDC (liquidity setup)", [await depositInstruction(5_000_000n * USDC_UNIT)], [wallet.keypair], view);
    await setParams({ reserveShareCapBps: 2_000, reserveLiquidityFloorBps: 60_000, idleFloorBps: 0, idleTargetBps: 0 });
    await pastLastSync(g);
    const free = await withdrawable();
    const over = free / 5n + 300_000n * USDC_UNIT;
    const under = free / 5n - 600_000n * USDC_UNIT;
    console.log(`FLOOR withdrawable=${free} over=${over} under=${under}`);
    const refused = await failure(await ix.deployToVenue(await poolState(g), over), [g.operator], view);
    expect(refused.text).toContain("ReserveLiquidityTooLow");
    expect(refused.logs).toContain("Instruction: RefreshReservesBatch");
    expect(refused.logs).not.toContain("Instruction: Deposit");
    // Just under the boundary the same deploy goes through.
    await sendV0("deploy_to_venue under the floor", await ix.deployToVenue(await poolState(g), under), [g.operator], view);
    expect(big((await program.account.pool.fetch(g.pool)).venueValue) > 0n).toBe(true);
  }, TIMEOUT);

  it("pays short when the vault cannot cover a redeem, and the caller refuses the short payout by name", async () => {
    // Every reserve's free liquidity into "borrowed" (total supply unchanged)
    // and the vault's idle tokens to 100 USDC: it can pay about 400 now.
    const reserves = view.allocations.map((a) => a.reserve);
    const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
    await Promise.all(
      reserves.map((reserve, i) => {
        const data = Buffer.from(infos[i]!.data);
        const available = data.readBigUInt64LE(224);
        const keep = 50n * USDC_UNIT;
        if (available <= keep) return Promise.resolve();
        const borrowedSf = data.readBigUInt64LE(232) + (data.readBigUInt64LE(240) << 64n);
        const next = borrowedSf + ((available - keep) << 60n);
        data.writeBigUInt64LE(keep, 224);
        data.writeBigUInt64LE(next & 0xffff_ffff_ffff_ffffn, 232);
        data.writeBigUInt64LE(next >> 64n, 240);
        return surf("surfnet_setAccount", [reserve.toBase58(), { lamports: infos[i]!.lamports, data: data.toString("hex"), owner: infos[i]!.owner.toBase58(), executable: false }]);
      }),
    );
    const vault = (await connection.getAccountInfo(VAULT, "confirmed"))!;
    const vaultData = Buffer.from(vault.data);
    vaultData.writeBigUInt64LE(100n * USDC_UNIT, 224);
    await surf("surfnet_setAccount", [VAULT.toBase58(), { lamports: vault.lamports, data: vaultData.toString("hex"), owner: vault.owner.toBase58(), executable: false }]);

    await pastLastSync(g);
    // Shutdown lifts the recall band, so the only limit left is the vault's.
    await program.methods.shutdown().accountsPartial({ admin: g.admin.publicKey, pool: g.pool }).signers([g.admin]).rpc();
    await pastLastSync(g);
    // Cutting the vault's idle tokens lowered its value, by more than the loss
    // tolerance when mainnet's idle is large. A 1 USDC refund from the pending
    // deposit syncs that loss now (it is allowed shut down and impaired), so
    // the drain's own sync below has nothing left to book.
    await sendV0("request_withdraw 1 USDC (sync after the cut)", [await requestWithdrawInstruction(USDC_UNIT)], [wallet.keypair], view);
    await pastLastSync(g);
    const before = await program.account.pool.fetch(g.pool);
    const sharesBefore = await tokenBalance(g.shares);
    const { text, logs } = await failure(await ix.recall(await poolState(g), 800n * USDC_UNIT), [g.operator], view);
    // The vault was asked for what it can pay, so its own CPI ran and the
    // payout fell short of the 800 asked; the whole instruction reverts.
    expect(logs).toContain("Instruction: Withdraw");
    expect(text).toContain("VenueShortReturn");
    expect((await program.account.pool.fetch(g.pool)).venueValue.toString()).toBe(before.venueValue.toString());
    expect(await tokenBalance(g.shares)).toBe(sharesBefore);

    // A drain of the same size does not revert: it books what came back, and
    // the rest of the position stays valued at the vault until the next sync.
    const vaultBefore = await tokenBalance(g.principalVault);
    await sendV0("drain_venue 800 USDC (vault pays short)", await ix.drainVenue(await poolState(g), 800n * USDC_UNIT), [g.operator], view);
    const received = (await tokenBalance(g.principalVault)) - vaultBefore;
    expect(received > 0n && received < 800n * USDC_UNIT).toBe(true);
    // The drain's own sync can still book a few seconds of interest on the
    // borrow pushed in above (about 0.01 USDC), never anything near the 800.
    const accrued = big((await program.account.pool.fetch(g.pool)).venueValue) - (big(before.venueValue) - received);
    expect(accrued >= 0n && accrued < USDC_UNIT).toBe(true);
    await resetPosition();
  }, TIMEOUT);
});
