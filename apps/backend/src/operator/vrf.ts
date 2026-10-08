// Randomness plumbing shared by the tick and its tests: the address of the
// account that answers a request and the fulfilled check.
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
 * `draw` rejects the account and no epoch ever draws.
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
 * A fresh 32-byte nonce for one randomness request. Cryptographically random:
 * predictability would let a griefer precompute the resulting seed and
 * pre-create ORAO's request account for it before the Operator ever asks.
 */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
