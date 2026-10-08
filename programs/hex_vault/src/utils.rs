use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Randomness seed for one subject. Deterministic in (domain, pool, id,
/// nonce): the nonce is a 32-byte value the Operator supplies fresh on every
/// randomness request, unpredictable ahead of time, so nobody can derive the
/// randomness account this request will use before the request itself lands
/// (beta-launch-fixes ticket 02). The operator can still derive the account
/// off-chain once it has picked its own nonce, without reading the
/// Epoch first.
pub fn vrf_seed(domain: &[u8], pool: &Pubkey, id: u64, nonce: &[u8; 32]) -> [u8; 32] {
    hashv(&[domain, pool.as_ref(), &id.to_le_bytes(), nonce]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_separate_domains_pools_and_ids() {
        let pool = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let nonce = [1u8; 32];
        let base = vrf_seed(b"other", &pool, 7, &nonce);
        assert_eq!(base, vrf_seed(b"other", &pool, 7, &nonce), "deterministic");
        assert_ne!(base, vrf_seed(b"epoch", &pool, 7, &nonce));
        assert_ne!(base, vrf_seed(b"other", &other, 7, &nonce));
        assert_ne!(base, vrf_seed(b"other", &pool, 8, &nonce));
    }

    #[test]
    fn same_nonce_reproduces_the_same_seed_and_a_different_nonce_differs() {
        let pool = Pubkey::new_unique();
        let nonce_a = [1u8; 32];
        let nonce_b = [2u8; 32];
        assert_eq!(
            vrf_seed(b"other", &pool, 7, &nonce_a),
            vrf_seed(b"other", &pool, 7, &nonce_a),
            "same nonce, same seed"
        );
        assert_ne!(
            vrf_seed(b"other", &pool, 7, &nonce_a),
            vrf_seed(b"other", &pool, 7, &nonce_b),
            "different nonce, different seed"
        );
    }
}
