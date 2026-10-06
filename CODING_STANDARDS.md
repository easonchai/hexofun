# Coding standards

Read at review time. Each rule is a judgement call; anything a tool can catch lives in `pnpm check`, `pnpm check:sh` or the pre-push hook instead.

## Scope

- Every file in the diff belongs to the ticket. A stray deletion, an unrelated file or a drive-by refactor is a finding.
- UI changes only where the ticket asks for them. For any touched component, compare against `main`: new widgets, copy, animations or layout the ticket does not name are findings.

## Failure shows

- A failed read renders as "unavailable", never as zero, empty or "all clear". `null` from the API means unknown.
- A user action that cannot proceed says why on screen. A handler that returns early without feedback (missing wallet capability, missing account, gate not passed) is a finding.
- Code that recognises an RPC or program error by its message text covers devnet, mainnet and the Surfpool fork, or matches on the error code instead.

## Tests

- Each behaviour change ships a test that fails without it. A ticket that only touches UI says how it was checked (browser, Playwright, screenshot).
