/**
 * The seven permissionless cranks as instructions, built in the browser. The
 * account lists mirror the backend's `OperatorInstructions`
 * (apps/backend/src/operator/instructions.ts): every account is passed
 * explicitly, so building costs no RPC read. The pool and the stuck Round or
 * epoch are read from the chain once, at click time, by the `load*` helpers.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  accountOf,
  bn,
  epochAddress,
  jackpotVaultAddress,
  method,
  playerAddress,
  POOL_ID,
  poolAddress,
  principalVaultAddress,
  roundAddress,
  type HexVaultProgram,
} from "../chain.js";
import { parseAtomic } from "../lib/money.js";
import { USDC_DECIMALS } from "./format.js";

/** What the venue cranks need from the Pool account. */
export interface VenuePool {
  address: PublicKey;
  acceptedMint: PublicKey;
  treasury: PublicKey;
  weightTree: PublicKey;
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
}

/** A Round or epoch's randomness request seed, read off its account. */
export interface RoundSeed {
  roundId: bigint;
  vrfSeed: Uint8Array;
}
export interface EpochSeed {
  epochId: bigint;
  vrfSeed: Uint8Array;
}

/** USDC text to base units. Null for blank, zero, negative or sub-micro input. */
export function parseUsdcAmount(text: string): bigint | null {
  const atomic = parseAtomic(text, USDC_DECIMALS);
  return atomic !== null && atomic > 0n ? atomic : null;
}

/** ORAO VRF v2 (programs/hex_vault/src/vrf.rs); same constant the backend uses. */
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

/**
 * Where the program expects the randomness account: ORAO's request PDA, or a
 * PDA of this program in a `test-vrf` build (the IDL then has `test_fulfill`).
 */
function randomnessFor(program: HexVaultProgram, seed: Uint8Array): PublicKey {
  const testVrf = program.idl.instructions.some(
    (ix) => ix.name === "testFulfill" || ix.name === "test_fulfill",
  );
  const [prefix, owner] = testVrf
    ? ["test-vrf", program.programId]
    : ["orao-vrf-randomness-request", ORAO_VRF_PROGRAM_ID];
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), Buffer.from(seed)], owner)[0];
}

/** The calls this file makes on an Anchor builder. */
interface Built {
  remainingAccounts(accounts: AccountMeta[]): Built;
  instruction(): Promise<TransactionInstruction>;
}
const build = (
  program: HexVaultProgram,
  name: string,
  accounts: Record<string, PublicKey | null>,
  args: unknown[] = [],
  remaining: AccountMeta[] = [],
): Promise<TransactionInstruction> => {
  // SAFETY: the web's TxBuilder type omits accountsPartial, which every Anchor builder has.
  const builder = method(program, name)(...args) as unknown as {
    accountsPartial(a: Record<string, PublicKey | null>): Built;
  };
  return builder.accountsPartial(accounts).remainingAccounts(remaining).instruction();
};

const venue = (pool: VenuePool) => ({
  klendProgram: pool.klendProgram,
  klendMarket: pool.klendMarket,
  klendReserve: pool.klendReserve,
  klendCtoken: pool.klendCtoken,
});

/**
 * Beyond the pinned four a venue deposit or redeem needs the market authority,
 * the reserve's liquidity supply, the cToken mint and the instructions
 * sysvar. The `test-venue` stub pins this program as its own klend and ignores
 * them (backend `venueRemaining`).
 */
function venueRemaining(program: HexVaultProgram, pool: VenuePool): AccountMeta[] {
  if (pool.klendProgram.equals(program.programId)) return [];
  const derive = (...seeds: (string | PublicKey)[]): PublicKey =>
    PublicKey.findProgramAddressSync(
      seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
      pool.klendProgram,
    )[0];
  const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
    pubkey,
    isSigner: false,
    isWritable,
  });
  return [
    meta(derive("lma", pool.klendMarket), false),
    meta(derive("reserve_liq_supply", pool.klendMarket, pool.acceptedMint), true),
    meta(derive("reserve_coll_mint", pool.klendMarket, pool.acceptedMint), true),
    meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
  ];
}

const principalAccounts = (pool: VenuePool) => ({
  pool: pool.address,
  principalVault: principalVaultAddress(pool.address),
  acceptedMint: pool.acceptedMint,
  ...venue(pool),
  tokenProgram: TOKEN_PROGRAM_ID,
});

export const deployToVenue = (program: HexVaultProgram, pool: VenuePool, amount: bigint) =>
  build(program, "deployToVenue", principalAccounts(pool), [bn(amount)], venueRemaining(program, pool));

export const recall = (program: HexVaultProgram, pool: VenuePool, amount: bigint) =>
  build(program, "recall", principalAccounts(pool), [bn(amount)], venueRemaining(program, pool));

export const harvest = (program: HexVaultProgram, pool: VenuePool) =>
  build(
    program,
    "harvest",
    {
      ...principalAccounts(pool),
      jackpotVault: jackpotVaultAddress(pool.address),
      treasury: pool.treasury,
    },
    [],
    venueRemaining(program, pool),
  );

/** Pays `amount` from the payer's own USDC account; the program caps it at the deficit. */
export const coverDeficit = (
  program: HexVaultProgram,
  pool: VenuePool,
  payer: PublicKey,
  amount: bigint = 1n,
) =>
  build(
    program,
    "coverDeficit",
    {
      payer,
      payerToken: getAssociatedTokenAddressSync(pool.acceptedMint, payer),
      ...principalAccounts(pool),
    },
    [bn(amount)],
    venueRemaining(program, pool),
  );

/**
 * Pays one Player's due withdrawal. The program wants no owner signer (it
 * needs one only while the pool is impaired, when the owner pays for their own
 * haircut), so `owner: null`. An idempotent ATA create goes first, paid by the
 * connected wallet, so a Player who closed their account does not block it.
 */
export async function processWithdraw(
  program: HexVaultProgram,
  pool: VenuePool,
  payer: PublicKey,
  owner: PublicKey,
): Promise<TransactionInstruction[]> {
  const ownerToken = getAssociatedTokenAddressSync(pool.acceptedMint, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, ownerToken, owner, pool.acceptedMint),
    await build(program, "processWithdraw", {
      pool: pool.address,
      player: playerAddress(pool.address, owner),
      owner: null,
      weightTree: pool.weightTree,
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      ...venue(pool),
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  ];
}

export const voidRound = (program: HexVaultProgram, pool: VenuePool, caller: PublicKey, round: RoundSeed) =>
  build(program, "voidRound", {
    caller,
    pool: pool.address,
    round: roundAddress(pool.address, round.roundId),
    randomness: randomnessFor(program, round.vrfSeed),
  });

export const rolloverEpoch = (program: HexVaultProgram, pool: VenuePool, caller: PublicKey, epoch: EpochSeed) =>
  build(program, "rolloverEpoch", {
    caller,
    pool: pool.address,
    epoch: epochAddress(pool.address, epoch.epochId),
    randomness: randomnessFor(program, epoch.vrfSeed),
  });

// Chain reads, once per click.

const asKey = (value: unknown): PublicKey => new PublicKey(value as PublicKey);

/** The Pool account as the venue cranks need it. */
export async function loadPool(program: HexVaultProgram): Promise<VenuePool> {
  const address = poolAddress(POOL_ID);
  const a = (await accountOf(program, "pool").fetch(address)) as Record<string, unknown>;
  return {
    address,
    acceptedMint: asKey(a.acceptedMint),
    treasury: asKey(a.treasury),
    weightTree: asKey(a.weightTree),
    klendProgram: asKey(a.klendProgram),
    klendMarket: asKey(a.klendMarket),
    klendReserve: asKey(a.klendReserve),
    klendCtoken: asKey(a.klendCtoken),
  };
}

const seedOf = (value: unknown): Uint8Array => Uint8Array.from(value as ArrayLike<number>);

export async function loadRoundSeed(program: HexVaultProgram, roundId: bigint): Promise<RoundSeed> {
  const a = (await accountOf(program, "round").fetch(roundAddress(poolAddress(POOL_ID), roundId))) as Record<string, unknown>;
  return { roundId, vrfSeed: seedOf(a.vrfSeed) };
}

export async function loadEpochSeed(program: HexVaultProgram, epochId: bigint): Promise<EpochSeed> {
  const a = (await accountOf(program, "epoch").fetch(epochAddress(poolAddress(POOL_ID), epochId))) as Record<string, unknown>;
  return { epochId, vrfSeed: seedOf(a.vrfSeed) };
}
