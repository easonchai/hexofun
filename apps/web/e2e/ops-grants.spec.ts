/**
 * Ops console grant form (off-chain-tickets ticket 23). Same setup as
 * ops-game-config.spec.ts: the API answers come from page.route and the wallet
 * is a minimal Wallet Standard wallet injected before the page loads.
 */
import { Keypair } from "@solana/web3.js";
import { expect, test, type Page } from "playwright/test";

test.use({ viewport: { width: 1280, height: 900 } });

const TEAM = Keypair.generate();
const TARGET = Keypair.generate().publicKey.toBase58();

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

async function openForm(page: Page, reply: { status: number; body: unknown }, posted: unknown[]): Promise<void> {
  await page.route("**/ops/grants", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: reply.status, json: reply.body });
  });
  await page.goto("/ops");
  const section = page.getByTestId("section-advanced");
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator("summary").click();
  await page.getByTestId("grant-wallet").fill(TARGET);
  await page.getByTestId("grant-amount").fill("500");
  await page.getByTestId("grant-reason").fill("launch bonus");
}

test("the form signs the grant with the wallet and shows the stored row", async ({ page }) => {
  const signed: string[] = [];
  const posted: Record<string, unknown>[] = [];
  await installWallet(page, signed);
  const row = { id: "12", owner: TARGET, delta: "500", ref: "launch bonus", signer: TEAM.publicKey.toBase58() };
  await openForm(page, { status: 201, body: row }, posted);

  await expect(page.getByTestId("grant-submit")).toBeEnabled();
  await page.getByTestId("grant-submit").click();

  await expect(page.getByTestId("grant-done")).toContainText("Booked ledger row 12: 500 Tickets");
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatch(new RegExp(`^HexVault grant \\S+ ${TARGET} 500 launch bonus \\d+$`));
  expect(posted[0]).toMatchObject({ wallet: TARGET, amount: 500, reason: "launch bonus", signer: TEAM.publicKey.toBase58() });
});

test("a wallet off the list sees the refusal copy", async ({ page }) => {
  await installWallet(page, []);
  await openForm(page, { status: 403, body: { code: "WalletNotListed", message: "no" } }, []);
  await page.getByTestId("grant-submit").click();

  await expect(page.getByTestId("grant-error")).toHaveText("This wallet is not on the list.");
  await expect(page.getByTestId("grant-done")).toHaveCount(0);
});
