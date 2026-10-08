/**
 * Ops console wallet ledger and epoch snapshot views (off-chain-tickets ticket
 * 25). The backend answers come from page.route, and so does the chain: the
 * Epoch account is a hand-built account for the one `getAccountInfo` the view
 * sends, so no validator is needed.
 */
import { Keypair } from "@solana/web3.js";
import { expect, test, type Page } from "playwright/test";

import { sumTreeRoot } from "../src/ops/sumTree.js";
import idl from "../src/idl/hex_vault.json" with { type: "json" };

test.use({ viewport: { width: 1280, height: 900 } });

async function openAdvanced(page: Page): Promise<void> {
  await page.goto("/ops");
  const section = page.getByTestId("section-advanced");
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator("summary").click();
}

test("the wallet ledger pages through 1,000 rows, newest first", async ({ page }) => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const asked: string[] = [];
  await page.route("**/players/*/ledger*", async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search);
    const before = Number(url.searchParams.get("before") ?? 1_001);
    const rows = Array.from({ length: 100 }, (_, i) => before - 1 - i).map((id) => ({
      id: String(id), epochId: "6", reason: "buy", delta: "1", ref: `row-${id}`, signer: null, signature: null, createdAt: "2026-10-08T00:00:00.000Z",
    }));
    await route.fulfill({ json: { rows, nextBefore: before - 100 > 1 ? String(before - 100) : null } });
  });
  await openAdvanced(page);
  await page.getByTestId("ledger-wallet").fill(wallet);
  await page.getByTestId("ledger-load").click();
  await expect(page.getByTestId("ledger-count")).toContainText("100 rows loaded");
  await expect(page.getByTestId("ledger-rows").locator("tbody tr").first()).toContainText("row-1000");

  for (let n = 200; n <= 1_000; n += 100) {
    await page.getByTestId("ledger-more").click();
    await expect(page.getByTestId("ledger-count")).toContainText(`${n} rows loaded`);
  }
  await expect(page.getByTestId("ledger-count")).toContainText("the whole ledger");
  await expect(page.getByTestId("ledger-more")).toHaveCount(0);
  expect(asked).toHaveLength(10);
});

// Epoch account layout: 8-byte discriminator, then the fields in IDL order.
const EPOCH_ROOT_OFFSET = 151;
const EPOCH_SIZE = 215;

async function serveSnapshotAndChain(page: Page, chainRoot: (root: string) => string): Promise<string> {
  const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey].sort((a, b) =>
    Buffer.compare(a.toBuffer(), b.toBuffer()),
  );
  const leaves = owners.map((o, index) => ({ index, owner: o.toBase58(), tickets: String(10 * (index + 1)), reasons: { reset: String(10 * (index + 1)) } }));
  const root = (await sumTreeRoot(owners.map((o, i) => ({ wallet: o.toBytes(), tickets: BigInt(10 * (i + 1)) })))) as string;
  await page.route("**/epochs/6/snapshot*", (route) =>
    route.fulfill({ json: { epochId: "6", root, depth: 2, leafCount: 3, totalTickets: "60", leaves, nextIndex: null } }),
  );
  const data = Buffer.alloc(EPOCH_SIZE);
  data.set(idl.accounts.find((a) => a.name === "Epoch")?.discriminator ?? [], 0);
  Buffer.from(chainRoot(root), "hex").copy(data, EPOCH_ROOT_OFFSET);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? request.postData() : null;
    if (!body?.includes("getAccountInfo")) return route.fallback();
    const { id } = JSON.parse(body) as { id: number };
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: 1 },
          value: { data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner: idl.address, rentEpoch: 0, space: EPOCH_SIZE },
        },
      },
    });
  });
  return root;
}

test("the snapshot view is green when the leaves hash to the chain's root", async ({ page }) => {
  const root = await serveSnapshotAndChain(page, (served) => served);
  await openAdvanced(page);
  await page.getByTestId("snapshot-epoch").fill("6");
  await page.getByTestId("snapshot-check").click();

  await expect(page.getByTestId("snapshot-verdict")).toHaveAttribute("data-verdict", "match");
  await expect(page.getByTestId("panel-snapshot")).toContainText(root);
});

test("the snapshot view is red when the chain's root differs, as a stale epoch's does", async ({ page }) => {
  await serveSnapshotAndChain(page, () => "cd".repeat(32));
  await openAdvanced(page);
  await page.getByTestId("snapshot-epoch").fill("6");
  await page.getByTestId("snapshot-check").click();

  await expect(page.getByTestId("snapshot-verdict")).toHaveAttribute("data-verdict", "mismatch");
  await expect(page.getByTestId("snapshot-verdict")).toContainText("Mismatch");
});
