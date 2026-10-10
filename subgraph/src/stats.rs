//! Pool, Epoch, Wallet and SlotBucket updates from decoded events. All sums are
//! `BigInt` (i128), so a pool's lifetime of u64 amounts cannot overflow.
use solami_index_sdk::prelude::*;

use crate::decode::DecodedEvent;

/// About one day of slots.
pub const BUCKET_SLOTS: u64 = 216_000;

pub fn big(v: u128) -> BigInt {
    BigInt(v as i128)
}

fn load_or(kind: &str, id: &str, init: impl FnOnce(&mut Entity)) -> Entity {
    Store::load(kind, Id::from(id)).unwrap_or_else(|| {
        let mut e = Entity::new(kind, Id::from(id));
        init(&mut e);
        e
    })
}

fn add(e: &mut Entity, field: &str, v: u128) {
    let sum = e.get_bigint(field).unwrap_or_default() + big(v);
    e.set_bigint(field, sum);
}

fn bump(e: &mut Entity, field: &str) {
    let n = e.get_i32(field).unwrap_or(0) + 1;
    e.set_i32(field, n);
}

/// The wallet an event names: `owner`, or `winner` on JackpotPaid.
pub fn owner_of(ev: &DecodedEvent) -> Option<&str> {
    ev.pubkey("owner").or_else(|| ev.pubkey("winner"))
}

/// Pool and Epoch exist only from their creating event on. A subgraph started
/// after `PoolCreated` or `EpochBegan` leaves those aggregates unset rather
/// than writing rows with missing required fields.
pub fn apply_pool(ev: &DecodedEvent, pool: &str, slot: u64) {
    if ev.name == "PoolCreated" {
        let mut p = Entity::new("Pool", Id::from(pool));
        p.set_bigint("pool_id", big(ev.uint("pool_id").unwrap_or(0)));
        p.set_string("admin", ev.pubkey("admin").unwrap_or_default().to_string());
        p.set_string(
            "operator",
            ev.pubkey("operator").unwrap_or_default().to_string(),
        );
        p.set_bool("paused", false);
        for f in [
            "deposited",
            "withdrawn",
            "tickets_usdc",
            "jackpot_paid",
            "yield_gain",
            "yield_fee",
            "venue_deployed",
            "venue_recalled",
        ] {
            p.set_bigint(f, BigInt::zero());
        }
        p.set_i32("epochs_drawn", 0);
        p.set_bigint("last_slot", big(slot as u128));
        Store::save(p);
        return;
    }
    let Some(mut p) = Store::load("Pool", Id::from(pool)) else {
        return;
    };
    let u = |f: &str| ev.uint(f).unwrap_or(0);
    match ev.name {
        "OperatorChanged" => p.set_string(
            "operator",
            ev.pubkey("operator").unwrap_or_default().to_string(),
        ),
        "AdminChanged" => p.set_string("admin", ev.pubkey("admin").unwrap_or_default().to_string()),
        "Paused" => p.set_bool("paused", ev.bool("paused").unwrap_or(false)),
        "PoolShutdown" => p.set_bigint("shutdown_at", BigInt(ev.int("at").unwrap_or(0) as i128)),
        "Deposited" => add(&mut p, "deposited", u("amount")),
        "Withdrawn" => add(&mut p, "withdrawn", u("amount")),
        "EmergencyWithdrawn" => add(&mut p, "withdrawn", u("total")),
        "TicketsBought" => add(&mut p, "tickets_usdc", u("usdc")),
        "JackpotPaid" => add(&mut p, "jackpot_paid", u("amount")),
        // Harvested.gain re-reports the Synced gains since the last harvest
        // (sync.rs harvest_gain), so only Synced counts.
        "Synced" => {
            add(&mut p, "yield_gain", u("gain"));
            add(&mut p, "yield_fee", u("fee"));
        }
        "VenueDeployed" => add(&mut p, "venue_deployed", u("amount")),
        "VenueRecalled" => add(&mut p, "venue_recalled", u("amount")),
        "VenueDrained" => add(&mut p, "venue_recalled", u("received")),
        "EpochDrawn" => bump(&mut p, "epochs_drawn"),
        _ => {}
    }
    p.set_bigint("last_slot", big(slot as u128));
    Store::save(p);
}

pub fn apply_epoch(ev: &DecodedEvent, pool: &str, slot: u64) {
    let Some(epoch_id) = ev.uint("epoch_id") else {
        return;
    };
    let id = format!("{pool}-{epoch_id}");
    let slot = big(slot as u128);
    if ev.name == "EpochBegan" {
        let mut e = Entity::new("Epoch", Id::from(id.as_str()));
        e.set_id("pool", Id::from(pool));
        e.set_bigint("epoch_id", big(epoch_id));
        e.set_bigint(
            "starts_at",
            BigInt(ev.int("starts_at").unwrap_or(0) as i128),
        );
        e.set_bigint("ends_at", BigInt(ev.int("ends_at").unwrap_or(0) as i128));
        e.set_bigint("tickets_usdc", BigInt::zero());
        e.set_bool("rolled_over", false);
        e.set_bigint("began_slot", slot);
        Store::save(e);
        return;
    }
    let Some(mut e) = Store::load("Epoch", Id::from(id.as_str())) else {
        return;
    };
    match ev.name {
        "TicketsBought" => add(&mut e, "tickets_usdc", ev.uint("usdc").unwrap_or(0)),
        "EpochDrawn" => {
            e.set_bigint("total_tickets", big(ev.uint("total_tickets").unwrap_or(0)));
            e.set_bigint("target", big(ev.uint("target").unwrap_or(0)));
            e.set_bigint("drawn_slot", slot);
        }
        "JackpotPaid" => {
            e.set_string(
                "winner",
                ev.pubkey("winner").unwrap_or_default().to_string(),
            );
            e.set_bigint("jackpot_amount", big(ev.uint("amount").unwrap_or(0)));
            e.set_bool("is_house", ev.bool("is_house").unwrap_or(false));
            e.set_bigint("paid_slot", slot);
        }
        "EpochRolledOver" => {
            e.set_bool("rolled_over", true);
            e.set_bigint(
                "jackpot_amount",
                big(ev.uint("jackpot_amount").unwrap_or(0)),
            );
        }
        _ => return,
    }
    Store::save(e);
}

/// Money moved by one event, for the Wallet and SlotBucket sums.
struct Flows {
    deposited: u128,
    withdrawn: u128,
    tickets: u128,
    jackpot: u128,
    yield_gain: u128,
}

fn flows(ev: &DecodedEvent) -> Flows {
    let u = |f: &str| ev.uint(f).unwrap_or(0);
    Flows {
        deposited: if ev.name == "Deposited" {
            u("amount")
        } else {
            0
        },
        withdrawn: match ev.name {
            "Withdrawn" => u("amount"),
            "EmergencyWithdrawn" => u("total"),
            _ => 0,
        },
        tickets: if ev.name == "TicketsBought" {
            u("usdc")
        } else {
            0
        },
        jackpot: if ev.name == "JackpotPaid" {
            u("amount")
        } else {
            0
        },
        yield_gain: if ev.name == "Synced" { u("gain") } else { 0 },
    }
}

/// Wallet and SlotBucket updates for one transaction's events. Counts are per
/// transaction: a wallet named twice in one transaction counts once.
pub fn apply_tx(events: &[DecodedEvent], slot: u64) {
    let bucket_id = (slot / BUCKET_SLOTS).to_string();
    let mut bucket = load_or("SlotBucket", &bucket_id, |b| {
        b.set_bigint(
            "start_slot",
            big((slot / BUCKET_SLOTS * BUCKET_SLOTS) as u128),
        );
        for f in [
            "deposits",
            "withdrawals",
            "tickets_usdc",
            "jackpot_paid",
            "yield_gain",
        ] {
            b.set_bigint(f, BigInt::zero());
        }
        b.set_i32("tx_count", 0);
        b.set_i32("unique_wallets", 0);
    });
    bump(&mut bucket, "tx_count");

    let mut seen: Vec<&str> = Vec::new();
    for ev in events {
        let f = flows(ev);
        add(&mut bucket, "deposits", f.deposited);
        add(&mut bucket, "withdrawals", f.withdrawn);
        add(&mut bucket, "tickets_usdc", f.tickets);
        add(&mut bucket, "jackpot_paid", f.jackpot);
        add(&mut bucket, "yield_gain", f.yield_gain);

        let Some(owner) = owner_of(ev) else { continue };
        let mut w = load_or("Wallet", owner, |w| {
            for f in ["deposited", "withdrawn", "tickets_usdc", "jackpot_won"] {
                w.set_bigint(f, BigInt::zero());
            }
            w.set_i32("tx_count", 0);
            w.set_bigint("first_slot", big(slot as u128));
        });
        add(&mut w, "deposited", f.deposited);
        add(&mut w, "withdrawn", f.withdrawn);
        add(&mut w, "tickets_usdc", f.tickets);
        add(&mut w, "jackpot_won", f.jackpot);
        w.set_bigint("last_slot", big(slot as u128));
        if !seen.contains(&owner) {
            seen.push(owner);
            bump(&mut w, "tx_count");
            let marker = format!("{bucket_id}-{owner}");
            if Store::load("BucketWallet", Id::from(marker.as_str())).is_none() {
                Store::save(Entity::new("BucketWallet", Id::from(marker.as_str())));
                bump(&mut bucket, "unique_wallets");
            }
        }
        Store::save(w);
    }
    Store::save(bucket);
}
