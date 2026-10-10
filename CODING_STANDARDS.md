# Coding standards

Read at review time. Each rule is a judgement call; anything a tool can catch lives in `pnpm check`, `pnpm check:sh` or the pre-push hook instead. A rule here that a grep could enforce is itself a finding: move it to the hook.

Layer rules, read for any diff that touches the layer:

| Diff touches | Read |
| --- | --- |
| `programs/hex_vault/` | `docs/standards/program.md` |
| `apps/backend/src/operator/`, `indexer/`, `api/`, `apps/landing/api/` | `docs/standards/backend.md` |
| `apps/web/src/` | `docs/standards/web.md` |
| `scripts/`, `runbook.md`, `docs/ops/`, `.husky/`, `docker-compose*` | `docs/standards/ops.md` |

Every rule below was written after a review found the defect at least twice. Each has the report that found it in brackets.

## Scope

- Every file in the diff belongs to the ticket. A stray deletion, an unrelated file or a drive-by refactor is a finding.
- UI changes only where the ticket asks for them. For any touched component, compare against `main`: new widgets, copy, animations or layout the ticket does not name are findings.
- A ticket closed with one acceptance box unticked files the remainder as a new ticket in the same commit. A half-done ticket with no successor is a finding. [fork-run-fixes 10, kVault web half sat untracked for three days]

## One rule, one owner

- A rule the program enforces has at most one derived pre-check per layer (operator, API, web), tested on the program's own boundary vectors. A gate that is stricter or looser than the instruction it fronts is a finding. [audit-2026-10-10 3 and 6: tick skipped `draw` on shutdown, web refused a withdraw the program allows]
- A change to an account's identity, authority or constraint lists its consumers before the first edit: program constraints, `operator/instructions.ts`, the indexer mirror and ledger, `apps/web/src/actions.ts`, the IDL copies, `opsMap.ts`, `docs/ops`. Each consumer gets a test or a one-line reason in the ticket. A consumer found by a later audit is a finding. [audit-2026-10-09 02 and 2026-10-10 2: rotated House]
- A test stub that encodes a value production never produces (an `isHouse` that is always false, a fixed clock with a live timer) is a finding.

## Failure shows

- A failed read renders as "unavailable", never as zero, empty or "all clear". `null` from the API means unknown.
- A user action that cannot proceed says why on screen. A handler that returns early without feedback (missing wallet capability, missing account, gate not passed) is a finding.
- Errors are recognised by IDL name or code. Message-text matching is a finding unless the test covers devnet, mainnet and the Surfpool fork wording. A name in a hand-kept error set that the IDL no longer defines is a finding. [audit-2026-10-09 02: `NotPreviousEpoch` outlived its variant]
- An unknown outcome is never shown as failure. A poll that follows a send returns "unknown" on its own error, never "failed", and never offers a retry that could double the action. [beta 09-27, mainnet 09-28, audit 10-10 5: reported three times]

## Config fails closed

- An environment value that selects a cluster, program, pool, API host or signer has no fallback. A `??` or `||` default on such a key is a finding; the app refuses to boot and names the key. [beta 09-27: `PROGRAM_ID` defaulted to devnet; mainnet 10-07: admin CLI fell back to the hot key]
- An optional field on a signed or admin update keeps the in-force value when omitted. A field that resets to zero or unset because the caller left it out is a finding. [audit-2026-10-09 08: grant cap dropped]

## Tests

- Each behaviour change ships a test that fails without it. A ticket that only touches UI says how it was checked (browser, Playwright, screenshot).
- A test never reads ambient shell env. Every key the code under test reads is pinned or deleted in the suite's setup file. [shutdown drill 10-09: shell `OPS_WALLETS` turned a 404 check into 403]
- A test that fixes a date injects the clock or stops the timers it starts. A fixed past date beside a real-clock `setInterval` is a finding. [off-chain-tickets 35: `rounds.test.ts` went red after one day]
- A list the API returns has an `orderBy` with a unique tiebreaker. [beta 09-27: leaderboard order was nondeterministic]
- "Does X work" and "is X tested" are answered by naming the test file and case, or by running it. An answer with neither says "not run".

## Docs and comments

- A ticket that removes UI, an instruction or a CLI flag deletes every comment, doc line and runbook command that names it, in the same diff. Grep the retired name. [mainnet 09-28 2: runbook named `admin start-game`; `screens/Vault.tsx:8` still names "Pay out now"]
- A number in a runbook or ticket (SOL float, CU, APY, timeout) cites where it was measured. An unmeasured number a ticket depends on is a finding before the ticket is `ready-for-agent`. [off-chain-tickets 34: kVault APY assumed, measured at 5.2% and short]
