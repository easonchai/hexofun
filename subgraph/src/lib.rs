//! The `hexo` subgraph: a Solami Index mapping over HexVault transactions.
// The host build exists only for `cargo test`; `run` is exported on wasm32 alone.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod decode;
#[cfg(test)]
mod fixtures;
#[rustfmt::skip]
mod generated;

#[cfg(target_arch = "wasm32")]
use solami_index_sdk::prelude::*;

#[cfg(target_arch = "wasm32")]
fn map(tx: Transaction) {
    match decode::decode_events(tx.logs()) {
        Ok(events) => log!("{} events at slot {}", events.len(), tx.slot),
        Err(err) => log!("{}: {err}", tx.signature_b58()),
    }
}

#[cfg(target_arch = "wasm32")]
main!(map);
