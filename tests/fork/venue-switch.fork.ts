// Venue-switch ticket 07: three venue changes rehearsed on a Surfpool mainnet
// fork, through the tools the team will use on mainnet. Not part of
// `tests/run-local.sh` (no `.test.`).
//
//   1. klend to klend: the SOL/BTC market's USDC reserve to the OnRe market's.
//   2. klend to kVault: the SOL/BTC reserve to the RockawayX RWA USDC vault.
//   3. Emergency park: drain with the deploy pause and no proposal, then a
//      normal proposal.
//
// Every run: three players deposit, the Operator's tick opens the epoch and
// deploys, a gain accrues through time travel, one withdrawal is queued, the
// admin CLI proposes in multisig mode (the printed transaction is signed here
// with the pool's admin key, standing in for Squads), the clock is moved past
// the 48 hour lock, and the tick itself drains and migrates. The tick is
// `runTick` from apps/backend/src/operator/tick.ts with a context built from
// chain reads the way operator.service.ts builds it, sending through
// ChainService, so no hex_vault instruction is hand-built for a crank.
//
// Run it against a fork `scripts/surf.sh up` started (the plain build is
// deployed there; the keyed datasource stays in the environment of surf.sh):
//
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:9499 ANCHOR_WALLET=$HOME/.config/solana/id.json \
//   HEXVAULT_IDL_PATH=.surf/hex_vault.json \
//   pnpm exec vitest run --config tests/fork/vitest.config.ts tests/fork/venue-switch.fork.ts
//
// Fork rules from klend.fork.ts apply: reset every account of a position back
// to back before its first transaction, and move the clock with
// `surfnet_timeTravel` and `absoluteTimestamp` only.
//
// Output lines starting `STEP`, `CLI`, `TX`, `TICK` and `CHECK` are the
// transcript saved under docs/plan/venue-switch/research/.
//
// Venue addresses, read from Kamino's API on 2026-10-07:
//   SOL/BTC market 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF, USDC reserve D6q6wuQS... (4.41% supply)
//   OnRe market 47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8, USDC reserve AYL4LMc4... (5.90% supply)
//   RockawayX RWA USDC vault DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP (7d APY 5.59%)

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BN, EventParser, utils, type Idl, type Program } from "@anchor-lang/core";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// The backend's own copy of web3.js: ChainService builds its transactions from it,
// and a Connection from the root copy cannot simulate them.
import { Connection as BackendConnection } from "../../apps/backend/node_modules/@solana/web3.js";
import { ChainService } from "../../apps/backend/src/chain/chain.service";
import {
  allocationReserves,
  fetchKvaultView,
  KVAULT_PROGRAM_ID,
  sharesMintAddress,
  withdrawable,
} from "../../apps/backend/src/chain/kvault";
import { epochAddress, venueProposalAddress } from "../../apps/backend/src/chain/pda";
import { VENUE_KIND, VENUE_LOCK_SECONDS } from "../../apps/backend/src/chain/venue-kind";
import { decodeReserve } from "../../apps/backend/src/api/live-yield";
import { validateEnv, type HexVaultEnv } from "../../apps/backend/src/config/env";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  decodeVenueProposal,
  type EpochState,
  type PoolState,
} from "../../apps/backend/src/operator/chain-state";
import { OperatorInstructions } from "../../apps/backend/src/operator/instructions";
import {
  runTick,
  type TickContext,
  type TickOutcome,
  type WithdrawState,
} from "../../apps/backend/src/operator/tick";
import {
  EMPTY_VENUE_STATE,
  type VenueState,
} from "../../apps/backend/src/operator/venue";
import {
  playerPda,
  program,
  provider,
  sleep,
} from "../helpers/hx.js";

const run = promisify(execFile);
const TIMEOUT = 900_000;
const USDC_UNIT = 1_000_000n;
const connection = provider.connection;
const idlProgram = program as unknown as Program<Idl>;
const BACKEND = new URL("../../apps/backend", import.meta.url).pathname;
const IDL_PATH = process.env.HEXVAULT_IDL_PATH ?? new URL("../../target/idl/hex_vault.json", import.meta.url).pathname;

// ---- Addresses (Kamino API, 2026-10-07) --------------------------------------

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const SOLBTC_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const SOLBTC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const ONRE_MARKET = new PublicKey("47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8");
const ONRE_RESERVE = new PublicKey("AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z");
const VAULT = new PublicKey("DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP");
const SHARES_MINT = new PublicKey("DgHN3q3dSYAchNX7V3D4aYiTWMx8RHTgHbfPiwiqBkE9");

/** A klend reserve's liquidity supply vault and cToken mint, PDAs of the market and the mint. */
const klendPda = (seed: string, market: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer(), USDC.toBuffer()], KLEND)[0];
const liquiditySupply = (market: PublicKey) => klendPda("reserve_liq_supply", market);
const collateralMint = (market: PublicKey) => klendPda("reserve_coll_mint", market);

const big = (n: { toString(): string }): bigint => BigInt(n.toString());
const bn = (n: bigint): BN => new BN(n.toString());
const usdc = (n: bigint): string => `${(Number(n) / 1e6).toFixed(6)} USDC`;

// ---- Fork plumbing ------------------------------------------------------------

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

async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return Number(clockUnixTimestamp(info!.data));
}

/** Never call `surfnet_timeTravel` with no params: it skips about 9,000 slots. */
async function timeTravelTo(target: number): Promise<void> {
  await surf("surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
  await sleep(1_500);
}
const timeTravel = async (seconds: number): Promise<void> => timeTravelTo((await chainNow()) + seconds);

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

/** Refetches `keys` back to back, so the fork holds one coherent snapshot of a position. */
const resetAll = async (keys: PublicKey[]): Promise<void> => {
  await Promise.all(keys.map((key) => surf("surfnet_resetAccount", [key.toBase58()])));
};

/** A klend reserve, its liquidity supply and its cToken mint, refetched together. */
const klendAccounts = (market: PublicKey, reserve: PublicKey): PublicKey[] => [
  reserve,
  liquiditySupply(market),
  collateralMint(market),
];

async function kvaultPosition(): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(VAULT, "confirmed");
  const view = await fetchKvaultView(connection, VAULT);
  return [
    VAULT,
    view.tokenVault,
    SHARES_MINT,
    ...allocationReserves(info!.data),
    ...view.allocations.flatMap((a) => [a.ctokenVault, a.liquiditySupply, a.collateralMint]),
  ];
}

// ---- The vault's and the reserve's own numbers, worked out from raw accounts -----

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number): bigint => u64(d, o) + (u64(d, o + 8) << 64n);
// What a redeem from the vault is measured to fall short of the formula by.
const MEASURED_EXIT = 1_001n;

function allocationSlot(vault: Buffer, reserve: PublicKey): number {
  for (let i = 0; i < 25; i++) {
    if (new PublicKey(vault.subarray(312 + i * 2160, 312 + i * 2160 + 32)).equals(reserve)) return i;
  }
  throw new Error("reserve is not in the vault");
}

async function kvaultValue(shares: bigint): Promise<bigint> {
  const vault = (await connection.getAccountInfo(VAULT, "confirmed"))!.data;
  const reserves = allocationReserves(vault);
  const infos = await connection.getMultipleAccountsInfo(reserves, "confirmed");
  let gross = u64(vault, 224);
  reserves.forEach((reserve, i) => {
    const data = infos[i]!.data;
    const supplySf = (u64(data, 224) << 60n) + u128(data, 232) - u128(data, 344) - u128(data, 360) - u128(data, 376);
    const ctokenSupply = u64(data, 2592);
    const held = u64(vault, 312 + allocationSlot(vault, reserve) * 2160 + 1104);
    gross += ctokenSupply === 0n ? held : ((held * supplySf) / ctokenSupply) >> 60n;
  });
  const pendingSf = u128(vault, 296);
  const pending = (pendingSf >> 60n) + (pendingSf % (1n << 60n) === 0n ? 0n : 1n);
  const worth = (shares * (gross - pending)) / u64(vault, 232);
  return worth > MEASURED_EXIT ? worth - MEASURED_EXIT : 0n;
}

async function klendValue(reserve: PublicKey, ctokens: bigint): Promise<bigint> {
  const data = (await connection.getAccountInfo(reserve, "confirmed"))!.data;
  const supplySf = (u64(data, 224) << 60n) + u128(data, 232) - u128(data, 344) - u128(data, 360) - u128(data, 376);
  const ctokenSupply = u64(data, 2592);
  if (ctokenSupply === 0n || supplySf === 0n) return ctokens;
  return ((ctokens * supplySf) / ctokenSupply) >> 60n;
}

/** What the pool's position at the venue it points at is worth right now. */
async function positionValue(pool: PoolState): Promise<bigint> {
  const held = await tokenBalance(pool.klendCtoken);
  return pool.venueKind === VENUE_KIND.kvault ? kvaultValue(held) : klendValue(pool.klendReserve, held);
}

// ---- Fork pool ----------------------------------------------------------------

interface Fork {
  poolId: bigint;
  pool: PublicKey;
  admin: Keypair;
  operator: Keypair;
  treasury: PublicKey;
  principalVault: PublicKey;
  chain: ChainService;
  ix: OperatorInstructions;
  /** Every depositor the run has made. The tick's withdrawal step reads their
   *  Player accounts by address: `getProgramAccounts` is a remote call the fork
   *  forwards to its datasource and it stalls. */
  wallets: Wallet[];
}

interface Wallet {
  name: string;
  keypair: Keypair;
  tokenAccount: PublicKey;
}

async function fundedWallet(f: Fork, name: string, amount: bigint): Promise<Wallet> {
  const keypair = Keypair.generate();
  await airdrop(keypair.publicKey, 5);
  await setUsdc(keypair.publicKey, amount * USDC_UNIT);
  const wallet = { name, keypair, tokenAccount: getAssociatedTokenAddressSync(USDC, keypair.publicKey) };
  f.wallets.push(wallet);
  return wallet;
}

function cliEnv(f: { poolId: bigint; operator: Keypair; admin: Keypair }, as: "multisig" | "operator"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RPC_URL: connection.rpcEndpoint,
    PROGRAM_ID: program.programId.toBase58(),
    POOL_ID: f.poolId.toString(),
    ACCEPTED_MINT: USDC.toBase58(),
    HEXVAULT_IDL_PATH: IDL_PATH,
    DATABASE_URL: "postgresql://x",
    CORS_ORIGIN: "http://localhost",
    CLUSTER: "mainnet-beta",
    OPERATOR_KEYPAIR: utils.bytes.bs58.encode(f.operator.secretKey),
  };
  if (as === "multisig") env.ADMIN_ADDRESS = f.admin.publicKey.toBase58();
  else delete env.ADMIN_ADDRESS;
  return env;
}

async function bootstrapPool(): Promise<Fork> {
  const poolId = BigInt(Date.now()) * 1_000n;
  const admin = Keypair.generate();
  const operator = Keypair.generate();
  await airdrop(admin.publicKey, 20);
  await airdrop(operator.publicKey, 10);
  const treasury = await createAccount(connection, admin, USDC, admin.publicKey, Keypair.generate());
  const buyback = await createAccount(connection, admin, USDC, admin.publicKey, Keypair.generate());
  const anchor = new Date(((await chainNow()) - 60) * 1000).toISOString();
  const { stderr } = await run(
    "pnpm",
    [
      "exec", "tsx", "src/bootstrap.ts",
      "--admin", admin.publicKey.toBase58(),
      "--operator", operator.publicKey.toBase58(),
      "--treasury", treasury.toBase58(),
      "--buyback-reserve", buyback.toBase58(),
      // Five days, so epoch 1 outlasts the 48 hour lock and the clock moves
      // within it; the queued withdrawal pays once it ends.
      "--epoch-seconds", "432000",
      "--epoch-anchor", anchor,
    ],
    {
      cwd: BACKEND,
      env: {
        ...cliEnv({ poolId, operator, admin }, "operator"),
        OPERATOR_KEYPAIR: utils.bytes.bs58.encode(admin.secretKey),
        BUY_TICKETS_PAUSED: "true",
      },
      timeout: 180_000,
    },
  );
  void stderr;
  const env = validateEnv({ ...cliEnv({ poolId, operator, admin }, "operator") });
  const chain = new ChainService(
    new BackendConnection(connection.rpcEndpoint, "confirmed"),
    // SAFETY: ChainService reads only `get(key)`; this is ConfigService's whole use here.
    { get: (key: keyof HexVaultEnv) => env[key] } as unknown as ConstructorParameters<typeof ChainService>[1],
  );
  const pool = chain.poolAddress();
  return {
    poolId,
    pool,
    admin,
    operator,
    treasury,
    principalVault: chain.principalVaultAddress(pool),
    chain,
    ix: new OperatorInstructions(chain.program, chain.programId, operator.publicKey, false),
    wallets: [],
  };
}

async function poolState(f: Fork): Promise<PoolState> {
  const info = await connection.getAccountInfo(f.pool, "confirmed");
  const decoded = decodePool(idlProgram, f.pool, info!.data);
  if (decoded.venueKind !== VENUE_KIND.kvault) return decoded;
  return { ...decoded, kvault: await fetchKvaultView(connection, decoded.klendMarket, decoded.klendProgram) };
}

const fetchPool = (f: Fork) => program.account.pool.fetch(f.pool);

/** Waits until the Clock sysvar is past the pool's last sync, so the next sync
 *  is not swallowed by the same-second no-op. Not `getBlockTime`, which stays
 *  at the pre-warp time after a `surfnet_timeTravel`. */
async function pastLastSync(f: Fork): Promise<void> {
  const target = Number((await fetchPool(f)).lastSyncAt.toString()) + 1;
  while ((await chainNow()) < target) await sleep(500);
}

const lookupTables = new Map<string, AddressLookupTableAccount>();
async function tablesFor(pool: PoolState): Promise<AddressLookupTableAccount[]> {
  if (!pool.kvault) return [];
  const key = pool.kvault.lookupTable.toBase58();
  if (!lookupTables.has(key)) {
    const { value } = await connection.getAddressLookupTable(pool.kvault.lookupTable);
    if (!value) throw new Error("the vault's lookup table is not on the fork");
    lookupTables.set(key, value);
  }
  return [lookupTables.get(key)!];
}

/** What `signature` cost in compute units and bytes, for the transcript. */
async function describeTx(label: string, signature: string): Promise<{ cu: number; bytes: number }> {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const cu = tx?.meta?.computeUnitsConsumed ?? 0;
  const message = tx?.transaction.message;
  const bytes = message ? ("serialize" in message ? message.serialize().length : 0) : 0;
  console.log(`TX ${label} sig=${signature} cu=${cu} messageBytes=${bytes}`);
  return { cu, bytes };
}

async function eventOf<T>(signature: string, name: string): Promise<T> {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const parser = new EventParser(program.programId, program.coder);
  for (const event of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
    if (event.name === name) return event.data as T;
  }
  throw new Error(`no ${name} event in ${signature}`);
}

// ---- User instructions ---------------------------------------------------------

/** The operator's own remaining-account logic, so a user call names what the tick would. */
function remainingFor(f: Fork, pool: PoolState, use: "sync" | "redeem"): AccountMeta[] {
  // SAFETY: `venueRemaining` is private to keep callers off it; this test needs
  // the same list the tick's cranks get, and a copy here would drift from it.
  return (f.ix as unknown as { venueRemaining(p: PoolState, u: string): AccountMeta[] }).venueRemaining(pool, use);
}

async function userInstruction(
  f: Fork,
  owner: Wallet,
  name: "deposit" | "requestWithdraw",
  amount: bigint,
): Promise<{ instruction: TransactionInstruction; pool: PoolState }> {
  const pool = await poolState(f);
  const builder = (program.methods as unknown as Record<string, (a: BN) => {
    accountsPartial(accounts: Record<string, PublicKey>): {
      remainingAccounts(metas: AccountMeta[]): { instruction(): Promise<TransactionInstruction> };
    };
  }>)[name]!(bn(amount));
  const instruction = await builder
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: f.pool,
      player: playerPda(f.pool, owner.keypair.publicKey),
      acceptedMint: USDC,
      ownerToken: owner.tokenAccount,
      principalVault: f.principalVault,
      klendProgram: pool.klendProgram,
      klendMarket: pool.klendMarket,
      klendReserve: pool.klendReserve,
      klendCtoken: pool.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingFor(f, pool, name === "deposit" ? "sync" : "redeem"))
    .instruction();
  return { instruction, pool };
}

async function sendAs(label: string, instructions: TransactionInstruction[], signer: Keypair, pool: PoolState): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions],
  }).compileToV0Message(await tablesFor(pool));
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  await describeTx(label, signature);
  return signature;
}

// ---- Admin CLI ------------------------------------------------------------------

/**
 * Runs one admin CLI command. `multisig` is Squads mode: ADMIN_ADDRESS is the
 * pool's admin, the CLI prints an unsigned base58 transaction on stdout, and
 * this signs it with the admin key and sends it, as the multisig's members
 * would. `operator` is the local mode on the box: ADMIN_ADDRESS unset, the
 * Operator key signs and sends.
 */
async function adminCli(
  f: Fork,
  args: string[],
  as: "multisig" | "operator",
): Promise<{ signature: string | null; stdout: string; stderr: string }> {
  const { stdout, stderr } = await run("pnpm", ["exec", "tsx", "src/admin/main.ts", ...args], {
    cwd: BACKEND,
    env: cliEnv(f, as),
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const note = stderr.split("\n").filter((l) => l.trim() && !l.includes("signer ")).join(" | ");
  console.log(`CLI [${as}] admin ${args.join(" ")} => ${note}`);
  if (as === "operator") {
    const signature = /signature (\S+)/.exec(stderr)?.[1] ?? null;
    if (signature) await describeTx(`admin ${args[0]}`, signature);
    return { signature, stdout, stderr };
  }
  const encoded = stdout.trim();
  const tx = Transaction.from(utils.bytes.bs58.decode(encoded));
  console.log(`CLI printed an unsigned transaction: ${tx.instructions.length} instruction(s), fee payer ${tx.feePayer?.toBase58()}, ${encoded.length} base58 characters`);
  tx.partialSign(f.admin);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  await describeTx(`admin ${args[0]} (signed as admin)`, signature);
  return { signature, stdout, stderr };
}

// ---- The Operator's tick ----------------------------------------------------------

interface TickMemory {
  venueState: VenueState;
  withdrawState: WithdrawState | null;
  expectedErrors: ReadonlyMap<string, number>;
}
const freshMemory = (): TickMemory => ({ venueState: EMPTY_VENUE_STATE, withdrawState: null, expectedErrors: new Map() });

interface TickResult {
  action: string | null;
  signature: string | null;
  warnings: string[];
  stepError: string | undefined;
}

/** One tick: the production decision function over a context read from chain. */
async function tick(f: Fork, memory: TickMemory): Promise<TickResult> {
  await pastLastSync(f);
  const pool = await poolState(f);
  const tables = await tablesFor(pool);
  const now = BigInt(await chainNow());
  const infos = await connection.getMultipleAccountsInfo([venueProposalAddress(f.chain.programId, f.pool)], "confirmed");
  const proposalInfo = infos[0];
  const epoch = async (id: bigint): Promise<EpochState | null> => {
    if (id <= 0n) return null;
    const info = await connection.getAccountInfo(epochAddress(f.chain.programId, f.pool, id), "confirmed");
    return info ? decodeEpoch(idlProgram, info.data) : null;
  };
  const sent: string[] = [];
  const warnings: string[] = [];
  const ctx: TickContext = {
    now,
    pool,
    currentEpoch: await epoch(pool.currentEpochId),
    previousEpoch: await epoch(pool.currentEpochId - 1n),
    openRound: null,
    lastRound: null,
    ix: f.ix,
    lastWithdrawState: memory.withdrawState,
    lastVenueState: memory.venueState,
    venueProposal:
      proposalInfo && proposalInfo.owner.equals(f.chain.programId)
        ? decodeVenueProposal(idlProgram, proposalInfo.data)
        : null,
    venueAvailable: async () => {
      if (pool.venueKind === VENUE_KIND.kvault && pool.kvault) return withdrawable(pool.kvault);
      const info = await connection.getAccountInfo(pool.klendReserve, "confirmed");
      return info ? decodeReserve(info.data).available : null;
    },
    lastExpectedErrors: memory.expectedErrors,
    lastRoundSkipEpochId: null,
    launchAt: null,
    fulfilled: async () => false,
    principalVaultBalance: () => tokenBalance(f.principalVault),
    duePendingWithdrawals: async (currentEpochId) => {
      const due: { owner: string; amount: bigint }[] = [];
      for (const w of f.wallets) {
        const player = await program.account.player.fetchNullable(playerPda(f.pool, w.keypair.publicKey));
        if (player && big(player.pendingWithdraw) > 0n && big(player.pendingEpoch) < currentEpochId) {
          due.push({ owner: w.keypair.publicKey.toBase58(), amount: big(player.pendingWithdraw) });
        }
      }
      return due;
    },
    referralGrantsDue: async () => [],
    markReferralGrantsSent: async () => undefined,
    unsettledPositions: async () => [],
    forgetPositions: async () => undefined,
    roundsToClose: async () => [],
    forgetRound: () => undefined,
    winner: async () => null,
    send: async (instructions) => {
      const signature = await f.chain.send(instructions, undefined, tables);
      sent.push(signature);
      return signature;
    },
    warn: (message) => warnings.push(message),
  };
  const outcome: TickOutcome = await runTick(ctx);
  memory.venueState = outcome.venueState ?? memory.venueState;
  memory.withdrawState = outcome.withdrawState ?? memory.withdrawState;
  memory.expectedErrors = outcome.expectedErrors ?? memory.expectedErrors;
  const signature = sent.at(-1) ?? null;
  console.log(`TICK now=${now} action=${outcome.action ?? "none"}${signature ? ` sig=${signature}` : ""}${warnings.length ? ` warnings=${JSON.stringify(warnings)}` : ""}${outcome.stepError ? ` stepError=${outcome.stepError}` : ""}`);
  if (signature && outcome.action) await describeTx(`tick ${outcome.action}`, signature);
  return { action: outcome.action, signature, warnings, stepError: outcome.stepError };
}

/** Ticks until one returns no action. Returns the actions taken. */
async function tickUntilIdle(f: Fork, memory: TickMemory, limit = 12): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await tick(f, memory);
    if (result.stepError) throw new Error(`tick failed: ${result.stepError}`);
    if (result.action === null) return results;
    results.push(result);
  }
  throw new Error(`the tick was still acting after ${limit} ticks: ${results.map((r) => r.action).join(", ")}`);
}

/**
 * The first deploy, with one fork-only allowance. About one fork in four hands
 * klend a reserve snapshot it panics on in DepositReserveLiquidity ("attempt to
 * subtract with overflow", lending_checks.rs:462), the incoherent snapshot the
 * fork rules in klend.fork.ts warn about. Nothing of the pool's is in the
 * reserve yet, so the reserve is refetched and the deploy tried again.
 */
async function openAndDeploy(f: Fork, memory: TickMemory, refetch: () => Promise<void>): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (let refetches = 0; ; ) {
    const result = await tick(f, memory);
    if (result.stepError?.includes("panicked at") && refetches < 3) {
      refetches += 1;
      console.log(`STEP the reserve snapshot made klend panic; refetching it (attempt ${refetches} of 3)`);
      await refetch();
      Object.assign(memory, freshMemory());
      continue;
    }
    if (result.stepError) throw new Error(`tick failed: ${result.stepError}`);
    if (result.action === null) return results;
    results.push(result);
  }
}

/** Ticks until one takes `action`. Returns every tick's result up to and including it. */
async function tickUntilAction(f: Fork, memory: TickMemory, action: string, limit = 12): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await tick(f, memory);
    if (result.stepError) throw new Error(`tick failed: ${result.stepError}`);
    if (result.action === null) break;
    results.push(result);
    if (result.action === action) return results;
  }
  throw new Error(`the tick never took ${action}; it took: ${results.map((r) => r.action).join(", ") || "nothing"}`);
}

// ---- Invariants --------------------------------------------------------------------

/** The solvency helper of the spec, with the position valued from raw accounts. */
async function assertSolvent(f: Fork, label: string, dust: bigint): Promise<void> {
  const pool = await fetchPool(f);
  const state = await poolState(f);
  const vault = await tokenBalance(f.principalVault);
  const position = await positionValue(state);
  const claims = big(pool.totalPrincipal) + big(pool.yieldOwed) + big(pool.feeOwed) + big(pool.prizeOwed) - big(pool.deficit);
  const assets = vault + position;
  console.log(`CHECK solvent [${label}] vault=${vault} position=${position} booked=${pool.venueValue} claims=${claims} margin=${assets - claims} (dust allowed ${dust})`);
  expect(assets + dust >= claims, `insolvent at ${label}`).toBe(true);
}

async function principals(f: Fork, wallets: Wallet[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const w of wallets) {
    out.set(w.name, big((await program.account.player.fetch(playerPda(f.pool, w.keypair.publicKey))).principal));
  }
  return out;
}

const showPrincipals = (m: Map<string, bigint>): string => [...m].map(([k, v]) => `${k}=${v}`).join(" ");

// ---- Targets -------------------------------------------------------------------------

interface Target {
  label: string;
  kind: number;
  pins: { program: PublicKey; market: PublicKey; reserve: PublicKey; tokenMint: PublicKey };
  /** Accounts to reset together before the run. */
  position(): Promise<PublicKey[]>;
}

const ONRE: Target = {
  label: "OnRe market USDC reserve",
  kind: VENUE_KIND.klend,
  pins: { program: KLEND, market: ONRE_MARKET, reserve: ONRE_RESERVE, tokenMint: collateralMint(ONRE_MARKET) },
  position: async () => klendAccounts(ONRE_MARKET, ONRE_RESERVE),
};

const ROCKAWAYX: Target = {
  label: "RockawayX RWA USDC vault",
  kind: VENUE_KIND.kvault,
  pins: { program: KVAULT_PROGRAM_ID, market: VAULT, reserve: sharesMintAddress(VAULT), tokenMint: SHARES_MINT },
  position: kvaultPosition,
};

/** Runbook step 1, with the spl-token command the runbook gives. */
async function prepareTarget(f: Fork, target: Target): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(target.pins.tokenMint, f.pool, true);
  const dir = mkdtempSync(join(tmpdir(), "venue-switch-"));
  const payer = join(dir, "payer.json");
  writeFileSync(payer, JSON.stringify([...f.admin.secretKey]), { mode: 0o600 });
  const url = connection.rpcEndpoint;
  const create = await run("spl-token", ["create-account", target.pins.tokenMint.toBase58(), "--owner", f.pool.toBase58(), "--fee-payer", payer, "--url", url]);
  console.log(`CLI spl-token create-account ${target.pins.tokenMint.toBase58()} --owner <POOL_PDA> --fee-payer <admin> => ${create.stdout.trim().split("\n").join(" | ")}`);
  const info = await run("spl-token", ["account-info", "--address", ata.toBase58(), "--url", url]);
  console.log(`CLI spl-token account-info --address ${ata.toBase58()} => ${info.stdout.trim().split("\n").filter(Boolean).join(" | ")}`);
  expect(await connection.getAccountInfo(ata)).not.toBeNull();
  return ata;
}

// ---- The rehearsal ---------------------------------------------------------------------

/** Atomic units; the line step 3 of the runbook sets so the drain empties the position. */
const LOWERED_LINE = 10_000n;
const DEFAULT_LINE = 100_000_000n;

interface Options {
  /** Emergency park: drain with the deploy pause and no proposal before proposing. */
  park: boolean;
  /** Skip runbook step 3 and stop at the migration, to see what the default 100 USDC line leaves behind. */
  defaultLine: boolean;
}

async function rehearse(source: string, target: Target, { park, defaultLine }: Options): Promise<void> {
  const name = park ? `park then ${target.label}` : `${source} to ${target.label}`;
  console.log(`\nSTEP ===== ${name} (chain time ${new Date((await chainNow()) * 1000).toISOString()}) =====`);
  await resetAll([...klendAccounts(SOLBTC_MARKET, SOLBTC_RESERVE), ...(await target.position())]);
  const f = await bootstrapPool();
  console.log(`STEP bootstrapped pool ${f.pool.toBase58()} on the SOL/BTC USDC reserve; admin ${f.admin.publicKey.toBase58()}, operator ${f.operator.publicKey.toBase58()}`);
  const memory = freshMemory();
  // Each venue operation can cost the pool a unit or two of rounding and, on a
  // vault, its exit cost; the helper allows this much per operation so far.
  const dust = 1_500n;
  let ops = 0n;
  const solvent = (label: string) => assertSolvent(f, label, dust * (ops + 1n));

  const first = await poolState(f);
  expect(first.venueKind).toBe(VENUE_KIND.klend);
  expect(first.klendReserve.equals(SOLBTC_RESERVE)).toBe(true);

  // The jackpot starts through the CLI in multisig mode, like every admin action.
  await adminCli(f, ["start-jackpot"], "multisig");

  // 1. Players deposit.
  const alice = await fundedWallet(f, "alice", 8_000n);
  const bob = await fundedWallet(f, "bob", 5_000n);
  const carol = await fundedWallet(f, "carol", 2_000n);
  const players = [alice, bob, carol];
  for (const [wallet, amount] of [[alice, 8_000n], [bob, 5_000n], [carol, 2_000n]] as const) {
    const { instruction, pool } = await userInstruction(f, wallet, "deposit", amount * USDC_UNIT);
    await sendAs(`deposit ${wallet.name} ${amount} USDC`, [instruction], wallet.keypair, pool);
  }
  await solvent("after deposits");

  // 2. The tick opens the epoch and deploys on its own.
  const opened = await openAndDeploy(f, memory, () =>
    resetAll([...klendAccounts(SOLBTC_MARKET, SOLBTC_RESERVE), ...(target.kind === VENUE_KIND.klend ? klendAccounts(ONRE_MARKET, ONRE_RESERVE) : [])]),
  );
  console.log(`STEP tick sequence after deposits: ${opened.map((r) => r.action).join(" -> ")}`);
  expect(opened.map((r) => r.action)).toEqual(["begin_epoch", "deploy_to_venue"]);
  ops += 1n;
  const deployed = await poolState(f);
  expect(deployed.venueValue > 10_000n * USDC_UNIT).toBe(true);
  console.log(`CHECK deployed: venueValue=${usdc(deployed.venueValue)} at reserve ${deployed.klendReserve.toBase58()} (cTokens ${await tokenBalance(deployed.klendCtoken)})`);
  await solvent("after first deploy");

  // 3. A gain through time travel, booked by the next deposit's sync.
  await timeTravel(6 * 3_600);
  const dave = await fundedWallet(f, "dave", 500n);
  {
    const { instruction, pool } = await userInstruction(f, dave, "deposit", 100n * USDC_UNIT);
    await sendAs("deposit dave 100 USDC (sync after 6h)", [instruction], dave.keypair, pool);
  }
  const afterGain = await fetchPool(f);
  const gain = big(afterGain.venueValue) - big(deployed.venueValue);
  console.log(`CHECK gain after 6h: venueValue ${usdc(deployed.venueValue)} -> ${usdc(big(afterGain.venueValue))} (+${gain})`);
  expect(gain > 0n).toBe(true);
  await solvent("after the 6h gain");

  // 4. One withdrawal is queued (alice, 500 USDC); epoch 1 has begun, so it is not a refund.
  {
    const { instruction, pool } = await userInstruction(f, alice, "requestWithdraw", 500n * USDC_UNIT);
    await sendAs("request_withdraw alice 500 USDC (queued)", [instruction], alice.keypair, pool);
  }
  const queued = await program.account.player.fetch(playerPda(f.pool, alice.keypair.publicKey));
  expect(big(queued.pendingWithdraw)).toBe(500n * USDC_UNIT);
  console.log(`CHECK queued: alice pendingWithdraw=${queued.pendingWithdraw} pendingEpoch=${queued.pendingEpoch}`);
  await solvent("after the queued withdrawal");

  // 5. Emergency park (run 3 only): drain with the deploy pause, no proposal.
  if (park) {
    const value = big((await fetchPool(f)).venueValue);
    const vaultBefore = await tokenBalance(f.principalVault);
    const parked = await adminCli(f, ["drain-venue", "--amount", value.toString()], "operator");
    ops += 1n;
    const after = await fetchPool(f);
    const drained = await eventOf<{ asked: BN; received: BN; venueValue: BN }>(parked.signature!, "venueDrained");
    console.log(`CHECK park: venueDrained asked=${drained.asked} received=${drained.received} venueValue=${drained.venueValue}; deployPaused=${after.deployPaused}; vault ${usdc(vaultBefore)} -> ${usdc(await tokenBalance(f.principalVault))}`);
    expect(after.deployPaused).toBe(true);
    expect(big(after.venueValue) < 10_000_000n).toBe(true);
    expect((await tokenBalance(f.principalVault)) - vaultBefore >= value - 10n).toBe(true);
    await solvent("after the park drain");
    // Deploys stay off: the tick sends nothing although the vault is far above its idle band.
    const idle = await tickUntilIdle(f, memory);
    expect(idle.map((r) => r.action)).toEqual([]);
    console.log("CHECK park: the tick deployed nothing while paused");
    // Withdrawals work the whole time: dave's pending deposit refunds from the vault.
    const { instruction, pool } = await userInstruction(f, dave, "requestWithdraw", 40n * USDC_UNIT);
    const walletBefore = await tokenBalance(dave.tokenAccount);
    await sendAs("request_withdraw dave 40 USDC (refund while parked)", [instruction], dave.keypair, pool);
    expect((await tokenBalance(dave.tokenAccount)) - walletBefore).toBe(40n * USDC_UNIT);
    await solvent("after a refund while parked");
  }

  // 6. Prepare the target and propose, in multisig mode.
  const targetAta = await prepareTarget(f, target);
  const proposeArgs = [
    "propose-venue",
    "--kind", target.kind === VENUE_KIND.kvault ? "kvault" : "klend",
    "--program", target.pins.program.toBase58(),
    "--market", target.pins.market.toBase58(),
    "--reserve", target.pins.reserve.toBase58(),
    "--ctoken", targetAta.toBase58(),
  ];
  const proposed = await adminCli(f, proposeArgs, "multisig");
  const proposalAccount = await connection.getAccountInfo(venueProposalAddress(f.chain.programId, f.pool), "confirmed");
  expect(proposalAccount).not.toBeNull();
  const proposal = await eventOf<{ proposedAt: BN; unlocksAt: BN; venueKind: number }>(proposed.signature!, "venueProposed");
  console.log(`CHECK proposal: kind=${proposal.venueKind} proposedAt=${proposal.proposedAt} unlocksAt=${proposal.unlocksAt} (lock ${big(proposal.unlocksAt) - big(proposal.proposedAt)}s)`);
  expect(big(proposal.unlocksAt) - big(proposal.proposedAt)).toBe(VENUE_LOCK_SECONDS);

  // The tick leaves the pool alone while the lock runs (no deploy, no early drain).
  const waiting = await tickUntilIdle(f, memory);
  console.log(`CHECK during the lock the tick took: [${waiting.map((r) => r.action).join(", ")}]`);
  expect(waiting.map((r) => r.action)).toEqual([]);

  // Deposits and withdrawal requests keep working during the proposal.
  {
    const erin = await fundedWallet(f, "erin", 200n);
    const { instruction, pool } = await userInstruction(f, erin, "deposit", 100n * USDC_UNIT);
    await sendAs("deposit erin 100 USDC (during the proposal)", [instruction], erin.keypair, pool);
    players.push(erin);
  }
  players.push(dave);
  await solvent("during the proposal");

  // 7. Runbook step 3: lower the dust line.
  if (!defaultLine) {
    await adminCli(f, ["set-venue-params", "--min-venue-move", LOWERED_LINE.toString()], "multisig");
    expect(big((await fetchPool(f)).minVenueMove)).toBe(LOWERED_LINE);
  }

  // 8. Wait out the lock (time travel), then the tick does the rest.
  await timeTravel(Number(VENUE_LOCK_SECONDS) + 120);
  const principalsBefore = await principals(f, players);
  console.log(`CHECK principals before the drain: ${showPrincipals(principalsBefore)}`);
  const oldPool = await poolState(f);
  const oldCtoken = oldPool.klendCtoken;
  const steps = await tickUntilAction(f, memory, "migrate_venue");
  const actions = steps.map((r) => r.action);
  console.log(`STEP tick sequence after the lock: ${actions.join(" -> ")}`);
  expect(actions.at(-1)).toBe("migrate_venue");
  expect(actions.slice(0, -1).every((a) => a === "drain_venue")).toBe(true);
  if (park) expect(actions).toEqual(["migrate_venue"]);
  else expect(actions.length).toBeGreaterThanOrEqual(2);
  ops += BigInt(actions.length);
  for (const step of steps.filter((s) => s.action === "drain_venue")) {
    const drained = await eventOf<{ asked: BN; received: BN; venueValue: BN }>(step.signature!, "venueDrained");
    console.log(`CHECK drain: asked=${drained.asked} received=${drained.received} venueValue after=${drained.venueValue}`);
  }
  const migrated = await eventOf<{ leftBehind: BN; newVenueKind: number; newKlendReserve: PublicKey; newKlendCtoken: PublicKey }>(
    steps.at(-1)!.signature!,
    "venueMigrated",
  );
  console.log(`CHECK migrated: leftBehind=${migrated.leftBehind} newKind=${migrated.newVenueKind} newReserve=${migrated.newKlendReserve.toBase58()}`);
  expect(big(migrated.leftBehind) <= (defaultLine ? DEFAULT_LINE : LOWERED_LINE)).toBe(true);
  const after = await fetchPool(f);
  expect(after.venueKind).toBe(target.kind);
  expect(after.klendReserve.equals(target.pins.reserve)).toBe(true);
  expect(after.klendCtoken.equals(targetAta)).toBe(true);
  expect(big(after.venueValue)).toBe(0n);
  expect(await connection.getAccountInfo(venueProposalAddress(f.chain.programId, f.pool), "confirmed")).toBeNull();
  const leftAtOld = await tokenBalance(oldCtoken);
  console.log(`CHECK old position left at the old venue: ${leftAtOld} cTokens (booked value left behind ${migrated.leftBehind})`);
  const principalsAfter = await principals(f, players);
  console.log(`CHECK principals after the migration: ${showPrincipals(principalsAfter)}`);
  expect(showPrincipals(principalsAfter)).toBe(showPrincipals(principalsBefore));
  if (defaultLine) {
    // The tick read the position as of the last sync, so the first drain left
    // the interest accrued over the lock, which is under the 100 USDC line and
    // so is not drained. It is booked in the pool's claims and sits at the old venue.
    const leftValue = await klendValue(oldPool.klendReserve, leftAtOld);
    const state = await fetchPool(f);
    const claims = big(state.totalPrincipal) + big(state.yieldOwed) + big(state.feeOwed) + big(state.prizeOwed) - big(state.deficit);
    const shortfall = claims - (await tokenBalance(f.principalVault));
    console.log(`CHECK default line: left behind ${migrated.leftBehind} (${usdc(big(migrated.leftBehind))}); worth ${leftValue} at the old reserve; the pool's claims exceed what it tracks by ${shortfall}`);
    expect(big(migrated.leftBehind) > 1_000_000n).toBe(true);
    expect(shortfall).toBeGreaterThan(big(migrated.leftBehind) - 10n);
    console.log(`STEP ===== ${name}: passed =====`);
    return;
  }
  await solvent("after the migration");

  // 9. Deploy at the new venue. A park left the pause on; only the admin clears it.
  if (park) {
    const stuck = await tickUntilIdle(f, memory);
    expect(stuck.map((r) => r.action)).toEqual([]);
    await adminCli(f, ["start-deploy"], "multisig");
  }
  const redeploy = await tickUntilIdle(f, memory);
  console.log(`STEP tick sequence after the migration: ${redeploy.map((r) => r.action).join(" -> ")}`);
  expect(redeploy.map((r) => r.action)).toEqual(["deploy_to_venue"]);
  ops += 1n;
  const now = await poolState(f);
  const held = await tokenBalance(now.klendCtoken);
  console.log(`CHECK deployed at ${target.label}: venueValue=${usdc(now.venueValue)}, position tokens ${held}, vault ${usdc(await tokenBalance(f.principalVault))}`);
  expect(now.venueValue > 10_000n * USDC_UNIT).toBe(true);
  expect(held > 0n).toBe(true);
  expect(now.klendReserve.equals(target.pins.reserve)).toBe(true);
  await solvent("after the deploy at the new venue");
  const principalsDeployed = await principals(f, players);
  expect(showPrincipals(principalsDeployed)).toBe(showPrincipals(principalsBefore));

  // 10. Runbook step 8: restore the dust line.
  await adminCli(f, ["set-venue-params", "--min-venue-move", DEFAULT_LINE.toString()], "multisig");

  // 11. The queued withdrawal pays once its epoch has ended. The tick opens
  // the next epoch; the jackpot is then paused so the draw (ORAO) stays out of
  // the rehearsal, and the tick's own withdrawal step pays alice.
  const epoch1 = decodeEpoch(idlProgram, (await connection.getAccountInfo(epochAddress(f.chain.programId, f.pool, 1n), "confirmed"))!.data);
  await timeTravelTo(Number(epoch1.endsAt) + 30);
  const aliceBefore = await tokenBalance(alice.tokenAccount);
  const opened2 = await tick(f, memory);
  expect(opened2.action).toBe("begin_epoch");
  // The Operator may pause the jackpot, so the CLI sends it from the loaded key.
  await adminCli(f, ["pause-jackpot"], "operator");
  const paid = await tickUntilIdle(f, memory);
  console.log(`STEP tick sequence at the epoch boundary: begin_epoch -> ${paid.map((r) => r.action).join(" -> ")}`);
  const received = (await tokenBalance(alice.tokenAccount)) - aliceBefore;
  console.log(`CHECK withdrawal: alice received ${usdc(received)}`);
  expect(received).toBe(500n * USDC_UNIT);
  const principalsEnd = await principals(f, players);
  // Paying settles alice's accrued yield into her Principal, so hers is the 500
  // less plus that yield; nobody else was touched.
  const aliceSettled = principalsEnd.get("alice")! - (principalsBefore.get("alice")! - 500n * USDC_UNIT);
  console.log(`CHECK principals at the end: ${showPrincipals(principalsEnd)} (alice: 500 paid, ${aliceSettled} of yield settled into Principal; the others as before)`);
  expect(aliceSettled >= 0n && aliceSettled < 50n * USDC_UNIT).toBe(true);
  for (const [who, value] of principalsBefore) if (who !== "alice") expect(principalsEnd.get(who), who).toBe(value);
  await solvent("after the queued withdrawal paid");
  console.log(`STEP ===== ${name}: passed =====`);
}

describe("venue switch on a mainnet fork", () => {
  it("klend to klend: SOL/BTC USDC reserve to the OnRe market's USDC reserve", async () => {
    await rehearse("SOL/BTC USDC reserve", ONRE, { park: false, defaultLine: false });
  }, TIMEOUT);

  it("klend to kVault: SOL/BTC USDC reserve to the RockawayX RWA USDC vault", async () => {
    await rehearse("SOL/BTC USDC reserve", ROCKAWAYX, { park: false, defaultLine: false });
  }, TIMEOUT);

  it("emergency park: drain with the deploy pause and no proposal, then a normal proposal", async () => {
    await rehearse("SOL/BTC USDC reserve", ONRE, { park: true, defaultLine: false });
  }, TIMEOUT);

  it("the default 100 USDC dust line lets the migration leave the interest accrued over the lock behind", async () => {
    await rehearse("SOL/BTC USDC reserve", ONRE, { park: false, defaultLine: true });
  }, TIMEOUT);
});
