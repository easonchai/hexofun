# @hexvault/web

The HEXO web app (Dark Navy & Electric Gold edition) driving
the program from the browser: hexagon arena with animated round settles, plus
the deposit and withdraw surface. Dark theme is primary; light mode keeps the
blue primary. All colour flows through the token blocks at the top of
`src/styles.css`, and screens compose the shared primitives in `src/ui.tsx`.

## Run

```sh
pnpm --filter @hexvault/web sync-idl   # after every `anchor build`
pnpm --filter @hexvault/web dev        # Vite dev server
```

Copy `.env.example` to `.env.local` and adjust. The five variables are
`VITE_PUBLIC_RPC_URL`, `VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID` and
`VITE_PRIVY_APP_ID`; every one has a working default for a local validator.
`VITE_BURNER_WALLET=1` adds the dev burner wallet, and only when
`VITE_PUBLIC_RPC_URL` points at localhost.

## Scripts

| script                      | purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `dev` / `build` / `preview` | Vite                                                         |
| `check`                     | `tsc` over `src`                                             |
| `test`                      | Vitest unit tests (money, tiles, round engine, feed rows)    |
| `sync-idl`                  | copy `target/idl/hex_vault.json` -> `src/idl/hex_vault.json` |

## Rules baked into the code

- `GET /state` (`src/useStatePoll.ts`) is the one poll for the Pool, Epoch and
  the connected wallet's Player. `src/read.ts` reads only the wallet's own
  token balance from the chain. The API's absence shows as a banner, never a
  crash.
- Amounts are bigint atomic units; formatting and parsing happen in
  `src/lib/money.ts` with no float in the path.
- Rounds and Positions are not on chain any more (ADR 0025). The PLAY tab sits
  behind `VITE_GATE_GAME=off` until wave 2 serves Rounds from the API.
- Transactions are built directly from the IDL (`src/actions.ts`). The Anchor
  client camelCases the IDL, so `buy_tickets` is reached as `buyTickets`.
