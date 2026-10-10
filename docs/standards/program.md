# Program standards

Read when the diff touches `programs/hex_vault/`. Cross-layer rules are in `CODING_STANDARDS.md`.

## Every gate has an exit

- A new pause, shutdown, timeout or status check ships with the instruction that leaves the state it creates, callable by a stranger after the deadline. The diff carries a localnet test that enters the state and leaves it with the default signer, and the operator calls that exit in the same diff. A gate with no exit, or an exit nobody calls, is a finding. [beta 09-27 2: VRF seed griefing left a Round open forever; mainnet 09-28 4: new exits existed and the operator never called them; mainnet 10-07 B3: queued withdrawals unpaid at shutdown]
- An instruction only the Operator can call decides nothing a player is owed. Draws, settles and payouts are permissionless once their inputs are on chain. [production-hardening 1]

## Accounting bases

- A cap, weight or payout that reads Principal, Pending or an epoch field names, in a comment, which of those the caller can lower inside the same transaction or across the epoch edge. The diff carries the deposit-act-withdraw sequence as a test. A base the user can shrink after it was read is a finding. [audit-fixes 01: Tickets minted on principal refunded in the same transaction; mainnet-review-fixes 1: a queued full withdrawal still won]
- A partial sweep, haircut or redeem subtracts what moved. Zeroing the field after a partial move is a finding. [beta 09-27: `sweep_house` zeroed `yield_budget`]
- Dust from a redeem or rounding is charged once, to a named party, with a test at amount 1 and at tolerance plus and minus one. [audit-fixes 04, fork-run-fixes 12]
- A subtraction that can legitimately go one unit negative from rounding uses `saturating_sub` with a `// saturating:` comment saying why. A `checked_sub` that fails a live path on a rounding rise is a finding. [audit-2026-10-10: `deploy_to_venue`]

## Pinned accounts

- Every account an instruction reads that is not a signer, a PDA of this program, a program id or a sysvar is pinned by `has_one`, `address` or a seed. A non-default-key check alone is a finding. [mainnet 10-07 S1: `propose_venue` accepted any program id]
- A parameter check in `set_params` also runs in `create_pool`, through one shared validator, with one test that feeds the same bad vectors to both. [mainnet 09-28: `payout_timeout < epoch_seconds` only in `set_params`]
- An authority setter refuses the default key and hands over every account the old authority owned, in the same instruction. [audit-2026-10-09 02]

## Before epoch 1 and after shutdown

- Every instruction states, in its account constraints or an early check, what it does when the Pool has no Epoch, when the Epoch is Ended but not Drawn, and when `shutdown` is set. A test covers each. "It cannot happen" is a finding unless a constraint makes it so. [audit-fixes 02 and 08, beta 09-27]
