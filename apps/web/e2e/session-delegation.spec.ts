/**
 * Off-chain tickets ticket 15: session delegation through the bet drawer, with
 * the dev burner as the wallet. No chain, no backend: every API call is
 * answered by `page.route`, and the mock records what the web posted.
 *
 * The burner signs without a popup, so "the wallet was prompted" is counted as
 * "a delegation was posted". Needs a dev server with the burner and the game
 * gate OFF (unset), because Vite inlines these at build time. Use a port of
 * your own and point E2E_BASE_URL at it:
 *
 *   VITE_BURNER_WALLET=1 VITE_PUBLIC_RPC_URL=http://127.0.0.1:8899 \
 *   VITE_API_URL=http://127.0.0.1:8080 VITE_PRIVY_APP_ID=off \
 *   pnpm --filter @hexvault/web exec vite --port 5191 --strictPort
 *   E2E_BASE_URL=http://127.0.0.1:5191 pnpm --filter @hexvault/web exec playwright test session-delegation
 */
import { createPublicKey, verify } from "node:crypto";

import { utils } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { expect, test, type Page } from "playwright/test";

const API = "http://127.0.0.1:8080";
const RPC = "http://127.0.0.1:8899";
const DAY_MS = 24 * 60 * 60 * 1000;

// The drawer and stake bar only show under 960px.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

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
  player: {
    owner: "burner",
    principal: "10000000",
    tickets: "0",
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
  priorityFeeMicroLamports: 0,
  launchAt: null,
};

interface Recorded {
  nonces: number;
  sessions: { message: string; signature: string }[];
  revokes: { id: string; time: number; signature: string }[];
}

async function mockBackend(page: Page): Promise<Recorded> {
  const seen: Recorded = { nonces: 0, sessions: [], revokes: [] };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/access/")) return route.fulfill(json({ allowed: true, reason: "" }));
    if (path === "/state") return route.fulfill(json(state));
    if (path === "/feed" || path === "/epochs" || path === "/leaderboard") return route.fulfill(json([]));
    if (path === "/game/sessions/nonce") {
      seen.nonces += 1;
      return route.fulfill(json({ nonce: `nonce${seen.nonces}`, expiresAt: new Date().toISOString() }));
    }
    if (path === "/game/sessions" && request.method() === "POST") {
      seen.sessions.push(request.postDataJSON());
      return route.fulfill(
        json({ id: `session${seen.sessions.length}`, expiresAt: new Date(Date.now() + DAY_MS).toISOString() }, 201),
      );
    }
    if (/^\/game\/sessions\/[^/]+\/revoke$/.test(path)) {
      seen.revokes.push({ id: path.split("/")[3]!, ...request.postDataJSON() });
      return route.fulfill(json({ id: "x", revokedAt: new Date().toISOString() }, 201));
    }
    return route.fulfill(json({ message: "mocked" }, 404));
  });
  // Balance, genesis and fee reads fail fast; none of them feed what is checked here.
  await page.route(`${RPC}/**`, (route) => route.abort());
  return seen;
}

// The topbar hides the Tickets chip at phone width, so "connected" is the
// address pill: its title becomes "Copy <address>".
async function connectBurner(page: Page): Promise<void> {
  const gateConnect = page.getByRole("button", { name: /connect wallet/i });
  const pill = page.getByTestId("connect-button");
  await expect(gateConnect.or(pill).first()).toBeVisible({ timeout: 15_000 });
  const gated = await gateConnect.isVisible();
  const connected = !gated && ((await pill.getAttribute("title"))?.startsWith("Copy ") ?? false);
  if (!connected) {
    if (gated) await gateConnect.click();
    else await pill.click();
    const burner = page.getByRole("button", { name: /burner/i });
    if (await burner.isVisible({ timeout: 3_000 }).catch(() => false)) await burner.click();
  }
  await expect(pill).toHaveAttribute("title", /^Copy /, { timeout: 15_000 });
}

async function openPlay(page: Page): Promise<void> {
  await page.goto("/#play");
  await connectBurner(page);
  await expect(page.getByTestId("stake-bar")).toBeVisible();
}

const openDrawer = async (page: Page): Promise<void> => {
  await page.getByTestId("stake-bar").click();
  await expect(page.getByTestId("bet-drawer")).toBeVisible();
};

const closeDrawer = async (page: Page): Promise<void> => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
};

/** The burner's wallet address is the second line of the posted message. */
const walletOf = (message: string): string => message.split("\n")[1]!;

const sessionKey = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).find((key) => key.startsWith("hexvault.session.v1.")) ?? null);

test("a fresh wallet is prompted once, a reload is not, the five-minute rule and Revoke prompt again", async ({ page }) => {
  const seen = await mockBackend(page);
  await openPlay(page);

  // Fresh wallet: opening the drawer asks for one delegation.
  await openDrawer(page);
  await expect.poll(() => seen.sessions.length).toBe(1);
  await expect(page.getByTestId("session-revoke")).toBeVisible();
  const [first] = seen.sessions;
  expect(first!.message).toContain("Nonce: nonce1");
  expect(first!.message).toContain(`URI: ${new URL(page.url()).origin}`);

  // The signature is the wallet's, over the raw bytes of the text it showed.
  const x = Buffer.from(new PublicKey(walletOf(first!.message)).toBytes()).toString("base64url");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  const signature = Buffer.from(utils.bytes.bs58.decode(first!.signature));
  expect(verify(null, Buffer.from(first!.message, "utf8"), key, signature)).toBe(true);

  // Reopening the drawer does not prompt.
  await closeDrawer(page);
  await openDrawer(page);
  await page.waitForTimeout(300);
  expect(seen.sessions).toHaveLength(1);

  // A reload within 24 hours does not prompt either.
  await closeDrawer(page);
  await page.reload();
  await connectBurner(page);
  await openDrawer(page);
  await page.waitForTimeout(300);
  expect(seen.sessions).toHaveLength(1);

  // Under five minutes left: the next open prompts.
  await closeDrawer(page);
  await page.evaluate(() => {
    const name = Object.keys(localStorage).find((k) => k.startsWith("hexvault.session.v1."))!;
    const stored = JSON.parse(localStorage.getItem(name)!);
    stored.expiresAt = Date.now() + 4 * 60 * 1000;
    localStorage.setItem(name, JSON.stringify(stored));
  });
  await openDrawer(page);
  await expect.poll(() => seen.sessions.length).toBe(2);

  // Revoke sends the signed revoke and clears the key.
  await page.getByTestId("session-revoke").click();
  await expect.poll(() => seen.revokes.length).toBe(1);
  expect(seen.revokes[0]!.id).toBe("session2");
  await expect.poll(() => sessionKey(page)).toBeNull();
  await expect(page.getByTestId("session-revoke")).toHaveCount(0);

  // The next open prompts again.
  await closeDrawer(page);
  await openDrawer(page);
  await expect.poll(() => seen.sessions.length).toBe(3);
});

test("a wallet that cannot sign messages sees the Ledger copy and no prompt", async ({ page }) => {
  // The stock Ledger adapter has no signMessage. Serve the burner without one.
  await page.route("**/src/dev-burner.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("async signMessage(", "async signMessageRemoved(");
    await route.fulfill({ response, body });
  });
  const seen = await mockBackend(page);
  await openPlay(page);

  await expect(page.getByTestId("ledger-copy")).toContainText("cannot sign messages");
  await expect(page.getByTestId("stake-bar")).toBeDisabled();
  await page.getByTestId("stake-bar").click({ force: true }).catch(() => undefined);
  await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
  expect(seen.nonces).toBe(0);
  expect(seen.sessions).toHaveLength(0);
});
