# Depositors earn what the venue paid through a live Yield index, and withdraw at once

Superseded in part by ADR 0020: the instant withdraw and its Tickets rule are removed; the Yield index, Idle band, deploy, recall, harvest and venue loss stand. Amended by ADR 0021: the Impaired rules for deposits and Haircut exits, and the solvency formula. Amended by ADR 0023: the venue pins are no longer permanent, since a pool can change its venue behind a 48 hour lock, and a Kamino Earn vault is no longer rejected. Read "pinned at creation, no caller can substitute another" and the rejection of Earn vaults below as history.

Until now yield worked in three manual steps. The Admin pulled USDC out of the principal vault with
`admin_withdraw` and lent it at Kamino off the program (ADR 0010). The Admin funded a Yield budget
with `fund_yield`, and `register` credited a fixed Base yield out of it once per ended epoch
(ADR 0011). A withdrawal was a request paid after the epoch ended, because the money was away for
most of the day (ADR 0009). The product is now heading towards a wallet, and a wallet balance has
to earn from the second it lands and leave without a wait. This ADR supersedes 0009, 0010 and
0011. The Admin and Operator split in 0010 stands. ADR 0001 stands too: Principal and Tickets stay
numbers on the Player, and no share token is minted.

The pool PDA holds the position. Each pool pins one klend reserve, its lending market and the
pool's cToken account at creation, and no caller can substitute another. Everything
klend-specific sits in one venue module with three operations: value the position, deposit,
redeem. The value operation refreshes the reserve by CPI and fails with a named error if it is
still stale, the same thing Kamino's Earn vault does on every deposit and withdrawal. The
production build uses klend's published interface crate. Nothing is copied from the kVault
source, which is BUSL. A `test-venue` cargo feature swaps in a stub with a settable rate, the way
`test-vrf` stubs ORAO. `admin_withdraw` and `fund_yield` are removed, so no key, the Admin's
included, can send pool USDC to an arbitrary address. The permissionless calls can only move USDC
between the pinned reserve, the principal vault, the jackpot vault and the Treasury.

Every instruction that moves USDC or changes Principal runs Sync first. Sync values the cTokens at
the reserve's exchange rate, and the gain since the last Sync first repays any recorded deficit.
The rest splits three ways, in order. The Yield fee is the gain times `yield_fee_bps`, default
1000 and capped by a program constant of 2000. The depositor share is the rest, up to a ceiling of
`total_principal × base_rate_bps × seconds since last sync ÷ one year`. `base_rate_bps` stays 488
and changes meaning from a promised rate to a ceiling. The prize share is whatever is left. The
Yield index rises by the depositor share times 1e18 divided by `total_principal`, and three owed
amounts on `Pool` rise by their slices. No USDC moves during Sync. A Player then settles: their
Principal times the index rise since their last settle, divided by 1e18 and rounded down, is added
to their Principal and to their Tickets. If that rounds to zero the Player keeps their old index,
so a small balance accumulates instead of losing every fraction. The House holds no Principal and
never earns.

The pool keeps an Idle band of USDC in the principal vault: a floor of 500 bps and a target of
1000 bps of the pool. Deploy to the venue is permissionless. It moves only what sits above the
target, at least 100 USDC, and it is refused past either deployment cap: 5% of the reserve's
supply, and a reserve that would keep less than twice the pool's position as free liquidity.
Either key can pause deployment and only the Admin can restart it, the same asymmetry as Pause.
Recall is permissionless while free idle is under the target. Harvest is permissionless: it
redeems the fee owed and the prize share owed, sends the first to the Treasury and the second to
the jackpot vault, emits both in an event, and changes no Player.

Instant withdraw pays from free idle, which is the vault balance minus Pending withdrawals. When
idle is short it redeems the gap from the reserve in the same instruction. A Solana program cannot
catch a failed CPI, so it checks the reserve's free liquidity first and fails with a named error,
and the client falls back to the queued `request_withdraw` and `process_withdraw`, which stay. An
instant withdraw needs Tickets of at least the amount. A deposit always credits fresh Tickets, so
without that rule a Player who lost Tickets in the game could withdraw and deposit again to refill
them, and the pool's total Tickets would grow without limit. ADR 0009 dropped the rule only
because the queued payout lands after the epoch reset, which an instant one does not.

A fall in venue value beyond a loss tolerance of 1 bps sets Impaired and records the deficit. The
index never falls. The prize share owed absorbs the loss first, then the fee owed, and neither is
restored later. Whatever is left is the deficit, and while it stands every withdrawal pays a
Haircut of `principal × (vault balance + venue value − Pending − owed) ÷ total_principal`, rounded
down, while Principal and Tickets fall by the full amount requested. A Haircut withdrawal realises
the loss and takes no part in a later recovery. Harvest and deploy are refused while Impaired;
deposit, both withdraw paths and recall still work. Amended by ADR 0021: deposits are refused
while Impaired, and a Haircut exit needs the owner's signature. Impaired clears when later gains or the
permissionless `cover_deficit` bring the deficit to zero. One invariant ties it together and holds
after every instruction: `vault balance + venue value ≥ total_principal + Pending withdrawals +
yield owed + fee owed + prize share owed − recorded deficit`, within rounding dust. Corrected by
ADR 0020 and ADR 0021: the Pending withdrawals term is wrong, because a queued withdrawal stays
inside `total_principal`. The Haircut formula above loses the same term.

Each rejected option from the three superseded ADRs is reopened for a stated reason.

- ADR 0009 rejected a liquidity buffer: it earns nothing, its size is a guess, and the day it
  empties the same button pays one depositor at once and the next one a day later. The wallet
  goal makes an instant exit the default, and the program can now redeem from the venue in the
  same transaction, so an empty buffer still pays at once while the reserve has free liquidity.
  The form tells the depositor before confirm when the queued path is the only one. The buffer's
  drag is shared through the floating rate instead of paid by the team.
- ADR 0010 rejected a Kamino CPI adapter because the program would carry a venue integration and
  the audit would grow to cover it. `admin_withdraw` let the Admin move every dollar not held for
  a Pending withdrawal, so a stolen multisig or a wrong runbook step could lose depositors'
  money. A program-held position removes that trust, and the adapter's audit scope is one module
  with three operations.
- ADR 0011 rejected a per-second credit because 1 USDC earns about 1.6e-9 USDC a second, which
  rounds to zero on every transaction, and rejected shares because they change what `principal`
  means. The index accrues at pool level with 18 decimals and rounds only when a Player settles,
  and a Player whose credit rounds to zero keeps their old index. Principal stays a 1:1 number.
  The funded budget goes too: depositors only ever receive what the venue paid, so
  `total_principal` never runs ahead of the money.

Considered and rejected: handing out the klend cTokens or minting a share token. A token that moves
freely leaves the program blind to Ticket and Weight changes. A Token-2022 transfer hook fixes
that, but DEXes reject hook tokens, and a rising share price makes poor money.

Considered and rejected: depositing into a Kamino Earn vault instead of raw klend. Its admin can
set fees and a withdrawal penalty with no time lock, and it adds a curator to trust.

Considered and rejected: computing accrued interest without refreshing the reserve. Kamino's own
vault refreshes and asserts freshness, and so does this design. A client-prepended refresh with
the same freshness check is the fallback only if spike 01 finds the in-module refresh does not fit
the compute budget.

Consequences: the Admin signs no transactions in normal operation. Yield budget, Deployed
principal and Principal out stop existing, and the runbook drops `admin_withdraw`, `fund_yield`
and the daily prize funding. The rate floats, so the screen says "up to X%" with the 7-day rate
actually paid beside it; with 10% idle and a 10% fee, a 6.5% venue pays about 5.3%. The program
stores no rate; the Indexer keeps a history of the Yield index and derives trailing rates from it.
Instant exits rest on the reserve's free liquidity once idle is spent; the main USDC reserve was
95% utilised on 2026-09-29 with about 5.8M free, so the caps must be sized from the live figure.
A missed harvest makes that day's prize smaller and the next one larger, and no money is lost.
Every instruction that runs Sync takes the reserve, the cToken account and klend's refresh
accounts. Depositors now trust the code, klend and the upgrade authority instead of the Admin, so
the upgrade authority must move to a long-lock multisig before a program-held position goes live;
the mainnet effort tracks that. The layout change this needs is the one exception ADR 0013 allows.
`docs/plan/yield-claimer/spec.md` has the full design.
