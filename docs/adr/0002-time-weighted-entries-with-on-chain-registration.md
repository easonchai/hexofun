# Jackpot odds are time-weighted Entries registered on chain, not a Merkle snapshot

> **2026-10-04: superseded by [ADR 0018](0018-fenwick-weight-tree-replaces-registration.md).**
> Registration is replaced by forward-credited Weight in a Fenwick weight tree. The Weight, the
> odds, the on-chain draw and the rejection of the per-Player win check below are unchanged.

The first build committed a Merkle-sum root of Entries balances signed by a trusted "snapshot authority", and winners proved inclusion with an off-chain proof. That key could decide the winner, and the export pipeline was the largest piece of off-chain code. The rebuild follows PoolTogether: each Player accumulates `entries × seconds` on every touch, and after an epoch ends anyone can call `register` to claim a contiguous interval of the epoch's total weight computed from that player's own on-chain state. The draw picks a point in the total; `payout` verifies the interval. Cost: one registration transaction per player per epoch, cranked by the operator. Benefit: no trusted key in the winner selection, no freeze window, withdrawals never blocked, and later deposits earn proportionally less weight without any special rule.

Considered and rejected: PoolTogether V5's per-user independent win check (`hash(rng, user) < weight/total`). It avoids registration but yields zero or several winners, which does not fit "one winner takes the whole jackpot".
