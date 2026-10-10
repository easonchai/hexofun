# Web standards

Read when the diff touches `apps/web/src/`. Cross-layer rules are in `CODING_STANDARDS.md`.

## Sends and polls

- A poll after a send has a try/catch per RPC call. An RPC error during the poll renders "unknown", never "failed", and the CTA stays disabled until the outcome is known. [beta 09-27, mainnet 09-28, audit-2026-10-10 5]
- Every fetch has a timeout. [beta 09-27]
- `new PublicKey(...)` and `BigInt(...)` run in `read.ts` or `api.ts`, never in a component body. [beta 09-27: render-time throws with no boundary]
- An error message is built with the shared message helper. `String(err)` on an unknown value is a finding, it renders `[object Object]`. [fork run 10-09]

## State across wallets and phases

- Every hook's state is keyed by owner and resets on wallet switch. A test switches the owner and asserts the reset. [mainnet 09-28: terms checkbox carried across wallets; audit-2026-10-10: stale extras]
- For any value shown from "current X", the ticket or the component comment says what it shows while the previous X is Ended or Drawing, and while a Round is revealing. The engine or API test covers that gap. [fork run 10-09: countdown restarted during results, prize card read epoch 5 while 4 was drawing]
- A client-side pre-check refuses only what the program refuses. [audit-2026-10-10 6: kVault pool with nothing lent out blocked every withdraw]

## Config

- `import.meta.env.VITE_*` keys that pick a cluster, API host, program or Privy app have no fallback. The app renders "misconfigured" and the key name. [beta 09-27]
- Dev-only switches (burner wallet, mocks) are off unless `MODE === "development"`. [mainnet 10-07]

## Layout

- A CSS change is checked at desktop and 375px width with large values ($222,591.50 and $1,000,000+) before the ticket says fixed. A screenshot or Playwright shot is named in the ticket. [fork run 10-09: overflow found by the user after "fixed"]
- Copy that states a rate or guarantee ("5% base yield", "never touched") comes from the API or a copy file marked static. A hardcoded rate in JSX is a finding. [beta 09-27, mainnet 09-28]
