//! HexVault event decoding from a transaction's log lines. Pure Rust, no SDK
//! host calls, so it tests on the host target. The backend's `decodeEventLogs`
//! stays the Read model's decoder; this one feeds the subgraph's own entities.
use base64::Engine;

use crate::generated::EVENTS;

/// Borsh wire type of an event field. `PauseFeature` is `U8`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ty {
    Pubkey,
    U8,
    U16,
    U32,
    U64,
    U128,
    I64,
    Bool,
}

pub struct EventDef {
    pub name: &'static str,
    pub disc: [u8; 8],
    pub fields: &'static [(&'static str, Ty)],
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldValue {
    /// Base58.
    Pubkey(String),
    Uint(u128),
    Int(i64),
    Bool(bool),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedEvent {
    pub name: &'static str,
    pub fields: Vec<(&'static str, FieldValue)>,
}

impl DecodedEvent {
    pub fn get(&self, name: &str) -> Option<&FieldValue> {
        self.fields.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
    }

    pub fn pubkey(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(FieldValue::Pubkey(s)) => Some(s),
            _ => None,
        }
    }

    pub fn uint(&self, name: &str) -> Option<u128> {
        match self.get(name) {
            Some(FieldValue::Uint(v)) => Some(*v),
            _ => None,
        }
    }

    pub fn int(&self, name: &str) -> Option<i64> {
        match self.get(name) {
            Some(FieldValue::Int(v)) => Some(*v),
            _ => None,
        }
    }

    pub fn bool(&self, name: &str) -> Option<bool> {
        match self.get(name) {
            Some(FieldValue::Bool(v)) => Some(*v),
            _ => None,
        }
    }
}

const DATA_PREFIX: &str = "Program data: ";

/// Every HexVault event in the logs, in log order. Lines whose first 8 bytes
/// match no event (other programs' CPIs) are skipped. A line that matches a
/// discriminator but does not fit its layout is an error: the IDL the wasm was
/// generated from is older than the program. Trailing bytes are allowed,
/// because upgrades only append fields (ADR 0013).
pub fn decode_events(logs: &[String]) -> Result<Vec<DecodedEvent>, String> {
    let mut out = Vec::new();
    for line in logs {
        let Some(b64) = line.strip_prefix(DATA_PREFIX) else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else {
            continue;
        };
        if bytes.len() < 8 {
            continue;
        }
        let Some(def) = EVENTS.iter().find(|e| e.disc == bytes[..8]) else {
            continue;
        };
        let event = read_event(def, &bytes[8..])
            .ok_or_else(|| format!("{} does not fit its IDL layout: {line}", def.name))?;
        out.push(event);
    }
    Ok(out)
}

fn read_event(def: &EventDef, mut b: &[u8]) -> Option<DecodedEvent> {
    let mut fields = Vec::with_capacity(def.fields.len());
    for &(name, ty) in def.fields {
        let size = match ty {
            Ty::Pubkey => 32,
            Ty::U8 | Ty::Bool => 1,
            Ty::U16 => 2,
            Ty::U32 => 4,
            Ty::U64 | Ty::I64 => 8,
            Ty::U128 => 16,
        };
        if b.len() < size {
            return None;
        }
        let (head, rest) = b.split_at(size);
        b = rest;
        let value = match ty {
            Ty::Pubkey => FieldValue::Pubkey(bs58::encode(head).into_string()),
            Ty::Bool => FieldValue::Bool(head[0] != 0),
            Ty::I64 => FieldValue::Int(i64::from_le_bytes(head.try_into().ok()?)),
            _ => {
                let mut le = [0u8; 16];
                le[..size].copy_from_slice(head);
                FieldValue::Uint(u128::from_le_bytes(le))
            }
        };
        fields.push((name, value));
    }
    Some(DecodedEvent {
        name: def.name,
        fields,
    })
}

/// The runtime cut the logs short, so some events may be missing.
pub fn is_truncated(logs: &[String]) -> bool {
    logs.iter().any(|l| l.contains("Log truncated"))
}

/// `program_id` (base58) failed, so the transaction committed nothing.
pub fn failed_for(program_id: &str, logs: &[String]) -> bool {
    let prefix = format!("Program {program_id} failed");
    logs.iter().any(|l| l.starts_with(&prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{fixture, ALICE, FIXTURE_PROGRAM, POOL};

    fn decoded(name: &str) -> Vec<DecodedEvent> {
        decode_events(fixture(name).logs()).unwrap()
    }

    fn names(events: &[DecodedEvent]) -> Vec<&'static str> {
        events.iter().map(|e| e.name).collect()
    }

    #[test]
    fn every_idl_event_is_generated() {
        assert_eq!(EVENTS.len(), 35);
    }

    #[test]
    fn deposit_fixture() {
        let ev = decoded("deposit");
        assert_eq!(names(&ev), ["Deposited"]);
        assert_eq!(ev[0].pubkey("owner"), Some(ALICE));
        assert_eq!(ev[0].uint("amount"), Some(250_000_000));
        assert_eq!(ev[0].uint("yield_index"), Some(1_000_000_000_000_000_000));
    }

    #[test]
    fn buy_tickets_fixture() {
        let ev = decoded("buy_tickets");
        assert_eq!(names(&ev), ["TicketsBought"]);
        assert_eq!(ev[0].uint("epoch_id"), Some(1));
        assert_eq!(ev[0].uint("usdc"), Some(5_000_000));
    }

    #[test]
    fn draw_fixture() {
        let ev = decoded("draw");
        assert_eq!(names(&ev), ["EpochDrawn"]);
        assert_eq!(ev[0].uint("epoch_id"), Some(1));
        assert_eq!(ev[0].uint("total_tickets"), Some(5_000_000));
    }

    #[test]
    fn payout_fixture() {
        let ev = decoded("payout");
        assert_eq!(names(&ev), ["JackpotPaid"]);
        assert_eq!(ev[0].pubkey("winner"), Some(ALICE));
        assert_eq!(ev[0].uint("amount"), Some(42_000_000));
        assert_eq!(ev[0].bool("is_house"), Some(false));
        assert_eq!(ev[0].uint("tickets"), Some(5_000_000));
    }

    #[test]
    fn harvest_fixture_skips_the_kamino_line() {
        let ev = decoded("harvest");
        assert_eq!(names(&ev), ["Synced", "Harvested"]);
        assert_eq!(ev[0].pubkey("pool"), Some(POOL));
        assert_eq!(ev[0].uint("gain"), Some(1_234_567));
    }

    #[test]
    fn begin_epoch_fixture_reads_i64() {
        assert_eq!(
            decoded("begin_epoch")[0].int("starts_at"),
            Some(1_791_590_400)
        );
    }

    #[test]
    fn cpi_data_line_decodes_to_nothing() {
        // A token-program style payload: 8 bytes that match no HexVault event.
        let logs = vec!["Program data: AQIDBAUGBwgJCgsMDQ4PEA==".to_string()];
        assert!(decode_events(&logs).unwrap().is_empty());
    }

    #[test]
    fn short_payload_for_a_known_event_is_an_error() {
        let def = EVENTS.iter().find(|e| e.name == "Deposited").unwrap();
        let mut bytes = def.disc.to_vec();
        bytes.extend_from_slice(&[0u8; 10]);
        let line = format!(
            "Program data: {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        assert!(decode_events(&[line]).unwrap_err().contains("Deposited"));
    }

    #[test]
    fn truncated_and_failed_markers() {
        let logs = vec!["Program log: x".to_string(), "Log truncated".to_string()];
        assert!(is_truncated(&logs));
        assert!(!is_truncated(&logs[..1]));
        let failed = vec![format!(
            "Program {FIXTURE_PROGRAM} failed: custom program error: 0x1770"
        )];
        assert!(failed_for(FIXTURE_PROGRAM, &failed));
        assert!(!failed_for("11111111111111111111111111111111", &failed));
    }
}
