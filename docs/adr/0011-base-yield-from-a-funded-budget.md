# Depositors earn a base yield, paid only from a budget already in the vault

> **2026-10-04: superseded by [ADR 0017](0017-live-yield-index-and-instant-withdraw.md).**
> Base yield is the depositors' share of what the venue paid, under a `base_rate_bps` ceiling,
> credited through a live Yield index. The Yield budget and `fund_yield` are removed.

Until now every unit of yield became the prize, the PoolTogether v5 model, and depositors earned nothing directly. The product now promises savers a fixed rate on top of their deposit. Each Player therefore keeps `principal_acc`, a running sum of Principal × seconds built exactly like `weight_acc`, and `register` credits `principal_acc × base_rate_bps / year` into Principal once per ended epoch. Credits come out of `Pool.yield_budget`, which the permissionless `fund_yield` raises by moving real USDC into the principal vault, and a credit never exceeds what the budget holds. When the budget runs dry the credit is short, the shortfall is reported, and nobody is owed money the pool does not have.

Considered and rejected: crediting on each Player's Principal at the end of the day. It is one multiplication, but a deposit at 23:59 would earn a full day. Time-weighting reuses the pattern `touch` already has and matches how Kamino and marginfi accrue per second.

Considered and rejected: a per-second credit in `touch`, or a share and exchange-rate model like Kamino's. At 6 decimals 1 USDC earns about 1.6e-9 USDC a second, which rounds to zero on every transaction, and shares would change what `principal` means everywhere Tickets are derived from it. A daily credit from an accumulator keeps both exact.

Considered and rejected: crediting yield with no budget and letting the admin top up the vault afterwards. It makes `total_principal` a promise the vault cannot cover whenever the lending venue earns less than the rate, and readers would see the gap as deployed principal.

Consequences: the admin funds the budget every day as well as the jackpot, and whatever Kamino earns above the base rate is what is left for the prize. With a 5% rate and a venue near 5%, the prize comes from sponsors and ticket sales. When the budget is short, Players registered first in the crank are paid first. The rate is an admin parameter, so it can drop without an upgrade.
