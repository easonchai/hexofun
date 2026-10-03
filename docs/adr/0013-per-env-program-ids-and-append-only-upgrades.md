# Each environment gets its own program ID, and upgrades are append-only from here

One program ID, `LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6`, served `declare_id!`, both Anchor
clusters, and both apps' IDLs at once. That was fine while there was one devnet pool; it stopped
being fine once the laptop and the VPS were both live on it, since one upgrade could break both,
and it would have meant mainnet reusing a keypair that had already run on devnet. `declare_id!`
now branches on a cargo feature: `mainnet` and `staging` each pick their own ID, and the default
(no feature) keeps the original for dev, on both localnet and devnet. The three keypairs live
under `keys/` (gitignored); `Anchor.toml` only needs entries for dev (`localnet`, `devnet`) and
mainnet, since `scripts/deploy.sh` passes the staging keypair to `solana program deploy`
explicitly rather than through an Anchor cluster. Both apps already took their program ID from
env rather than the committed IDL (`chain.service.ts` on the backend); the web build did not
(`App.tsx` built its Anchor `Program` from the IDL's own address), so a second ID would have sent
every wallet transaction to the wrong program. Fixed in the same pass: `App.tsx` and `chain.ts`
now share one `programIdFrom` function, so the override and the PDA derivation cannot diverge.

Mainnet also forced the question of what an upgrade is allowed to do. `Pool`, `Player` and
`Epoch` had no spare bytes, so any new field before now would have changed each account's
on-chain size, and every existing account would fail Anchor's deserialization (error 3003) the
instant the new code tried to read it, `request_withdraw` included, with no way back except a
fresh pool. That is acceptable on a devnet demo and not on mainnet with real deposits sitting in
it. The three long-lived structs now carry `version: u8` and a reserved byte array
(`Pool`: 128, `Epoch`: 64, `Player`: 64) that a later field takes bytes from, so its width comes
out of the padding instead of the account. The rule going forward: append only, never reorder or
resize an existing field; a new field's zero value must already be the safe default, or the
change bumps `version` and migrates the account lazily the first time an instruction touches it;
a new capability is a new instruction, not a new required argument on an existing one. `shutdown`
(ops-and-envs ticket 02) is the first field taken from `Pool`'s padding, and exercises the rule
once on purpose: `false` is the safe zero, so no migration code exists yet, because nothing has
shipped an older version to migrate from.

`Round` and `Position` are the deliberate exception: no padding. They are short-lived, opened and
reclaimed (`close_round`) within a day, so a layout change there only strands whatever round is
open at the exact moment of the upgrade, not a depositor's principal; `docs/ops/deploy.md` says to
upgrade only when no round is open, and that is the whole mitigation this ADR asks for.

Considered and rejected: one program ID with a `cluster` field on `Pool` distinguishing
environments. It does not solve the actual problem, which is that an upgrade to the one deployed
binary lands on every environment's accounts at once; the environments needed separate upgrade
authorities and separate blast radii, which only separate program IDs give.

Considered and rejected: an on-chain migration instruction run once per account. Nothing has
shipped a `version` other than 1 yet, so there is nothing to migrate; writing migration machinery
ahead of a real old version to migrate from is speculative, and the lazy-migration rule above
already covers the case when one exists.

Considered and rejected: sizing every struct generously up front instead of a fixed, documented
padding budget. An unbounded reserve just moves the same "how much is enough" guess earlier and
makes account rent (and `INIT_SPACE`) harder to reason about; 128/64/64 bytes is enough for
several small fields and cheap enough in rent to not matter, and the layout test in `state.rs`
makes any future change to these numbers a deliberate one.

Consequences: dev keeps running the original ID, so nothing about the laptop or the existing
devnet pools changes today. Standing up staging or mainnet means a fresh set of pools from pool ID
1 on that program, never a migration from dev's. An upgrade that only adds a field to `Pool`,
`Epoch` or `Player` no longer forces a fresh pool the way the epoch-anchor and House-cut changes
once did (see `runbook.md`'s history of that); `docs/ops/environments.md` says when a new program
ID is still warranted despite this. `docs/ops/deploy.md` has the full deploy and upgrade
procedure, including the Ledger-signed mainnet path and the cosmetic `anchor build` warning this
feature split causes.

2026-10-04 amendment: the append-only rule is suspended once, for the live-yield rewrite of
ADRs 0017, 0018 and 0019, because no mainnet pool and no mainnet deposit exist yet. That rewrite
deletes the Base yield, Weight and registration fields from `Pool` and `Player`, folds the venue
state into `Pool`, gives `Round` 64 reserved bytes and `Position` 32, which ends their no-padding
exception, and bumps `version` on every account it changes. Dev pools are not upgraded in place:
the rewrite deploys to a fresh program ID per environment and pools are bootstrapped anew, as
`pool-cutover` describes. This is the one exception. From the first mainnet deposit the rule
above applies again, with no further exception.
