//! Test fixtures written by `tests/make-fixtures.mjs`, one `.txt` per
//! transaction in the shape the mapping receives.
use base64::Engine;
use solami_index_sdk::{Transaction, TxInstruction};

/// The program id the fixtures carry (the IDL's devnet address).
pub const FIXTURE_PROGRAM: &str = "H2iWyng2orJpHNGGWhrR7rBQNDqixThpTpAwF4dnPXax";
/// sha256("pool") and sha256("alice") as keys, from make-fixtures.mjs.
pub const POOL: &str = "3gLESRnfLgzAqu6PwGhBwsiBsnQ7BAtyWHhZ5zNcDPMF";
pub const ALICE: &str = "3x9az88Dkbxa6tkKByxqEn7jBTJCJCD4dVvou49L24ET";

fn b58(s: &str) -> Vec<u8> {
    bs58::decode(s).into_vec().unwrap()
}

/// The fixture whose file name starts with `<name>-`.
pub fn fixture(name: &str) -> Transaction {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let path = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(&format!("{name}-"))
        })
        .unwrap_or_else(|| panic!("no fixture {name}"));
    let mut tx = Transaction::default();
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let (kind, rest) = line.split_once(' ').unwrap();
        match kind {
            "signature" => tx.signature = b58(rest),
            "slot" => tx.slot = rest.parse().unwrap(),
            "log" => tx.logs.push(rest.to_string()),
            "ix" => {
                let mut parts = rest.split(' ');
                let program_id = b58(parts.next().unwrap());
                let data = base64::engine::general_purpose::STANDARD
                    .decode(parts.next().unwrap())
                    .unwrap();
                let accounts = parts
                    .next()
                    .unwrap_or("")
                    .split(',')
                    .filter(|a| !a.is_empty())
                    .map(b58)
                    .collect();
                tx.instructions.push(TxInstruction {
                    program_id,
                    accounts,
                    data,
                });
            }
            _ => panic!("unknown fixture line {line}"),
        }
    }
    tx
}
