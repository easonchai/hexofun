/**
 * Off-chain tickets ticket 18: the board and the bet flow on the PLAY tab, with
 * the dev burner as the wallet and a scripted backend. No chain, no real API:
 * every call is answered by `page.route`, and the script moves the Round
 * through open, closed (DRAWING), settled and voided.
 *
 * Needs a dev server with the burner and the game gate OFF (unset), because
 * Vite inlines these at build time:
 *
 *   VITE_BURNER_WALLET=1 VITE_PUBLIC_RPC_URL=http://127.0.0.1:8899 \
 *   VITE_API_URL=http://127.0.0.1:8080 VITE_PRIVY_APP_ID=off \
 *   pnpm --filter @hexvault/web exec vite --port 5192 --strictPort
 *   E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter @hexvault/web exec playwright test bet-flow --project chromium
 */
import { expect, test, type Page } from "playwright/test";

const API = "http://127.0.0.1:8080";
const RPC = "http://127.0.0.1:8899";
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMITMENT = "ab".repeat(32);
const TICKETS = 7_500_000;

const SYSTEM = "11111111111111111111111111111111";
const pool = {
  // The Pool the dev server's default VITE_POOL_ID derives; a bet signs against it only.
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
};

type Stage = "idle" | "open" | "closed" | "settled" | "voided";

interface Script {
  stage: Stage;
  bets: { message: string; signature: string }[];
  tickets: number;
  closeAt: string;
}

function stateFor(script: Script) {
  const now = Math.floor(Date.now() / 1000);
  const betMessage = script.bets.at(-1)?.message ?? "";
  const tiles = /^tiles: (.*)$/m.exec(betMessage)?.[1]?.split(",").map(Number) ?? [];
  const mask = tiles.reduce((acc, tile) => acc | (1n << BigInt(tile)), 0n);
  const mine = script.bets.length > 0 ? [{ roundId: "1", tiles: mask.toString(), stakePerTile: "1000000" }] : [];
  const open = script.stage === "open";
  const finished = script.stage === "closed" || script.stage === "settled" || script.stage === "voided";
  return {
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
    player: {
      owner: "burner",
      principal: "10000000",
      tickets: String(script.tickets),
      epochId: "1",
      isHouse: false,
      pendingWithdraw: "0",
      pendingEpoch: "0",
      pendingDeposit: "0",
      pendingDepositEpoch: "0",
      weight: String(script.tickets),
      pendingTickets: "0",
      pendingActivatesEpoch: null,
      odds: "75.00",
    },
    status: {
      // A live operator and indexer, or the board says OPERATOR PAUSED over the countdown.
      operator: {
        id: 1,
        lastTickAt: new Date().toISOString(),
        nextWakeAt: new Date(Date.now() + 60_000).toISOString(),
        lastAction: null,
        lastError: null,
      },
      cursor: { lastSlot: "1", lastSignature: null, ageSeconds: 1 },
      rpcOk: true,
      slot: 1,
      shutdown: false,
      launchAt: null,
    },
    chainTime: String(now),
    serverTime: String(now),
    priorityFeeMicroLamports: 0,
    launchAt: null,
    nextRoundId: open ? "2" : finished ? "3" : "1",
    // The backend keeps a Round open: right after a close, Round 2 is already open and empty
    // while Round 1 sits in lastRound.
    openRound: open
      ? {
          id: "1",
          openAt: new Date().toISOString(),
          closeAt: script.closeAt,
          status: "open",
          tileTotals: Array.from({ length: 36 }, (_, tile) => (tiles.includes(tile) ? "1000000" : "0")),
          seedCommitment: COMMITMENT,
        }
      : finished
        ? {
            id: "2",
            openAt: new Date().toISOString(),
            closeAt: new Date(Math.floor(Date.now() / 60_000) * 60_000 + 120_000).toISOString(),
            status: "open",
            tileTotals: Array<string>(36).fill("0"),
            seedCommitment: COMMITMENT,
          }
        : null,
    lastRound: finished
      ? {
          id: "1",
          status: script.stage,
          tile: script.stage === "settled" ? tiles[0] : null,
          seedCommitment: COMMITMENT,
        }
      : null,
    positions: open || finished ? mine : [],
  };
}

async function mockBackend(page: Page): Promise<Script> {
  const script: Script = { stage: "idle", bets: [], tickets: TICKETS, closeAt: "" };
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/access/")) return route.fulfill(json({ allowed: true, reason: "" }));
    if (path === "/state") return route.fulfill(json(stateFor(script)));
    if (path === "/feed" || path === "/epochs" || path === "/leaderboard") return route.fulfill(json([]));
    if (path === "/game/sessions/nonce") return route.fulfill(json({ nonce: "nonce1", expiresAt: new Date().toISOString() }));
    if (path === "/game/sessions" && request.method() === "POST") {
      return route.fulfill(json({ id: "session1", expiresAt: new Date(Date.now() + DAY_MS).toISOString() }, 201));
    }
    if (path === "/game/bets" && request.method() === "POST") {
      script.bets.push(request.postDataJSON());
      script.closeAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000).toISOString();
      script.stage = "open";
      script.tickets -= 3_000_000;
      return route.fulfill(json({ roundId: "1", positionId: "1", opened: true, closeAt: script.closeAt, receivedAt: new Date().toISOString() }, 201));
    }
    return route.fulfill(json({ message: "mocked" }, 404));
  });
  await page.route(`${RPC}/**`, (route) => route.abort());
  return script;
}

async function connectBurner(page: Page): Promise<void> {
  const gateConnect = page.getByRole("button", { name: /connect wallet/i });
  const connect = page.getByTestId("connect-button");
  await expect(gateConnect.or(connect).first()).toBeVisible({ timeout: 15_000 });
  if (await gateConnect.isVisible()) await gateConnect.click();
  else await connect.click();
  const burner = page.getByRole("button", { name: /burner/i });
  if (await burner.isVisible({ timeout: 3_000 }).catch(() => false)) await burner.click();
  await expect(page.getByTestId("topbar-tickets")).toBeVisible({ timeout: 15_000 });
}

test("a first bet opens a Round, the board counts down, then DRAWING, the tile and a void", async ({ page }) => {
  const script = await mockBackend(page);
  await page.goto("/#play");
  await connectBurner(page);

  // Idle board: blank, as on dev, and the bet is allowed.
  await expect(page.getByTestId("board-idle-label")).toHaveCount(0);

  await page.getByTestId("tile-3").click();
  await page.getByTestId("tile-7").click();
  await page.getByTestId("tile-12").click();
  await page.getByTestId("deploy").click();

  // The bet text the session key signed: next id, ascending tiles, 1 Ticket a tile.
  await expect.poll(() => script.bets.length).toBe(1);
  const message = script.bets[0]!.message;
  expect(message).toContain("HexVault bet v1");
  expect(message).toContain("round: 1");
  expect(message).toContain("seq: 0");
  expect(message).toContain("tiles: 3,7,12");
  expect(message).toContain("stake: 1000000");

  // The countdown anchors to the server's closeAt.
  await expect(page.getByTestId("round-timer")).toHaveText(/^0[01]:\d\d$/);
  await expect(page.getByTestId("deploy")).toContainText("DEPLOYED");

  // Closed, beacon not out: the next Round is already open, yet the board says DRAWING
  // (no countdown) and the deploy button is shut.
  script.stage = "closed";
  await expect(page.getByTestId("round-timer")).toHaveText("DRAWING");
  await expect(page.getByTestId("deploy")).toContainText("DRAWING…");
  await expect(page.getByTestId("deploy")).toBeDisabled();
  await expect(page.getByTestId("seed-commitment")).toHaveCount(0);

  // No beacon for ten minutes: the Round voids and the stake is back. The board shows
  // nothing of it; the next Round's countdown returns and the button is DEPLOY again.
  script.stage = "voided";
  script.tickets = TICKETS;
  await expect(page.getByTestId("round-timer")).toHaveText(/^\d\d:\d\d$/);
  await expect(page.getByTestId("deploy")).not.toContainText("DRAWING");
  await expect(page.getByTestId("board-idle-label")).toHaveCount(0);
  await expect(page.getByTestId("topbar-tickets")).toContainText("7.50");
});

test("a settled Round lands the tile and pays the winner", async ({ page }) => {
  const script = await mockBackend(page);
  await page.goto("/#play");
  await connectBurner(page);
  await page.getByTestId("tile-3").click();
  await page.getByTestId("tile-7").click();
  await page.getByTestId("tile-12").click();
  await page.getByTestId("deploy").click();
  await expect.poll(() => script.bets.length).toBe(1);

  // The covered tile 3 settles and the ledger pays the stake back plus a share.
  script.stage = "settled";
  script.tickets += 9_000_000;
  await expect(page.getByTestId("win-banner")).toHaveText("TILE 4 WINS", { timeout: 15_000 });
  await expect(page.getByTestId("takeover")).toHaveAttribute("data-title", "YOU WON", { timeout: 15_000 });
  await expect(page.getByTestId("takeover-amount")).toHaveText("+9.00");
});
