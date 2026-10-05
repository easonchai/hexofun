// Randomness plumbing shared by the tick and its tests: the request seed the
// program derives, the address of the account that answers it, and the
// fulfilled check.
import { randomBytes } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { utils } from "@anchor-lang/core";

/** ORAO VRF v2, `programs/hex_vault/src/vrf.rs`. */
export const ORAO_VRF_PROGRAM_ID = new PublicKey(
  "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y",
);
/**
 * ORAO's fee treasury on devnet (`network_state.config.treasury`, read
 * 2026-09-05). Public address, not a secret. The program only forwards it and
 * ORAO rejects any other account; `test-vrf` builds never touch it.
 */
export const ORAO_VRF_TREASURY = new PublicKey(
  "9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR",
);

const SEED_TEST_VRF = Buffer.from("test-vrf");
const SEED_ORAO_REQUEST = Buffer.from("orao-vrf-randomness-request");

/** `[8 discriminator][1 enum tag][32 client][32 seed][64 randomness]`. */
const FULFILLED_LEN = 8 + 1 + 32 + 32 + 64;
/** ORAO's `RandomnessV2` Anchor account discriminator. */
export const RANDOMNESS_DISCRIMINATOR = Buffer.from(
  utils.sha256.hash("account:RandomnessV2"),
  "hex",
).subarray(0, 8);

/**
 * True when the account exists, is a `RandomnessV2`, and carries the
 * `Fulfilled` tag (ORAO's borsh enum: `Pending = 0`, `Fulfilled = 1`). Mirrors
 * `vrf::parse_fulfilled`, minus the address check the caller already made by
 * deriving the address it fetched.
 */
export function isFulfilled(data: Uint8Array | null | undefined): boolean {
  if (!data || data.length < FULFILLED_LEN) return false;
  if (!RANDOMNESS_DISCRIMINATOR.equals(Buffer.from(data.subarray(0, 8)))) return false;
  return data[8] === 1;
}

/**
 * Address the program will check the randomness account against.
 *
 * `test-vrf` builds put a fabricated account at a PDA of this program;
 * everything else uses ORAO's `[prefix, seed]` request PDA (the network state
 * is not part of the derivation). Getting this wrong means
 * `request_round_randomness` rejects the account and no round ever settles.
 */
export function randomnessAddress(
  programId: PublicKey,
  seed: Uint8Array,
  testVrf: boolean,
): PublicKey {
  return testVrf
    ? PublicKey.findProgramAddressSync([SEED_TEST_VRF, Buffer.from(seed)], programId)[0]
    : PublicKey.findProgramAddressSync(
        [SEED_ORAO_REQUEST, Buffer.from(seed)],
        ORAO_VRF_PROGRAM_ID,
      )[0];
}

/**
 * `utils::vrf_seed`: keccak256(domain || pool || id_le || nonce). A Round or
 * Epoch stores its seed once the program computes it, so this is only needed
 * for `request_round_randomness` and `request_draw`, which have to
 * derive the randomness account address for the same request they are about
 * to make (beta-launch-fixes ticket 02: the nonce makes that address
 * unknowable to anyone before the request lands).
 */
export function vrfSeed(
  domain: "round" | "epoch",
  pool: PublicKey,
  id: bigint,
  nonce: Uint8Array,
): Uint8Array {
  const idLe = Buffer.alloc(8);
  idLe.writeBigUInt64LE(id);
  return keccak256(Buffer.concat([Buffer.from(domain), pool.toBuffer(), idLe, Buffer.from(nonce)]));
}

/**
 * A fresh 32-byte nonce for one randomness request. Cryptographically random:
 * predictability would let a griefer precompute the resulting seed and
 * pre-create ORAO's request account for it before the Operator ever asks.
 */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

// --- keccak256 -------------------------------------------------------------
//
// Solana's `keccak` syscall is the pre-standard Keccak, which differs from
// SHA3-256 only in the padding byte. Node's crypto has sha3-256 but not this,
// and no dependency in the workspace carries it, so the permutation is inline.
// It runs once per epoch on 48 bytes; speed is irrelevant.

const RATE = 136;
const ROUNDS = 24;

const ROUND_CONSTANTS = new BigUint64Array([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);

// Rotation offsets r[x][y], flattened as x + 5y.
const ROTATIONS = new BigUint64Array([
  0n, 1n, 62n, 28n, 27n, 36n, 44n, 6n, 55n, 20n, 3n, 10n, 43n, 25n, 39n, 41n, 45n, 15n,
  21n, 8n, 18n, 2n, 61n, 56n, 14n,
]);

const rotl = (x: bigint, n: bigint): bigint =>
  n === 0n ? x : (x << n) | (x >> (64n - n));

// SAFETY: every index below is derived from the loop bounds and is inside the
// array it reads, so the `undefined` noUncheckedIndexedAccess adds to a typed
// array read never occurs. Writes truncate to 64 bits, which is the modular
// arithmetic Keccak wants, so the permutation needs no explicit masking.
const at = (lanes: BigUint64Array, index: number): bigint => lanes[index] as bigint;

function permute(lanes: BigUint64Array): void {
  const c = new BigUint64Array(5);
  const b = new BigUint64Array(25);
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] =
        at(lanes, x) ^
        at(lanes, x + 5) ^
        at(lanes, x + 10) ^
        at(lanes, x + 15) ^
        at(lanes, x + 20);
    }
    for (let x = 0; x < 5; x += 1) {
      const d = at(c, (x + 4) % 5) ^ rotl(at(c, (x + 1) % 5), 1n);
      for (let y = 0; y < 25; y += 5) lanes[x + y] = at(lanes, x + y) ^ d;
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(
          at(lanes, x + 5 * y),
          at(ROTATIONS, x + 5 * y),
        );
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        lanes[x + y] =
          at(b, x + y) ^ (~at(b, ((x + 1) % 5) + y) & at(b, ((x + 2) % 5) + y));
      }
    }
    lanes[0] = at(lanes, 0) ^ at(ROUND_CONSTANTS, round);
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  // Pad to a whole number of rate blocks: 0x01, zeros, then 0x80 on the last
  // byte. Both land on the same byte when the input fills all but one.
  const padded = new Uint8Array((Math.floor(input.length / RATE) + 1) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const lanes = new BigUint64Array(25);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane += 1) {
      lanes[lane] = at(lanes, lane) ^ view.getBigUint64(offset + lane * 8, true);
    }
    permute(lanes);
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let lane = 0; lane < 4; lane += 1) out.setBigUint64(lane * 8, at(lanes, lane), true);
  return digest;
}
