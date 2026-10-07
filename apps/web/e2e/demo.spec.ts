/**
 * PRD §9 demo loop, end to end: faucet, deposit, play a round, settle, and
 * withdraw. See docs/product-requirements.md §9.
 *
 * The withdrawal is one `request_withdraw` (ADR 0020): the part still pending
 * from today's deposit refunds in the same transaction and any rest queues.
 * The demo deposits and withdraws on the same day, so the whole amount is a
 * pending deposit and pays at once. The queued path, its pending row and the
 * "pay out now" button are covered by the program's localnet suite, which can
 * cross an epoch boundary at will.
 *
 * Base URL: E2E_BASE_URL, default http://127.0.0.1:5173 (see
 * playwright.config.ts). Ticket 12 has not deployed anything yet, so there is
 * no live URL to default to. Point E2E_BASE_URL at the Vercel URL the
 * moment it exists; nothing else in this file changes.
 *
 * Wallet: this drives the app's dev burner wallet (src/dev-burner.ts),
 * `VITE_BURNER_WALLET=1` against a local RPC. That path exists specifically
 * for "automated browser testing" per its own doc comment. It requires a
 * full local stack behind the page: a local validator with the program
 * deployed, the backend (indexer + operator + api) pointed at it, and the
 * frontend's own env pointed at both. `docs/plan/rebuild/progress.md`
 * "Running the localnet suite" covers the validator half.
 *
 * ponytail: the eventual live run (against Vercel, once ticket 12 lands)
 * won't have a local RPC, so the burner wallet's gate (src/dev-burner.ts
 * isLocalRpc) disables it there and the app falls back to Privy. This spec
 * does not drive a Privy login. That needs Privy's own test-mode
 * configuration (a guest/test login path), which is a human/product decision
 * this ticket wasn't scoped to make. Ceiling: this spec only runs
 * unattended against a local stack. Upgrade path: once 12 lands and Privy
 * test mode is decided, add a connectPrivyTestWallet() alongside
 * connectBurnerWallet() and branch on whether VITE_PRIVY_APP_ID is set.
 *
 * Not verified end to end: standing up the local validator, program,
 * backend and frontend together was out of scope for this pass (see ticket
 * 13's `## Comments`). Only `playwright test --list` proved this file
 * compiles and the test is discovered.
 */
import { expect, test, type Page } from "playwright/test";

/** Round length the target pool is running, for the settle-wait budget. Matches spec.md §7's 90s default; override for a faster demo pool (see the runbook's "changing epoch length" recipe, which also covers --round-seconds). */
const ROUND_SECONDS = Number(process.env.E2E_ROUND_SECONDS ?? 90);
const VRF_TIMEOUT_SECONDS = Number(process.env.E2E_VRF_TIMEOUT_SECONDS ?? 120);
/** Generous: a round can void and retry once before ORAO answers. */
const SETTLE_TIMEOUT_MS = (ROUND_SECONDS + VRF_TIMEOUT_SECONDS + 60) * 1000;

async function connectBurnerWallet(page: Page): Promise<void> {
  await page.goto("/#play");
  // The invite gate (AccessGate.tsx) covers the app until a wallet with
  // access connects; the burner needs an InviteRedemption row in the backend.
  const gateConnect = page.getByRole("button", { name: /connect wallet/i });
  const navConnect = page.getByTestId("connect-button");
  await expect(gateConnect.or(navConnect).first()).toBeVisible({ timeout: 15_000 });
  await ((await gateConnect.isVisible()) ? gateConnect : navConnect).click();
  // Standard wallet-adapter-react-ui modal. With VITE_BURNER_WALLET=1 and a
  // local RPC (see src/dev-burner.ts's isLocalRpc gate), the burner is the
  // only entry in the list.
  const burnerOption = page.getByRole("button", { name: /burner/i });
  if (await burnerOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await burnerOption.click();
  }
  // Connected: the pill carries `Copy <address>` and opens the wallet menu.
  await expect(page.getByTestId("connect-button")).toHaveAttribute(
    "title",
    /^Copy /,
    { timeout: 15_000 },
  );
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("disconnect-button")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wallet-menu")).toHaveCount(0);
}

function parseAfterLabel(text: string, label: string): number {
  const match = new RegExp(`${label}\\s+([\\d.]+)`).exec(text);
  if (!match) {
    throw new Error(`could not find "${label}" in "${text}"`);
  }
  return Number(match[1]);
}

/** Clicks a tile until it reports selected. Tiles only respond once an open round is in its "mine" phase (see src/App.tsx's canPick). */
async function selectTile(page: Page, tileNumber: number): Promise<void> {
  const tile = page.getByTestId(`tile-${tileNumber}`);
  await expect(async () => {
    await tile.click();
    await expect(tile).toHaveAttribute("data-selected", "1");
  }).toPass({ timeout: 90_000 });
}

test("faucet, deposit, play a round, settle, withdraw", async ({
  page,
}) => {
  await connectBurnerWallet(page);

  // 1. Faucet. Rate-limited is not a failure here (see api.ts's FaucetResult).
  // ponytail: the burner wallet is a fixed keypair, so a repeat run against
  // the same backend can legitimately hit the per-owner cooldown while
  // already holding USDC from a previous run. This does not fix
  // repeatability properly; upgrade path is a fresh keypair per run, or a
  // backend reset endpoint, whichever ticket ends up owning CI for this spec.
  // The faucet lives in the wallet menu under the address pill. A
  // mainnet-shaped cluster (the surf fork) has none; `scripts/surf.sh fund`
  // pre-funds the burner there instead.
  await page.getByTestId("connect-button").click();
  const faucet = page.getByTestId("faucet");
  if (await faucet.isVisible().catch(() => false)) {
    await faucet.click();
    await expect(faucet).toHaveText(/Sent|Faucet in \d+s/, { timeout: 30_000 });
  }
  await page.keyboard.press("Escape");
  // EARN lands on the dashboard; the deposit widget is one hop further in.
  await page.getByTestId("tab-dashboard").click();
  await page.getByTestId("dash-deposit").click();

  // 2. Deposit 100 USDC.
  await page.getByTestId("deposit-input").fill("100");
  const depositSubmit = page.getByTestId("deposit-submit");
  await expect(depositSubmit).toBeEnabled({ timeout: 15_000 });
  await depositSubmit.click();
  await expect(page.getByTestId("deposit-modal-amount")).toContainText("100.00", {
    timeout: 30_000,
  });
  await page.getByTestId("deposit-modal-ok").click();
  await expect(page.getByTestId("deposit-modal")).toHaveCount(0);

  // 3. Buy a position on 3 tiles.
  await page.getByTestId("tab-mine").click();
  const entriesBefore = parseAfterLabel(
    await page.getByTestId("wallet-entries").innerText(),
    "Tickets",
  );
  await page.getByTestId("stake-input").fill("1");
  await selectTile(page, 0);
  await selectTile(page, 1);
  await selectTile(page, 2);
  await expect(page.getByTestId("tile-count")).toHaveText("3");

  const deployButton = page.getByTestId("deploy");
  await expect(deployButton).toBeEnabled({ timeout: 10_000 });
  await deployButton.click();
  await expect(page.getByTestId("deploy-note")).toBeVisible({ timeout: 30_000 });

  // 4. Wait for the round to settle, then settle this position.
  await expect(page.getByTestId("reward-hint")).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
  await page.getByTestId("settle-position").click();
  await expect(page.getByTestId("deploy-note")).toContainText(/settled/i, {
    timeout: 30_000,
  });

  // 5. Entries changed (buying a position always spends some, win or lose).
  const entriesAfter = parseAfterLabel(
    await page.getByTestId("wallet-entries").innerText(),
    "Tickets",
  );
  expect(entriesAfter).not.toBe(entriesBefore);

  // The dashboard's Withdraw button opens the widget already on that tab.
  await page.getByTestId("tab-dashboard").click();
  await page.getByTestId("dash-withdraw").click();
  // The ceiling is Principal less anything already queued.
  const shownWithdrawable = parseAfterLabel(
    await page.getByTestId("withdrawable-now").innerText(),
    "Available to withdraw:",
  );
  expect(shownWithdrawable).toBeGreaterThan(0);

  // 6. Withdraw that much. Today's deposit never held a Ticket, so the form
  // says it pays now and the USDC lands in the wallet.
  await page.getByTestId("withdraw-input").fill(String(shownWithdrawable));
  await expect(page.getByTestId("withdraw-expected")).toContainText("Now");
  const withdrawSubmit = page.getByTestId("withdraw-submit");
  await expect(withdrawSubmit).toBeEnabled();
  await withdrawSubmit.click();
  await expect(page.getByTestId("vault-note")).toContainText(/withdraw requested/i, {
    timeout: 30_000,
  });
});
