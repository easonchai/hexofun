/**
 * Shared setup for specs that only check layout and need the app past the
 * invite gate (AccessGate.tsx): the dev burner as the wallet and an idle
 * backend. Import `test` from here instead of "playwright/test" and `page`
 * arrives connected. Every API call is answered by `page.route`, `GET
 * /access/*` says allowed, and the RPC fails fast. Needs the burner build
 * playwright.config.ts starts (VITE_BURNER_WALLET=1 against a local RPC).
 *
 * Specs that script the Round or the Player (bet-flow, session-delegation,
 * earn-play-gate) keep their own mock; this one serves an empty board.
 */
import { test as base, type Page } from "playwright/test";

const API = "http://127.0.0.1:8080";
const RPC = "http://127.0.0.1:8899";
const SYSTEM = "11111111111111111111111111111111";

const state = {
  pool: {
    // The Pool the dev server's default VITE_POOL_ID derives; any other shows the refusal banner.
    address: "55AZWyYoN7tFoiBdr1wSuBdK2Rumfod7fm1Hp3VhNgAB",
    mint: SYSTEM,
    minDeposit: "1000000",
    paused: false,
    epochSeconds: "86400",
    baseRateBps: 800,
    gamePaused: false,
    jackpotPaused: false,
    totalPrincipal: "10000000",
    klendProgram: SYSTEM,
    klendMarket: SYSTEM,
    klendReserve: SYSTEM,
    klendCtoken: SYSTEM,
    venueKind: 1,
  },
  currentEpoch: {
    id: "1",
    startsAt: "1",
    endsAt: "9999999999",
    status: 0,
    jackpotAmount: "1000000",
    target: "0",
    winner: null,
    drawing: null,
  },
  player: {
    owner: "burner",
    principal: "10000000",
    tickets: "7500000",
    epochId: "1",
    isHouse: false,
    pendingWithdraw: "0",
    pendingEpoch: "0",
    pendingDeposit: "0",
    pendingDepositEpoch: "0",
    weight: "7500000",
    pendingTickets: "0",
    pendingActivatesEpoch: null,
    odds: "75.00",
  },
  status: {
    operator: null,
    cursor: { lastSlot: null, lastSignature: null, ageSeconds: null },
    rpcOk: true,
    slot: 1,
    shutdown: false,
    launchAt: null,
  },
  chainTime: "1800000000",
  serverTime: "1800000000",
  priorityFeeMicroLamports: 0,
  launchAt: null,
  nextRoundId: "1",
  openRound: null,
  lastRound: null,
  positions: [],
};

export async function mockIdleBackend(page: Page): Promise<void> {
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/access/")) return route.fulfill(json({ allowed: true, reason: "" }));
    if (path === "/state") return route.fulfill(json(state));
    if (path === "/feed" || path === "/epochs" || path === "/leaderboard") return route.fulfill(json([]));
    return route.fulfill(json({ message: "mocked" }, 404));
  });
  await page.route(`${RPC}/**`, (route) => route.abort());
}

/** Wallet-adapter autoConnect reads this key, so the burner is connected on load. */
export async function admitBurner(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("walletName", JSON.stringify("Localnet Burner (dev)")));
}

/** `test` whose `page` is already past the gate: idle backend, burner connected. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await mockIdleBackend(page);
    await admitBurner(page);
    await use(page);
  },
});
