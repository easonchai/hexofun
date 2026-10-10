# The ticket caps count locked Principal, a Position only goes on a Round of the current epoch, and create_pool checks its pins

Status: accepted (2026-10-06). It amends ADR 0012. The 2026-10-06 audit of `feature/mainnet-contracts` found the gaps below, and the spec is `docs/plan/audit-fixes/spec.md`.

ADR 0012 capped `buy_tickets` per epoch "up to their Principal" and gave the Operator's grants the
same base. Since ADR 0020, Principal includes the Pending deposit, and a Pending deposit refunds the
moment the Player asks. The audit ran the sequence on a local validator: deposit X, buy X of
Tickets, request the refund, all in one transaction. It left ten billion Tickets on zero Principal
for the price of the Tickets alone, and a flash loan can supply the X. The Operator's grant caps had
the same base. The pool-wide cap read the live `total_principal`, so a wallet that deposited
mid-epoch widened it.

Rule 1. The buy cap and the Operator's per-Player grant cap count locked Principal, which is
Principal less the Pending deposit. A deposit made today counts from the next epoch, the same day
its Tickets start. The pool-wide Operator grant cap counts `total_principal` as it stood when the
epoch began. `begin_epoch` writes that number to a new Pool field taken from the reserved bytes, and
the cap is that field times `bonus_cap_bps`. The field is zero before epoch 1, so Operator grants
are refused until an epoch exists, as `buy_tickets` already is. The Admin's grants stay uncapped.
Rejected: keep Principal as the base and block the refund while Tickets were bought. That closes
this sequence and leaves the cap measuring money that can still leave.

Rule 2. A Position only goes on a Round of the current epoch. `buy_position` checks that the
Round's epoch equals the pool's current epoch and fails with a new named error, appended to the
list. A Round opened before epoch 1 carries epoch zero. Before this rule, a stake could still land
on such a Round after epoch 1 began, if the Round ended inside epoch 1. At settle the program read
it as a Round from an earlier epoch, whose stakes the epoch reset had already restored, and
credited nothing back. The stake left the epoch-1 tree for good. Now a pre-epoch-1 Round takes no
stake once epoch 1 begins and leaves through `void_round` like any Round nobody draws for.
`create_round` does not change. The straddle check stays, redundant from epoch 1 on, because it
still states the rule.

Rule 3. `create_pool` validates what it pins. The cToken account must be a classic SPL token account
whose owner is the pool PDA. A wrong pin sent every deploy's cTokens to a stranger, and no redeem
could bring them back. The mint is still checked against the reserve at the first sync, because the
test-venue stub has no reserve to read at creation. `payout_timeout < epoch_seconds` joins the
parameter checks with the existing error, the same check `set_params` makes. The bootstrap command
already creates the cToken account as the pool's associated token account, so it passes unchanged.

Redeem dust. `recall`, `harvest` and the refund in `request_withdraw` charged the fee for the whole
gap between the value lost and the amount asked for, although the vault received a unit more than
asked. That unit sat in the vault owned by nobody. The dust is now the value lost beyond what the
vault received, floored at zero.

Consequences: the new Pool field lives in reserved bytes, so the account size does not change and
zero is the safe default. Pools ship fresh through the ADR 0016 cutover, so no migration is needed.
Errors are appended, never reordered, and the IDL copies in the backend and the web are
regenerated. The API's buy allowance is locked Principal less what was bought this epoch, floored
at zero. The buy form says a new deposit counts from the next epoch. A Player who deposits and buys
on the same day can spend less than before, by exactly the Pending deposit. The glossary's Bought
tickets and Granted tickets entries say "locked Principal (the Pending deposit excluded)". The
Bought tickets pause stays on until these fixes are deployed. ADR 0012 history: it said "up to their
Principal", and that wording is the one this ADR replaces.
