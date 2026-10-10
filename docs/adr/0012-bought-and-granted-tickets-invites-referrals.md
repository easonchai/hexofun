# Tickets can be bought or granted, and an app-level invite gate feeds a referral bonus

Amended by ADR 0022 (2026-10-06): the buy and per-Player grant caps below count locked Principal
(the Pending deposit excluded), and the pool-wide grant cap counts the `total_principal` of the
epoch's start. The wording below is the original.

Until now every Ticket (`Player.entries`) came from a deposit, the game, or a payout. Growth
needed two more sources that do not touch Principal: `buy_tickets` spends USDC at a pool-set
`tickets_per_usdc` rate and sends it to the jackpot vault, never returned, capped per Player per
epoch at that Player's own live Principal (see the amendment above). `grant_tickets` credits Tickets with no USDC at all,
through two paths on one instruction: an operator path capped per Player and pool-wide
(`bonus_cap_bps` of `total_principal`) for the automated referral bonus, and an uncapped admin
path, House included, for a manual fix. Both are ordinary Tickets the instant they land: the
game and the draw cannot tell a bought or granted Ticket from a deposited one.

Growth needed a gate and a reason to invite, so two more pieces sit above the program, entirely
in the app and the backend, because neither is worth a program upgrade to change: an invite code
(app-level only; the program has no notion of it) lets a wallet in before its first deposit, and
whichever code it redeemed fixes its Referrer for good. A Referral is Qualified once its
Principal has stayed at or above $50 for 7 uninterrupted days (`REFERRAL_QUALIFY_SECONDS`,
shortened on devnet); dropping below restarts the 7 days from zero. Once a day, right after
`begin_epoch`, the operator's own crank grants each Referrer a bonus through the operator path
above: a rate by their count of Qualified referrals (1-2 referrals: 2%, 3-5: 3%, 6-10: 4%, 11+:
5%), applied to each qualified referral's own Principal up to $2,500 of it, summed and capped at
the Referrer's own Principal, then scaled down pool-wide if the total would exceed the epoch's
bonus cap.

Considered and rejected: an on-chain invite registry and referral graph. Neither changes what any
instruction is allowed to do, so putting them on chain would only add accounts to maintain and an
upgrade path for a decision (who gets in, who refers whom) that is going to be tuned far more
often than the program itself. The gate can be loosened, tightened or turned off in the backend
with no upgrade at all.

Considered and rejected: paying the referral bonus as Principal instead of Tickets. Principal is
a claim on real USDC; a bonus nobody paid for should not mint one. Tickets cost the pool nothing
until they win, the same property `grant_tickets`' admin path already relied on for a manual fix.

Considered and rejected: verifying qualification against `Player.principal` read live at bonus
time. A window that only ever looks at the instant of the crank misses a referral that dipped
below $50 for six of the last seven days and happened to be back above it at the exact moment the
job ran; the indexer instead tracks `aboveSince` per referral off the same Principal-changing
events (`Deposited`, `WithdrawRequested`, `YieldCredited`, `JackpotPaid`) it already mirrors, so a
dip anywhere in the window is caught even if the job runs late.

Consequences: `buy_tickets` and the referral bonus both grow the pool's own liabilities, Tickets
outstanding, with no corresponding Principal or vault balance behind them the way a deposit has;
this is by design; a Ticket has never been a USDC claim. The invite gate and referral tracking
live entirely in Postgres and the API, so they carry the Read model's own trust assumption
(ADR 0008): the indexer being wrong or behind can let someone in it should not, or miscount a
qualification, without the program itself misbehaving. `docs/plan/hexo-referrals/spec.md` has the
full rate table and job design this ADR summarizes.
