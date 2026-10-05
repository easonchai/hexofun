//! ORAO VRF v2 integration.
//!
//! Settle instructions never trust a client-supplied sample: they read the
//! fulfilled randomness account bound to this exact request and check its
//! address against [`randomness_address`]. The `RandomnessV2` layout and the
//! `request_v2` wire format below are pinned to ORAO's program (`VRFzZo…`),
//! verified against its SDK source and two fulfilled devnet requests on
//! 2026-09-05, so no dependency on ORAO's SDK crate is required.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use solana_sha256_hasher::hashv;

use crate::errors::HexVaultError;

pub const ORAO_VRF_PROGRAM_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

/// ORAO request-account PDA seed prefix.
pub const ORAO_REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";

/// ORAO network-state PDA seed prefix.
pub const ORAO_NETWORK_STATE_SEED: &[u8] = b"orao-vrf-network-configuration";

/// Seed prefix for the stand-in randomness account `test_fulfill` writes.
pub const TEST_VRF_SEED: &[u8] = b"test-vrf";

fn sha256(bytes: &[u8]) -> [u8; 32] {
    hashv(&[bytes]).to_bytes()
}

/// PDA of ORAO's request account for one of our seeds: `[prefix, seed]` under
/// the ORAO program, nothing else. Fully determined by the seed, so a settle
/// instruction can prove the account it reads is the one bound to this
/// request. (ORAO's SDK `randomness_account_address`; the network state is
/// not part of the derivation.)
pub fn orao_request_address(seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[ORAO_REQUEST_SEED, seed.as_ref()], &ORAO_VRF_PROGRAM_ID).0
}

/// Address the settle path must be handed for `seed`.
///
/// Real builds: ORAO's request PDA. `test-vrf` builds: a PDA of this program
/// that [`crate::test_vrf::test_fulfill`] can write, so localnet tests need
/// no ORAO deployment. The two never coexist — the devnet build is compiled
/// without the feature.
pub fn randomness_address(seed: &[u8; 32]) -> Pubkey {
    #[cfg(feature = "test-vrf")]
    {
        return Pubkey::find_program_address(&[TEST_VRF_SEED, seed.as_ref()], &crate::ID).0;
    }
    #[cfg(not(feature = "test-vrf"))]
    orao_request_address(seed)
}

/// Anchor discriminator of ORAO's `RandomnessV2` account.
pub fn randomness_discriminator() -> [u8; 8] {
    sha256(b"account:RandomnessV2")[..8]
        .try_into()
        .expect("fixed slice")
}

/// Byte length of a fulfilled `RandomnessV2` account:
/// `[8 discriminator][1 enum tag][32 client][32 seed][64 randomness]`.
pub const FULFILLED_LEN: usize = 8 + 1 + 32 + 32 + 64;

/// Extracts the 64-byte randomness from a fulfilled `RandomnessV2` account.
///
/// The tag is ORAO's `RequestAccount` borsh enum (`Pending = 0`,
/// `Fulfilled = 1`). Pending accounts are rejected: only a finalized draw may
/// settle a round or an epoch.
pub fn parse_fulfilled(data: &[u8]) -> Result<[u8; 64]> {
    if data.len() < FULFILLED_LEN {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    if data[..8] != randomness_discriminator()[..] {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    if data[8] != 1 {
        return Err(HexVaultError::RandomnessNotFulfilled.into());
    }
    let mut randomness = [0u8; 64];
    randomness.copy_from_slice(&data[FULFILLED_LEN - 64..]);
    Ok(randomness)
}

/// Reads the randomness account for `seed`, proving it is the one bound to
/// this request and that it has been fulfilled.
pub fn read_fulfilled(account: &AccountInfo, seed: &[u8; 32]) -> Result<[u8; 64]> {
    require_keys_eq!(
        *account.key,
        randomness_address(seed),
        HexVaultError::InvalidRandomnessAccount
    );
    parse_fulfilled(&account.try_borrow_data()?)
}

/// True when the account exists, matches the request, and is fulfilled.
/// Used by the operator's fulfilled check, never as a substitute for
/// [`read_fulfilled`] in an instruction.
pub fn is_fulfilled(account: &AccountInfo, seed: &[u8; 32]) -> bool {
    read_fulfilled(account, seed).is_ok()
}

/// Anchor discriminator of ORAO's `request_v2` instruction.
pub const REQUEST_V2_DISCRIMINATOR: [u8; 8] = [38, 151, 209, 6, 195, 102, 28, 217];

/// ORAO `request_v2` instruction. Accounts in ORAO's order: payer (signer,
/// mut), network_state (mut), treasury (mut), request (mut), system_program.
/// Data is the discriminator followed by the raw 32-byte seed (Borsh writes a
/// fixed-size array with no length prefix). ORAO creates the request account
/// itself, and rejects a `treasury` that is not `network_state.config.treasury`,
/// so this program only forwards both.
pub fn request_v2_instruction(
    payer: &Pubkey,
    network_state: &Pubkey,
    treasury: &Pubkey,
    request: &Pubkey,
    seed: &[u8; 32],
) -> Instruction {
    let mut data = Vec::with_capacity(40);
    data.extend_from_slice(&REQUEST_V2_DISCRIMINATOR);
    data.extend_from_slice(seed);
    Instruction {
        program_id: ORAO_VRF_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*network_state, false),
            AccountMeta::new(*treasury, false),
            AccountMeta::new(*request, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data,
    }
}

/// Requests randomness for one subject (a round's board or an epoch's draw).
/// Both request paths (rounds.rs, epochs.rs) call this so the CPI is written
/// once.
///
/// `test-vrf` builds no-op: nothing needs to exist here, because
/// [`crate::test_vrf::test_fulfill`] fabricates the fulfilled account
/// directly instead of going through a real request/fulfill round trip.
#[cfg(feature = "test-vrf")]
pub fn request_randomness<'info>(
    _payer: &AccountInfo<'info>,
    _network_state: &AccountInfo<'info>,
    _treasury: &AccountInfo<'info>,
    _randomness: &AccountInfo<'info>,
    _vrf_program: &AccountInfo<'info>,
    _system_program: &AccountInfo<'info>,
    _seed: [u8; 32],
) -> Result<()> {
    Ok(())
}

/// Real builds CPI ORAO's `request_v2` with `seed`. `payer` funds ORAO's fee
/// and the request account's rent, so it must be a writable signer of the
/// outer transaction.
#[cfg(not(feature = "test-vrf"))]
pub fn request_randomness<'info>(
    payer: &AccountInfo<'info>,
    network_state: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    randomness: &AccountInfo<'info>,
    vrf_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seed: [u8; 32],
) -> Result<()> {
    let ix = request_v2_instruction(
        payer.key,
        network_state.key,
        treasury.key,
        randomness.key,
        &seed,
    );
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            payer.clone(),
            network_state.clone(),
            treasury.clone(),
            randomness.clone(),
            system_program.clone(),
            vrf_program.clone(),
        ],
    )
    .map_err(Into::into)
}

/// SHA-256 of all 64 randomness bytes (ADR 0019). Every outcome, the round's
/// tile and the draw's target, reads from this digest, so no byte of the
/// oracle's output goes unused.
pub fn digest(randomness: &[u8; 64]) -> [u8; 32] {
    sha256(randomness)
}

/// u64 sample from the first 8 bytes of the digest (LE).
pub fn sample_u64(digest: &[u8; 32]) -> u64 {
    u64::from_le_bytes(digest[..8].try_into().expect("fixed slice"))
}

/// u128 sample from the first 16 bytes of the digest (LE).
pub fn sample_u128(digest: &[u8; 32]) -> u128 {
    u128::from_le_bytes(digest[..16].try_into().expect("fixed slice"))
}

/// Unbiased mapping that can never strand a fulfilled draw: a tail sample
/// (rejected for modulo-bias safety) is re-derived by hashing the digest
/// with a counter, instead of reverting a settle that has no retry path.
/// Deterministic and oracle-verifiable; the tail has probability
/// `range / 2^64`, so the counter practically never advances.
pub fn unbiased_u64(randomness: &[u8; 64], range: u64) -> Result<u64> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    let limit = u64::MAX - (u64::MAX % range);
    let base = digest(randomness);
    let mut counter: u8 = 0;
    loop {
        let sample = if counter == 0 {
            sample_u64(&base)
        } else {
            sample_u64(&rederive(&base, counter))
        };
        if sample < limit {
            return Ok(sample % range);
        }
        counter = counter
            .checked_add(1)
            .ok_or(HexVaultError::RandomnessRejection)?;
    }
}

/// The u128 twin of [`unbiased_u64`], for selecting a point under an epoch's
/// total Weight.
pub fn unbiased_u128(randomness: &[u8; 64], range: u128) -> Result<u128> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    let limit = u128::MAX - (u128::MAX % range);
    let base = digest(randomness);
    let mut counter: u8 = 0;
    loop {
        let sample = if counter == 0 {
            sample_u128(&base)
        } else {
            sample_u128(&rederive(&base, counter))
        };
        if sample < limit {
            return Ok(sample % range);
        }
        counter = counter
            .checked_add(1)
            .ok_or(HexVaultError::RandomnessRejection)?;
    }
}

fn rederive(base: &[u8; 32], counter: u8) -> [u8; 32] {
    let mut buf = [0u8; 33];
    buf[..32].copy_from_slice(base);
    buf[32] = counter;
    sha256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fulfilled_account(randomness: [u8; 64]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&randomness_discriminator());
        data.push(1); // RequestAccount::Fulfilled
        data.extend_from_slice(&[9u8; 32]); // client
        data.extend_from_slice(&[7u8; 32]); // seed
        data.extend_from_slice(&randomness);
        data
    }

    /// Seed and request account of a real fulfilled ORAO request on devnet
    /// (tx 3nweeTqJrtoYQzZbVA751E4h9fKwyxMWSfSA8tjsh9vG4c3tUnmDStQ8XQgZLrmNEQEgWXeWUGukm3Xx4rqJaLV5,
    /// 2026-09-05). If this derivation drifts from ORAO's, the settle path
    /// looks for an account ORAO never creates.
    const LIVE_SEED: [u8; 32] = [
        0x95, 0x60, 0x99, 0x8e, 0x82, 0xe9, 0x2a, 0xe3, 0xc7, 0x61, 0xd5, 0xae, 0xcb, 0xac, 0x77,
        0x81, 0x0e, 0x04, 0xe5, 0x2b, 0x1e, 0x2b, 0x77, 0xd9, 0xf1, 0x16, 0x9f, 0xbe, 0x01, 0x34,
        0x4b, 0xe0,
    ];
    const LIVE_REQUEST: Pubkey = pubkey!("Dw16ayvEdpKNqbDSuweZ31NLGPzVhD2yX7z4qVDr8nTi");
    const LIVE_NETWORK_STATE: Pubkey = pubkey!("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

    #[test]
    fn request_address_matches_a_live_orao_request() {
        assert_eq!(orao_request_address(&LIVE_SEED), LIVE_REQUEST);
        assert_ne!(orao_request_address(&[2u8; 32]), LIVE_REQUEST);
        assert_eq!(
            Pubkey::find_program_address(&[ORAO_NETWORK_STATE_SEED], &ORAO_VRF_PROGRAM_ID).0,
            LIVE_NETWORK_STATE
        );
    }

    #[test]
    fn request_v2_instruction_matches_orao_wire_format() {
        let payer = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        let ix = request_v2_instruction(&payer, &LIVE_NETWORK_STATE, &treasury, &LIVE_REQUEST, &LIVE_SEED);

        assert_eq!(ix.program_id, ORAO_VRF_PROGRAM_ID);
        assert_eq!(ix.data.len(), 40);
        assert_eq!(&ix.data[..8], &REQUEST_V2_DISCRIMINATOR);
        assert_eq!(&ix.data[8..], &LIVE_SEED);

        let keys: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert_eq!(
            keys,
            vec![payer, LIVE_NETWORK_STATE, treasury, LIVE_REQUEST, anchor_lang::system_program::ID]
        );
        let writable: Vec<bool> = ix.accounts.iter().map(|m| m.is_writable).collect();
        assert_eq!(writable, vec![true, true, true, true, false]);
        let signer: Vec<bool> = ix.accounts.iter().map(|m| m.is_signer).collect();
        assert_eq!(signer, vec![true, false, false, false, false]);
    }

    #[test]
    fn parses_fulfilled_and_rejects_pending_or_foreign_accounts() {
        let data = fulfilled_account([4u8; 64]);
        assert_eq!(parse_fulfilled(&data).expect("fulfilled"), [4u8; 64]);

        let mut pending = data.clone();
        pending[8] = 0;
        assert!(parse_fulfilled(&pending)
            .unwrap_err()
            .to_string()
            .contains("not yet fulfilled"));

        let mut foreign = data.clone();
        foreign[0] ^= 0xff;
        assert!(parse_fulfilled(&foreign).is_err());

        assert!(parse_fulfilled(&data[..data.len() - 1]).is_err());
    }

    #[test]
    fn unbiased_mapping_survives_a_tail_sample() {
        // A range just over half the sample space rejects about half of all
        // samples, so some randomness is a guaranteed tail on the first
        // sample. The naive mapping would revert forever, and a fulfilled VRF
        // account has no retry path.
        let big_u64 = (1u64 << 63) + 1;
        let big_u128 = (1u128 << 127) + 1;
        let tail_u64 = (0u64..)
            .map(|n| randomness_with(n))
            .find(|r| sample_u64(&digest(r)) >= big_u64)
            .expect("a tail within a few tries");
        let tail_u128 = (0u64..)
            .map(|n| randomness_with(n))
            .find(|r| sample_u128(&digest(r)) >= big_u128)
            .expect("a tail within a few tries");

        assert!(unbiased_u64(&tail_u64, big_u64).expect("terminates") < big_u64);
        assert!(unbiased_u128(&tail_u128, big_u128).expect("terminates") < big_u128);
        assert!(unbiased_u64(&tail_u64, 0).is_err());
        assert!(unbiased_u128(&tail_u128, 0).is_err());
    }

    /// 64 bytes that differ per `n`, with nothing in common with `digest`.
    fn randomness_with(n: u64) -> [u8; 64] {
        let mut r = [0u8; 64];
        r[..8].copy_from_slice(&n.to_le_bytes());
        r
    }

    #[test]
    fn every_one_of_the_64_bytes_moves_the_outcome() {
        // Hashing all 64 bytes is the point of ADR 0019: a byte the program
        // ignored would be a byte nobody could audit.
        let base = [9u8; 64];
        for i in 0..64 {
            let mut other = base;
            other[i] ^= 1;
            assert_ne!(digest(&base), digest(&other), "byte {i} is ignored");
        }
    }

    #[test]
    fn the_tile_comes_from_the_digest_not_the_leading_bytes() {
        // Two randomness values with the same leading 16 bytes pick tiles
        // from different digests, so the old "leading u64 is the tile" trick
        // no longer steers a round.
        let (mut a, mut b) = ([5u8; 64], [5u8; 64]);
        a[63] = 1;
        b[63] = 2;
        assert_ne!(digest(&a), digest(&b));
        assert_eq!(unbiased_u64(&a, 36).unwrap(), sample_u64(&digest(&a)) % 36);
    }

    #[test]
    fn tile_selection_is_deterministic_for_the_same_randomness() {
        let r = [42u8; 64];
        assert_eq!(unbiased_u64(&r, 36).unwrap(), unbiased_u64(&r, 36).unwrap());
    }
}
