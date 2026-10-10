/**
 * Ops console Game config form (off-chain-tickets ticket 14). Needs no
 * backend and no validator: the API answers come from page.route, and the
 * wallet is a minimal Wallet Standard wallet injected before the page loads.
 * The ops page registers no wallets of its own, so a standard wallet that
 * announces itself is the only way to connect one.
 */
import { Keypair } from "@solana/web3.js";
import { expect, test, type Page } from "playwright/test";

test.use({ viewport: { width: 1280, height: 900 } });

const TEAM = Keypair.generate();

const FIELDS = {
  roundSeconds: 60,
  houseCutBps: 600,
  ticketsPerUsdc: 10,
  bonusCapBps: 500,
  referralTiers: [
    { tier: 4, min: 11, max: null, rateBps: 500 },
    { tier: 1, min: 1, max: 10, rateBps: 200 },
  ],
  maxTilesPerBet: 36,
};
const SEED = { id: 1, poolAddress: "P", ...FIELDS, signer: null, signature: null, message: null, createdAt: "2026-10-08T00:00:00.000Z" };

async function installWallet(page: Page, signedMessages: string[]): Promise<void> {
  await page.exposeFunction("recordSigned", (text: string) => signedMessages.push(text));
  await page.addInitScript(
    ({ address, publicKey }) => {
      localStorage.setItem("walletName", JSON.stringify("Mock Team"));
      const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ["solana:devnet", "solana:mainnet", "solana:localnet"],
        features: ["solana:signMessage"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Mock Team",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        chains: account.chains,
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: async () => [] },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async (...inputs: { message: Uint8Array }[]) => {
              const out = [];
              for (const input of inputs) {
                await (window as unknown as { recordSigned: (t: string) => Promise<void> }).recordSigned(
                  new TextDecoder().decode(input.message),
                );
                out.push({ signedMessage: input.message, signature: new Uint8Array(64).fill(1) });
              }
              return out;
            },
          },
        },
      };
      const register = (api: { register: (w: unknown) => void }) => api.register(wallet);
      window.addEventListener("wallet-standard:app-ready", (e) => register((e as CustomEvent).detail));
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", { detail: register, bubbles: false, cancelable: false }),
      );
    },
    { address: TEAM.publicKey.toBase58(), publicKey: [...TEAM.publicKey.toBytes()] },
  );
}

async function mockApi(page: Page, change: { status: number; body: unknown }, posted: unknown[]): Promise<void> {
  await page.route("**/game/config", (route) =>
    route.fulfill({ json: { inForce: SEED, history: [SEED] } }),
  );
  await page.route("**/ops/game-config", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: change.status, json: change.body });
  });
}

test("the form fills the row in force, signs with the wallet and shows the stored row", async ({ page }) => {
  const signed: string[] = [];
  const posted: Record<string, unknown>[] = [];
  await installWallet(page, signed);
  const stored = { ...SEED, id: 2, houseCutBps: 700, signer: TEAM.publicKey.toBase58() };
  await mockApi(page, { status: 201, body: stored }, posted);

  await page.goto("/ops");
  const section = page.getByTestId("section-advanced");
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator("summary").click();

  await expect(page.getByTestId("game-config-state")).toContainText("the seed row");
  await expect(page.getByTestId("game-config-houseCutBps")).toHaveValue("600");
  await expect(page.getByTestId("game-config-submit")).toBeEnabled();

  await page.getByTestId("game-config-houseCutBps").fill("700");
  await page.getByTestId("game-config-submit").click();

  await expect(page.getByTestId("game-config-done")).toContainText("Applied as change 2");
  await expect(page.getByTestId("game-config-done")).toContainText("house cut 700 bps");
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatch(/^HexVault game-config \S+ \d+ \{"roundSeconds":60,"houseCutBps":700,/);
  expect(posted[0]).toMatchObject({ wallet: TEAM.publicKey.toBase58(), fields: { houseCutBps: 700 } });
});

test("a wallet off the list sees the refusal copy", async ({ page }) => {
  const posted: unknown[] = [];
  await installWallet(page, []);
  await mockApi(page, { status: 403, body: { code: "WalletNotListed", message: "no" } }, posted);

  await page.goto("/ops");
  const section = page.getByTestId("section-advanced");
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator("summary").click();
  await page.getByTestId("game-config-submit").click();

  await expect(page.getByTestId("game-config-error")).toHaveText("This wallet is not on the list.");
  await expect(page.getByTestId("game-config-done")).toHaveCount(0);
});
