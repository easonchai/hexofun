# The backend runs on Solami's RPC, WebSocket, Beam and webhooks, and the subgraph waits on a quota

Status: proposed (2026-10-10). Written for the Solami hackathon on `feature/solami-integration`.
The plan folder for this effort is gitignored, so this ADR is the committed record of which Solami
products the backend uses and why the rest were left out. Each product is one env var away from
off, and the fallback is the code running today.

Solami sells seven things: RPC with WebSocket subscriptions, Yellowstone gRPC, Mirage (Yellowstone
over a plain WebSocket), Blur (decoded DEX market data), a Data API (balances, history, token
lookups), webhooks, Beam (stake-weighted transaction sending), and the Index Engine (a hosted
subgraph: our WASM mapping over our program's transactions, served as GraphQL). HexVault's backend
needs four things from any provider: point reads, a live log feed for the Indexer, a catch-up walk
after a gap, and a way to land operator transactions. Nothing in Solami's stack knows what a Pool
or an Epoch is, so decoded products only help where the decoding is ours.

## Taken

**RPC and WebSocket as the mainnet primary, Helius as `RPC_FALLBACK_URL`.** `RPC_URL` points at
Solami, and the backend gains `RPC_WS_URL`, because Solami's pub/sub lives only on
`wss://ws.solami.dev/ws/sol` and the socket web3.js derives from the HTTP URL answers 405, which
left `onLogs` silently never connecting. Unset, `RPC_WS_URL` keeps the derived socket, so devnet,
the fork and the tests do not change. Helius stays as the fallback because the fee estimator
(`getPriorityFeeEstimate`) is Helius-only; `getProgramAccountsV2` works on both with the same
response shape.

**Beam for operator sends.** The operator's transactions (round closes, draws, harvests) go through
Solami's stake-weighted QUIC sender with a 0.0001 SOL tip each, and `GET /swqos/tx/{sig}` reports
whether and where each landed. No subscription, and the fallback is `sendRawTransaction`, which is
the path today. This is the one product that changes an outcome the operator can measure: landing
rate under load.

**A Solami webhook as a second live feed into the Indexer.** Solami pushes our program's
transactions over HTTPS with an HMAC; the Indexer dedupes by signature in `persist`, so a
transaction that arrives twice (webhook and `onLogs`) is written once. A feed that does not depend
on our socket staying up is the point. Fallback is `onLogs` plus the RPC walk, the path today. The
webhook route is probed before the ticket is built, because plan limits on the filter are unknown.

## Deferred, not rejected

**The `hexo` subgraph on the Index Engine.** The deploy route accepts this account and parses our
manifest, schema and WASM, then answers `402 subgraph limit reached (0)`. Subgraph quota is a
per-account override Solami sets by hand, not a line on any plan, and this account's custom plan
left it at 0. The ask is open. If it is granted, the Indexer's catch-up walk reads the subgraph
first and falls back to the RPC walk (GLOSSARY: Subgraph). The browser never reads it.

**Mirage as the third live feed (amended 2026-10-12).** Rejected below at first; taken once the
webhook's docs, which live only inside Solami's dashboard bundle, showed that a webhook with no
event types fires solely for transactions carrying a decoded event (`transfer`, `swap`, `mint`
and the like). Round closes, draws and settles carry none, so the webhook never sees most of
what the Indexer needs. Mirage has no such gate: a saved Yellowstone filter on the Active pool
address delivers every confirmed transaction touching it as a protobuf `SubscribeUpdate` over a
plain WebSocket. The decoder is sixty lines over four messages (signature, slot, error, log
lines), no dependency; frames wait for RPC finality through the same helper the webhook uses,
then go through `ingestPushed`. The per-byte bill stands, and at the pool's volume is cents. A
closed socket, for any reason including a lapsed plan, is retried with capped backoff and never
touches the Indexer's other feeds. Fallback is unsetting `MIRAGE_STREAM_URL`.

## Rejected

- **Mirage.** Reversed 2026-10-12, see above.
- **Yellowstone gRPC.** Available on this account (10 streams), and the same frames Mirage now
  carries, but it needs a gRPC client where Mirage needs a WebSocket.
- **Blur and the Data API.** DEX trades, candles, pools, token balances. HexVault reads none of it.
- **`getTransactionsForAddress` for the catch-up walk.** It returns signatures with slot and
  error, not transactions with logs, so the walk still needs `getTransaction` per signature.

Consequence: on mainnet the backend's core path touches five Solami products (RPC, WebSocket,
Beam, webhooks, Mirage), each switchable back to Helius or to the current code by unsetting one
variable, and the subgraph joins the moment the quota is raised.
