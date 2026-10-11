//! The `hexo` subgraph: a Solami Index mapping over HexVault transactions.
// The host build exists only for `cargo test`; `run` is exported on wasm32 alone.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod decode;
#[cfg(test)]
mod fixtures;
#[rustfmt::skip]
mod generated;
mod stats;

use solami_index_sdk::prelude::*;

use decode::{DecodedEvent, FieldValue};

/// Fails the wasm build when unset, so the mapping never reads another
/// program's instructions; `scripts/subgraph.sh build` sets it.
#[cfg(target_arch = "wasm32")]
const PROGRAM_ID: &str = env!("SUBGRAPH_PROGRAM_ID");

#[cfg(target_arch = "wasm32")]
fn map(tx: Transaction) {
    index(PROGRAM_ID, &tx);
}

main!(map);

/// Pool pubkeys the transaction's top-level HexVault instructions name, in
/// order, each once.
fn touched_pools(program: &[u8], tx: &Transaction) -> Vec<String> {
    let mut pools = Vec::new();
    for ix in tx.instructions() {
        if ix.program_id != program {
            continue;
        }
        let disc = ix.discriminator();
        let Some(&(_, at)) = generated::POOL_ACCOUNT.iter().find(|(d, _)| *d == disc) else {
            continue;
        };
        let Some(key) = ix.accounts.get(at) else {
            continue;
        };
        let pool = bs58::encode(key).into_string();
        if !pools.contains(&pool) {
            pools.push(pool);
        }
    }
    pools
}

/// The event's primary USDC amount, if it has one.
fn amount_of(ev: &DecodedEvent) -> Option<u128> {
    let field = match ev.name {
        "Deposited" | "Withdrawn" | "WithdrawRequested" | "WithdrawCancelled" | "JackpotFunded"
        | "JackpotPaid" | "VenueDeployed" | "VenueRecalled" | "DeficitCovered" => "amount",
        "TicketsBought" => "usdc",
        "EmergencyWithdrawn" => "total",
        "Synced" | "Harvested" => "gain",
        "VenueDrained" => "received",
        "EpochRolledOver" => "jackpot_amount",
        _ => return None,
    };
    ev.uint(field)
}

/// Every field as a JSON object, numbers as strings. Names are IDL snake_case
/// and values base58 or digits, so nothing needs escaping.
fn fields_json(ev: &DecodedEvent) -> String {
    let parts: Vec<String> = ev
        .fields
        .iter()
        .map(|(name, v)| match v {
            FieldValue::Pubkey(s) => format!("\"{name}\":\"{s}\""),
            FieldValue::Uint(n) => format!("\"{name}\":\"{n}\""),
            FieldValue::Int(n) => format!("\"{name}\":\"{n}\""),
            FieldValue::Bool(b) => format!("\"{name}\":{b}"),
        })
        .collect();
    format!("{{{}}}", parts.join(","))
}

fn strings(items: &[String]) -> Value {
    Value::List(items.iter().cloned().map(Value::String).collect())
}

pub fn index(program_id: &str, tx: &Transaction) {
    let program = bs58::decode(program_id).into_vec().unwrap_or_default();
    let sig = tx.signature_b58();
    let logs = tx.logs();
    let pools = touched_pools(&program, tx);
    let truncated = decode::is_truncated(logs);
    // A failed transaction committed nothing, so it carries no events.
    let failed = decode::failed_for(program_id, logs);
    let events = if truncated || failed {
        Vec::new()
    } else {
        // The raw logs are still stored, and the backend decodes them itself.
        decode::decode_events(logs).unwrap_or_else(|err| {
            log!("{sig}: {err}");
            Vec::new()
        })
    };

    let mut t = Entity::new("ProgramTransaction", Id::from(sig.as_str()));
    t.set_bigint("slot", BigInt::from(tx.slot));
    t.set_value("pools", strings(&pools));
    t.set_value("logs", strings(logs));
    t.set_i32("event_count", events.len() as i32);
    t.set_bool("truncated", truncated);
    t.set_bool("failed", failed);
    Store::save(t);

    for (i, ev) in events.iter().enumerate() {
        // shortcut: an event with no pool field in a transaction that touches two pools is filed
        // under the first pool, upgrade if a multi-pool mainnet ever exists.
        let pool = ev
            .pubkey("pool")
            .map(str::to_string)
            .or_else(|| pools.first().cloned());
        let mut e = Entity::new("Event", Id::from(format!("{sig}-{i}").as_str()));
        e.set_id("tx", Id::from(sig.as_str()));
        e.set_string("name", ev.name.to_string());
        e.set_bigint("slot", BigInt::from(tx.slot));
        if let Some(p) = &pool {
            e.set_string("pool", p.clone());
        }
        if let Some(owner) = stats::owner_of(ev) {
            e.set_string("owner", owner.to_string());
        }
        if let Some(epoch) = ev.uint("epoch_id") {
            e.set_bigint("epoch_id", stats::big(epoch));
        }
        if let Some(amount) = amount_of(ev) {
            e.set_bigint("amount", stats::big(amount));
        }
        e.set_string("fields", fields_json(ev));
        Store::save(e);

        if let Some(p) = &pool {
            stats::apply_pool(ev, p, tx.slot);
            stats::apply_epoch(ev, p, tx.slot);
        }
    }
    if !failed {
        stats::apply_tx(&events, tx.slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{fixture, ALICE, FIXTURE_PROGRAM, POOL};

    fn run(names: &[&str]) {
        Store::clear();
        for name in names {
            index(FIXTURE_PROGRAM, &fixture(name));
        }
    }

    fn load(kind: &str, id: &str) -> Entity {
        Store::load(kind, Id::from(id)).unwrap_or_else(|| panic!("no {kind} {id}"))
    }

    fn big(e: &Entity, f: &str) -> i128 {
        e.get_bigint(f).unwrap_or_else(|| panic!("no {f}")).0
    }

    fn sig(name: &str) -> String {
        fixture(name).signature_b58()
    }

    #[test]
    fn a_deposit_writes_every_entity() {
        run(&["create_pool", "deposit"]);
        let s = sig("deposit");
        let t = load("ProgramTransaction", &s);
        assert_eq!(
            t.get_value("pools"),
            Some(&Value::List(vec![Value::String(POOL.into())]))
        );
        assert_eq!(t.get_i32("event_count"), Some(1));
        assert_eq!(t.get_bool("failed"), Some(false));
        let Some(Value::List(logs)) = t.get_value("logs") else {
            panic!("no logs")
        };
        assert_eq!(logs.len(), 11);

        let e = load("Event", &format!("{s}-0"));
        assert_eq!(e.get_string("name").as_deref(), Some("Deposited"));
        assert_eq!(e.get_string("pool").as_deref(), Some(POOL));
        assert_eq!(e.get_string("owner").as_deref(), Some(ALICE));
        assert_eq!(big(&e, "amount"), 250_000_000);
        assert_eq!(
            e.get_string("fields").as_deref(),
            Some(&*format!(
                "{{\"owner\":\"{ALICE}\",\"amount\":\"250000000\",\"principal\":\"250000000\",\"yield_index\":\"1000000000000000000\"}}"
            ))
        );

        assert_eq!(big(&load("Pool", POOL), "deposited"), 250_000_000);
        let w = load("Wallet", ALICE);
        assert_eq!(big(&w, "deposited"), 250_000_000);
        assert_eq!(w.get_i32("tx_count"), Some(1));
        let bucket = (509_570_000u64 / stats::BUCKET_SLOTS).to_string();
        let b = load("SlotBucket", &bucket);
        assert_eq!(big(&b, "deposits"), 250_000_000);
        assert_eq!(
            big(&b, "start_slot"),
            (509_570_000 / 216_000 * 216_000) as i128
        );
        load("BucketWallet", &format!("{bucket}-{ALICE}"));
    }

    #[test]
    fn running_totals_over_a_pool_life() {
        run(&[
            "create_pool",
            "begin_epoch",
            "deposit",
            "deposit_again",
            "buy_tickets",
            "harvest",
            "draw",
            "payout",
        ]);
        let p = load("Pool", POOL);
        assert_eq!(big(&p, "pool_id"), 1);
        assert_eq!(big(&p, "deposited"), 300_000_000);
        assert_eq!(big(&p, "tickets_usdc"), 5_000_000);
        // Harvested repeats the Synced gain; counting both would double it.
        assert_eq!(big(&p, "yield_gain"), 1_234_567);
        assert_eq!(big(&p, "yield_fee"), 123_456);
        assert_eq!(big(&p, "jackpot_paid"), 42_000_000);
        assert_eq!(p.get_i32("epochs_drawn"), Some(1));
        assert_eq!(big(&p, "last_slot"), 509_760_200);

        let e = load("Epoch", &format!("{POOL}-1"));
        assert_eq!(big(&e, "tickets_usdc"), 5_000_000);
        assert_eq!(big(&e, "total_tickets"), 5_000_000);
        assert_eq!(e.get_string("winner").as_deref(), Some(ALICE));
        assert_eq!(big(&e, "jackpot_amount"), 42_000_000);
        assert_eq!(e.get_bool("is_house"), Some(false));
        assert_eq!(big(&e, "paid_slot"), 509_760_200);

        let w = load("Wallet", ALICE);
        assert_eq!(big(&w, "deposited"), 300_000_000);
        assert_eq!(big(&w, "jackpot_won"), 42_000_000);
        assert_eq!(w.get_i32("tx_count"), Some(4));
        assert_eq!(big(&w, "first_slot"), 509_570_000);
        assert_eq!(big(&w, "last_slot"), 509_760_200);

        // The payout lands in the next bucket.
        let first = load(
            "SlotBucket",
            &(509_570_000u64 / stats::BUCKET_SLOTS).to_string(),
        );
        assert_eq!(big(&first, "yield_gain"), 1_234_567);
        assert_eq!(first.get_i32("tx_count"), Some(6));
        let next = load(
            "SlotBucket",
            &(509_760_200u64 / stats::BUCKET_SLOTS).to_string(),
        );
        assert_eq!(big(&next, "jackpot_paid"), 42_000_000);
        assert_eq!(next.get_i32("unique_wallets"), Some(1));
    }

    #[test]
    fn same_wallet_same_bucket_counts_once() {
        run(&["deposit", "deposit_again"]);
        let b = load(
            "SlotBucket",
            &(509_570_000u64 / stats::BUCKET_SLOTS).to_string(),
        );
        assert_eq!(b.get_i32("unique_wallets"), Some(1));
        assert_eq!(b.get_i32("tx_count"), Some(2));
        assert_eq!(big(&b, "deposits"), 300_000_000);
    }

    #[test]
    fn events_without_a_pool_field_take_the_instruction_pool() {
        run(&["draw"]);
        let e = load("Event", &format!("{}-0", sig("draw")));
        assert_eq!(e.get_string("pool").as_deref(), Some(POOL));
        assert_eq!(big(&e, "epoch_id"), 1);
    }

    #[test]
    fn aggregates_wait_for_their_creating_event() {
        run(&["deposit", "draw"]);
        assert!(Store::load("Pool", Id::from(POOL)).is_none());
        assert!(Store::load("Epoch", Id::from(format!("{POOL}-1"))).is_none());
        assert!(Store::load("Wallet", Id::from(ALICE)).is_some());
    }

    #[test]
    fn failed_and_truncated_transactions_store_logs_and_no_events() {
        let mut failed = fixture("deposit");
        failed.logs.push(format!(
            "Program {FIXTURE_PROGRAM} failed: custom program error: 0x1770"
        ));
        let mut truncated = fixture("buy_tickets");
        truncated.logs.push("Log truncated".to_string());
        Store::clear();
        index(FIXTURE_PROGRAM, &failed);
        index(FIXTURE_PROGRAM, &truncated);

        let f = load("ProgramTransaction", &failed.signature_b58());
        assert_eq!(
            (f.get_bool("failed"), f.get_i32("event_count")),
            (Some(true), Some(0))
        );
        let t = load("ProgramTransaction", &truncated.signature_b58());
        assert_eq!(
            (t.get_bool("truncated"), t.get_i32("event_count")),
            (Some(true), Some(0))
        );
        assert!(Store::load("Event", Id::from(format!("{}-0", failed.signature_b58()))).is_none());
        assert!(Store::load("Wallet", Id::from(ALICE)).is_none());
    }

    #[test]
    fn another_programs_instructions_name_no_pool() {
        Store::clear();
        index("11111111111111111111111111111111", &fixture("draw"));
        let t = load("ProgramTransaction", &sig("draw"));
        assert_eq!(t.get_value("pools"), Some(&Value::List(vec![])));
    }
}
