use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Randomness seed of an epoch draw:
/// `sha256("epoch" || pool || epoch_id_le || nonce || root || total_tickets_le)`.
/// The nonce is a 32-byte value the Operator supplies fresh on every request,
/// so nobody can derive the randomness account before the request lands
/// (beta-launch-fixes ticket 02). The snapshot's root and total are in it, so
/// no other snapshot can be swapped in once the randomness is requested
/// (off-chain-tickets ticket 09, ADR 0025).
pub fn epoch_seed(
    pool: &Pubkey,
    epoch_id: u64,
    nonce: &[u8; 32],
    root: &[u8; 32],
    total_tickets: u64,
) -> [u8; 32] {
    hashv(&[
        b"epoch",
        pool.as_ref(),
        &epoch_id.to_le_bytes(),
        nonce,
        root,
        &total_tickets.to_le_bytes(),
    ])
    .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seed_binds_every_input() {
        let pool = Pubkey::new_unique();
        let (nonce, root) = ([1u8; 32], [2u8; 32]);
        let base = epoch_seed(&pool, 7, &nonce, &root, 9);
        assert_eq!(base, epoch_seed(&pool, 7, &nonce, &root, 9), "deterministic");
        assert_ne!(base, epoch_seed(&Pubkey::new_unique(), 7, &nonce, &root, 9));
        assert_ne!(base, epoch_seed(&pool, 8, &nonce, &root, 9));
        assert_ne!(base, epoch_seed(&pool, 7, &[3u8; 32], &root, 9));
        assert_ne!(base, epoch_seed(&pool, 7, &nonce, &[3u8; 32], 9));
        assert_ne!(base, epoch_seed(&pool, 7, &nonce, &root, 10));
    }
}
