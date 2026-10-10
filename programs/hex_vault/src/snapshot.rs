//! The proof check behind `payout` (off-chain-tickets ticket 09, ADR 0025).
//!
//! The backend builds the Epoch snapshot as a Merkle sum tree and the Operator
//! commits its root, total, depth and leaf count in `request_draw`. This
//! module walks one leaf's proof up to that root. The builder is
//! `apps/backend/src/snapshot/sum-tree.ts`, and
//! `tests/fixtures/sum-tree-vectors.json` pins both sides to the same bytes.
//!
//! ```text
//! leaf = sha256(0x00 || wallet[32] || tickets u64le)       sum = tickets
//! node = sha256(0x01 || L.hash || L.sum u64le || R.hash || R.sum u64le)
//! ```

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::errors::HexVaultError;

/// One proof step: the sibling subtree's hash and Ticket sum.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SumNode {
    pub hash: [u8; 32],
    pub sum: u64,
}

/// What `request_draw` froze on the Epoch.
#[derive(Clone)]
pub struct Commitment {
    pub root: [u8; 32],
    pub total_tickets: u64,
    pub depth: u8,
    pub leaf_count: u32,
}

fn node(left: &SumNode, right: &SumNode) -> [u8; 32] {
    hashv(&[
        &[0x01],
        &left.hash,
        &left.sum.to_le_bytes(),
        &right.hash,
        &right.sum.to_le_bytes(),
    ])
    .to_bytes()
}

/// Shape checks `request_draw` runs on a snapshot it is about to commit.
pub fn check_commitment(c: &Commitment, max_depth: u8) -> std::result::Result<(), HexVaultError> {
    if c.depth > max_depth {
        return Err(HexVaultError::SnapshotDepthTooLarge);
    }
    if c.leaf_count == 0 || u64::from(c.leaf_count) > 1u64 << c.depth {
        return Err(HexVaultError::SnapshotLeafCountInvalid);
    }
    if c.root == [0u8; 32] {
        return Err(HexVaultError::SnapshotRootZero);
    }
    Ok(())
}

/// Research 01's algorithm: `Ok` only when the proof for `owner`'s leaf at
/// `index` reaches the committed root and total, and `target` falls in the
/// leaf's range `[prefix, prefix + tickets)`.
pub fn verify(
    c: &Commitment,
    target: u64,
    index: u32,
    owner: &Pubkey,
    tickets: u64,
    siblings: &[SumNode],
) -> std::result::Result<(), HexVaultError> {
    use HexVaultError::*;
    if tickets == 0 {
        return Err(ZeroTicketLeaf);
    }
    if siblings.len() != usize::from(c.depth) {
        return Err(ProofWrongLength);
    }
    // The walk alone would accept an index that differs from a real leaf's
    // only above bit `depth`, or one that points into the padding.
    if index >= c.leaf_count {
        return Err(ProofIndexOutOfRange);
    }

    let mut cur = SumNode {
        hash: hashv(&[&[0x00], owner.as_ref(), &tickets.to_le_bytes()]).to_bytes(),
        sum: tickets,
    };
    let mut prefix: u64 = 0;
    for (level, sib) in siblings.iter().enumerate() {
        if (index >> level) & 1 == 1 {
            prefix = prefix.checked_add(sib.sum).ok_or(ArithmeticOverflow)?;
            cur = SumNode {
                hash: node(sib, &cur),
                sum: sib.sum.checked_add(cur.sum).ok_or(ArithmeticOverflow)?,
            };
        } else {
            cur = SumNode {
                hash: node(&cur, sib),
                sum: cur.sum.checked_add(sib.sum).ok_or(ArithmeticOverflow)?,
            };
        }
    }

    if cur.hash != c.root {
        return Err(ProofRootMismatch);
    }
    if cur.sum != c.total_tickets {
        return Err(ProofSumMismatch);
    }
    let end = prefix.checked_add(tickets).ok_or(ArithmeticOverflow)?;
    if target < prefix || target >= end {
        return Err(ProofRangeMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../tests/fixtures/sum-tree-vectors.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn bytes32(v: &Value) -> [u8; 32] {
        unhex(v.as_str().expect("hex string"))
            .try_into()
            .expect("32 bytes")
    }

    fn u64_of(v: &Value) -> u64 {
        v.as_str().expect("decimal string").parse().expect("u64")
    }

    fn cases() -> Vec<Value> {
        let all: Value = serde_json::from_str(VECTORS).expect("vectors parse");
        all["cases"].as_array().expect("cases").clone()
    }

    fn commitment(case: &Value) -> Commitment {
        Commitment {
            root: bytes32(&case["root"]),
            total_tickets: u64_of(&case["total"]),
            depth: case["depth"].as_u64().expect("depth") as u8,
            leaf_count: case["leafCount"].as_u64().expect("leafCount") as u32,
        }
    }

    fn siblings(proof: &Value) -> Vec<SumNode> {
        proof["siblings"]
            .as_array()
            .expect("siblings")
            .iter()
            .map(|s| SumNode {
                hash: bytes32(&s["hash"]),
                sum: u64_of(&s["sum"]),
            })
            .collect()
    }

    /// Every proof in every case reaches its root, and every listed target
    /// falls in its winner's range, for depth 1, 4 and 18.
    #[test]
    fn the_shared_vectors_verify() {
        let mut depths = vec![];
        for case in cases() {
            let c = commitment(&case);
            depths.push(c.depth);
            check_commitment(&c, 18).expect("commitment shape");
            for proof in case["proofs"].as_array().expect("proofs") {
                let owner = Pubkey::new_from_array(bytes32(&proof["wallet"]));
                let index = proof["index"].as_u64().expect("index") as u32;
                let tickets = u64_of(&proof["tickets"]);
                let sibs = siblings(proof);
                // A target inside this leaf's range, from the case's targets.
                let mine: Vec<&Value> = case["targets"]
                    .as_array()
                    .expect("targets")
                    .iter()
                    .filter(|t| t["winnerIndex"].as_u64() == Some(u64::from(index)))
                    .collect();
                for t in &mine {
                    verify(&c, u64_of(&t["target"]), index, &owner, tickets, &sibs)
                        .unwrap_or_else(|e| panic!("{}: index {index}: {e:?}", case["name"]));
                }
                assert!(!mine.is_empty(), "no target for a proof");
            }
        }
        assert!(depths.contains(&1) && depths.contains(&4) && depths.contains(&18));
    }

    /// The first proof of the first case with at least one sibling, plus a
    /// target that falls in its range.
    fn sample() -> (Commitment, u64, u32, Pubkey, u64, Vec<SumNode>) {
        let case = cases()
            .into_iter()
            .find(|c| c["depth"] == 4)
            .expect("depth 4 case");
        let c = commitment(&case);
        let target = case["targets"][0].clone();
        let index = target["winnerIndex"].as_u64().expect("winnerIndex") as u32;
        let proof = case["proofs"]
            .as_array()
            .expect("proofs")
            .iter()
            .find(|p| p["index"].as_u64() == Some(u64::from(index)))
            .expect("proof for the target's winner")
            .clone();
        let owner = Pubkey::new_from_array(bytes32(&proof["wallet"]));
        (
            c,
            u64_of(&target["target"]),
            index,
            owner,
            u64_of(&proof["tickets"]),
            siblings(&proof),
        )
    }

    #[test]
    fn a_wrong_length_proof_is_refused() {
        let (c, target, index, owner, tickets, mut sibs) = sample();
        sibs.pop();
        assert!(matches!(
            verify(&c, target, index, &owner, tickets, &sibs),
            Err(HexVaultError::ProofWrongLength)
        ));
        let (_, _, _, _, _, mut sibs) = sample();
        sibs.push(sibs[0].clone());
        assert!(matches!(
            verify(&c, target, index, &owner, tickets, &sibs),
            Err(HexVaultError::ProofWrongLength)
        ));
    }

    #[test]
    fn a_tampered_sibling_leaf_or_index_misses_the_root() {
        let (c, target, index, owner, tickets, sibs) = sample();
        let mut bad = sibs.clone();
        bad[1].hash[0] ^= 1;
        assert!(matches!(
            verify(&c, target, index, &owner, tickets, &bad),
            Err(HexVaultError::ProofRootMismatch)
        ));
        // A sibling's sum is hashed in, so changing it breaks the root first.
        let mut bad = sibs.clone();
        bad[0].sum += 1;
        assert!(matches!(
            verify(&c, target, index, &owner, tickets, &bad),
            Err(HexVaultError::ProofRootMismatch)
        ));
        let other = Pubkey::new_unique();
        assert!(matches!(
            verify(&c, target, index, &other, tickets, &sibs),
            Err(HexVaultError::ProofRootMismatch)
        ));
        // Another in-range index flips a direction bit.
        let flipped = index ^ 1;
        assert!(flipped < c.leaf_count);
        assert!(matches!(
            verify(&c, target, flipped, &owner, tickets, &sibs),
            Err(HexVaultError::ProofRootMismatch)
        ));
    }

    #[test]
    fn an_index_past_the_leaf_count_is_refused_even_as_an_alias() {
        let (c, target, index, owner, tickets, sibs) = sample();
        // Same low `depth` bits, so the walk alone would take it.
        assert!(matches!(
            verify(&c, target, index + (1 << c.depth), &owner, tickets, &sibs),
            Err(HexVaultError::ProofIndexOutOfRange)
        ));
    }

    #[test]
    fn a_total_that_misses_the_sums_is_refused() {
        let (mut c, target, index, owner, tickets, sibs) = sample();
        c.total_tickets += 1;
        assert!(matches!(
            verify(&c, target, index, &owner, tickets, &sibs),
            Err(HexVaultError::ProofSumMismatch)
        ));
    }

    #[test]
    fn a_target_outside_the_range_is_refused_at_both_edges() {
        let (c, target, index, owner, tickets, sibs) = sample();
        // Locate the range by probing: the leaf holds `tickets` consecutive targets.
        let first = (0..c.total_tickets)
            .find(|t| verify(&c, *t, index, &owner, tickets, &sibs).is_ok())
            .expect("range start");
        assert!(first <= target);
        assert!(verify(&c, first + tickets - 1, index, &owner, tickets, &sibs).is_ok());
        assert!(matches!(
            verify(&c, first + tickets, index, &owner, tickets, &sibs),
            Err(HexVaultError::ProofRangeMismatch)
        ));
        if first > 0 {
            assert!(matches!(
                verify(&c, first - 1, index, &owner, tickets, &sibs),
                Err(HexVaultError::ProofRangeMismatch)
            ));
        }
    }

    #[test]
    fn a_zero_ticket_leaf_never_wins() {
        let (c, target, index, owner, _, sibs) = sample();
        assert!(matches!(
            verify(&c, target, index, &owner, 0, &sibs),
            Err(HexVaultError::ZeroTicketLeaf)
        ));
    }

    #[test]
    fn the_commitment_shape_checks_name_their_errors() {
        let ok = Commitment {
            root: [1; 32],
            total_tickets: 5,
            depth: 18,
            leaf_count: 1 << 18,
        };
        assert!(check_commitment(&ok, 18).is_ok());
        let deep = Commitment {
            depth: 19,
            ..ok.clone()
        };
        assert!(matches!(
            check_commitment(&deep, 18),
            Err(HexVaultError::SnapshotDepthTooLarge)
        ));
        let over = Commitment {
            depth: 4,
            leaf_count: 17,
            ..ok.clone()
        };
        assert!(matches!(
            check_commitment(&over, 18),
            Err(HexVaultError::SnapshotLeafCountInvalid)
        ));
        let none = Commitment {
            leaf_count: 0,
            ..ok.clone()
        };
        assert!(matches!(
            check_commitment(&none, 18),
            Err(HexVaultError::SnapshotLeafCountInvalid)
        ));
        let zero = Commitment {
            root: [0; 32],
            ..ok.clone()
        };
        assert!(matches!(
            check_commitment(&zero, 18),
            Err(HexVaultError::SnapshotRootZero)
        ));
    }
}
