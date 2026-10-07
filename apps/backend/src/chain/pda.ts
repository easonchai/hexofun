// Seeds mirror programs/hex_vault/src/constants.rs and spec.md §2.1. Pure
// functions so the smoke test can derive an address with no live connection.
import { PublicKey } from "@solana/web3.js";

const SEED_POOL = Buffer.from("pool");
const SEED_PRINCIPAL = Buffer.from("principal");
const SEED_JACKPOT = Buffer.from("jackpot");
const SEED_EPOCH = Buffer.from("epoch");
const SEED_ROUND = Buffer.from("round");
const SEED_PLAYER = Buffer.from("player");
const SEED_POSITION = Buffer.from("position");
const SEED_VENUE_PROPOSAL = Buffer.from("venue_proposal");

const leU64 = (value: bigint): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
};

const pda = (programId: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const poolAddress = (programId: PublicKey, poolId: bigint): PublicKey =>
  pda(programId, [SEED_POOL, leU64(poolId)]);

export const epochAddress = (
  programId: PublicKey,
  pool: PublicKey,
  epochId: bigint,
): PublicKey => pda(programId, [SEED_EPOCH, pool.toBuffer(), leU64(epochId)]);

// Round IDs are a single pool-wide counter (Pool.next_round_id), not scoped
// to an epoch, so the seed is just [round, pool, round_id].
export const roundAddress = (
  programId: PublicKey,
  pool: PublicKey,
  roundId: bigint,
): PublicKey => pda(programId, [SEED_ROUND, pool.toBuffer(), leU64(roundId)]);

export const playerAddress = (
  programId: PublicKey,
  pool: PublicKey,
  owner: PublicKey,
): PublicKey => pda(programId, [SEED_PLAYER, pool.toBuffer(), owner.toBuffer()]);

export const positionAddress = (
  programId: PublicKey,
  round: PublicKey,
  owner: PublicKey,
): PublicKey =>
  pda(programId, [SEED_POSITION, round.toBuffer(), owner.toBuffer()]);

export const principalVaultAddress = (
  programId: PublicKey,
  pool: PublicKey,
): PublicKey => pda(programId, [SEED_PRINCIPAL, pool.toBuffer()]);

export const jackpotVaultAddress = (
  programId: PublicKey,
  pool: PublicKey,
): PublicKey => pda(programId, [SEED_JACKPOT, pool.toBuffer()]);

/** The pool's open venue proposal, if any (`propose_venue`). `deploy_to_venue`
 *  takes it as an account and refuses while the program owns it. */
export const venueProposalAddress = (
  programId: PublicKey,
  pool: PublicKey,
): PublicKey => pda(programId, [SEED_VENUE_PROPOSAL, pool.toBuffer()]);
