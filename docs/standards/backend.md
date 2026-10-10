# Backend standards

Read when the diff touches `apps/backend/src/operator/`, `indexer/`, `api/` or `apps/landing/api/`. Cross-layer rules are in `CODING_STANDARDS.md`.

## Operator tick

- Each step in `tick.ts` catches its own failure into `stepError` and the next step still runs. A bare `await ctx.send(...)` outside `attempt()` is a finding. Withdrawals, grants and `create_round` run on every tick whatever failed before them. [beta 09-27 4, mainnet 10-07 B1 and B2, audit-2026-10-10 4: the same wedge found in five reports]
- An error treated as expected still feeds the repeat counter, so a step that fails the same way every tick pages. A `logger.debug` inside a catch with no counter is a finding. [mainnet 09-28: `lastSuccessAt` advanced while every send failed]
- The tick gates a send on Pool state only where the program gates the instruction. A tick that skips `draw` on `shutdown` while the program accepts it is a finding. [audit-2026-10-10 3]
- A test in `operator.test.ts` makes each step throw in turn and asserts the later steps ran. A new step joins that table in the same diff.

## Indexer and read model

- A chain write gated on a Postgres value states the freshness bound it needs and has an on-chain fallback when the indexer is behind it. [beta 09-27 5: registration closed on a stale index]
- A cursor advances only on catch-up, and a freshness stamp only when the backlog is consumed. [beta 09-27, mainnet 09-28]
- An event-derived filter of the form `pubkey == f(owner)` names what happens when the owner rotates. Every mirrored entity (Player, Pool, House, Epoch) has a reconciler against its account. [audit-2026-10-10 2: rotated House never re-mirrored]
- A fact is never inferred from a missing row. The code writes an explicit marker or compares values. [audit-2026-10-10 1: stake paid twice because the reset wrote no row]
- A late event applies in sequence order, never over newer state. [audit-2026-10-10: referral tracker]

## API

- Every route is throttled unless it carries a `@SkipThrottle('reason')`. A test enumerates the routes and fails on an unthrottled one with no reason. [beta 09-27, audit-2026-10-09]
- A list query the client can grow (ids, wallets, cursors) goes through a chunked helper. A Prisma `in:` on a caller-sized array is a finding. [mainnet 10-07 B1: 32,767 bind variables stalled the operator]
- Ids are parsed through one pipe (`/^\d{1,18}$/`). Numeric query parsing that accepts `0x10` or `1e3` is a finding. [audit-2026-10-10]
- A public write (error reports, binds, applies) has a body size cap and a per-wallet limit, and newlines are stripped before anything reaches the log. [mainnet 09-28, 10-07 M3]
- `/status` and alerts carry an error code, not raw error text. A hostname, port or path in an API response is a finding. [beta 09-27]

## Identity

- A write that claims an external identity (X user, wallet, invite code) has a unique index and a `where col is null` guard in the same statement. [audit-2026-10-10 7: one X account verified many waitlist rows]
- A string from the client is re-derived from a signature or header before it keys a throttle, an origin check or ownership. [audit-2026-10-09: bet throttle keyed on an unverified string]
- A read keyed only by a public id states who may read it. Returning unused invite codes or private rows by wallet is a finding. [beta 09-27]

## Landing (`apps/landing/api`)

- Plain JS with no typecheck, so every handler validates its body with a schema at the top and every SQL write has the `is null` guard above. `dev.js` serves nothing under a dotfile path.
