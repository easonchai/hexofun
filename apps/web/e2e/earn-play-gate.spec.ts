/**
 * Off-chain tickets ticket 10: with the game gate set, EARN shows the Player's
 * Tickets from the API and the PLAY tab shows the Coming soon card. No chain,
 * no backend: every API call is answered by `page.route`.
 *
 * Needs a dev server started with the burner wallet and the gate, because
 * Vite inlines these at build time (Playwright's webServer reuses a server
 * already on :5173):
 *
 *   VITE_BURNER_WALLET=1 VITE_PUBLIC_RPC_URL=http://127.0.0.1:8899 \
 *   VITE_API_URL=http://127.0.0.1:8080 VITE_GATE_GAME=off \
 *   VITE_PRIVY_APP_ID=off pnpm --filter @hexvault/web dev
 */
import { expect, test, type Page } from "playwright/test";

const API = "http://127.0.0.1:8080";
const RPC = "http://127.0.0.1:8899";
const WEIGHT = "7500000";

const pool = {
  address: "11111111111111111111111111111111",
  mint: "11111111111111111111111111111111",
  minDeposit: "1000000",
  paused: false,
  epochSeconds: "86400",
  baseRateBps: 800,
  gamePaused: false,
  jackpotPaused: false,
  totalPrincipal: "10000000",
  klendProgram: "",
  klendMarket: "",
  klendReserve: "",
  klendCtoken: "",
  venueKind: 1,
};

const player = {
  owner: "burner",
  principal: "10000000",
  tickets: "0",
  epochId: "1",
  isHouse: false,
  pendingWithdraw: "0",
  pendingEpoch: "0",
  pendingDeposit: "0",
  pendingDepositEpoch: "0",
  weight: WEIGHT,
  pendingTickets: "0",
  pendingActivatesEpoch: null,
  odds: "75.00",
};

const state = {
  pool,
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
  player,
  status: {
    operator: null,
    cursor: { lastSlot: null, lastSignature: null, ageSeconds: null },
    rpcOk: true,
    slot: 1,
    shutdown: false,
    launchAt: null,
  },
  chainTime: "1800000000",
  priorityFeeMicroLamports: 0,
  launchAt: null,
};

async function mockBackend(page: Page): Promise<void> {
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/access/")) return route.fulfill(json({ allowed: true, reason: "" }));
    if (path === "/state") return route.fulfill(json(state));
    if (path === "/feed" || path === "/epochs" || path === "/leaderboard") return route.fulfill(json([]));
    return route.fulfill({ status: 404, ...json({ message: "mocked" }) });
  });
  // Balance, genesis and fee reads fail fast; none of them feed what is checked here.
  await page.route(`${RPC}/**`, (route) => route.abort());
}

async function connectBurner(page: Page): Promise<void> {
  await page.goto("/#earn");
  const gateConnect = page.getByRole("button", { name: /connect wallet/i });
  const navConnect = page.getByTestId("connect-button");
  await expect(gateConnect.or(navConnect).first()).toBeVisible({ timeout: 15_000 });
  if (await gateConnect.isVisible()) await gateConnect.click();
  else await navConnect.click();
  const burner = page.getByRole("button", { name: /burner/i });
  if (await burner.isVisible({ timeout: 5_000 }).catch(() => false)) await burner.click();
  await expect(page.getByTestId("topbar-tickets")).toBeVisible({ timeout: 15_000 });
}

test("EARN shows the Player's Tickets and PLAY shows Coming soon with the gate set", async ({ page }) => {
  await mockBackend(page);
  await connectBurner(page);

  // 7.5 Tickets: `weight`, which is `tickets` with the lazy epoch reset applied.
  await expect(page.getByTestId("topbar-tickets")).toHaveText("Tickets: 7.50");
  await expect(page.getByTestId("dashboard-screen")).toBeVisible();

  const play = page.getByTestId("tab-mine");
  await expect(play).toHaveAttribute("aria-disabled", "true");
  await expect(play).toHaveAttribute("data-tip", "Coming soon");

  // The nav lock is not the only way in: the hash opens PLAY too.
  await page.goto("/#play");
  await expect(page.getByTestId("coming-soon")).toBeVisible();
  // Nothing on the board can place a bet.
  await expect(page.getByTestId("deploy")).toBeDisabled();
});
