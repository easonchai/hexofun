/**
 * Ticket 07 / spec.md "One end-to-end test asserts the network boundary":
 * the regression test for ticket 01's key exposure and for "the Indexer is
 * the browser's read model" more broadly. No wallet, no backend needed for
 * this to be meaningful: with nothing connected, the browser has zero
 * legitimate reason to contact any Solana RPC host at all, since the sole
 * surviving direct chain read (the connected wallet's own token balance)
 * never fires without a connected wallet (see src/read.ts `useWalletBalance`).
 * A regression that reintroduces a chain read into a component — the exact
 * failure mode this ticket removes — shows up here as a request to one of
 * the hosts below, whether or not it is the one the app is configured for.
 *
 * The app mounts only past the invite gate, so "no wallet" is the gate on
 * screen: the page loads, the gate shows, and no RPC host is contacted. The
 * wallet's own balance read stays out of scope (see below).
 *
 * Checked against known RPC provider domains rather than one specific
 * configured host, so this holds regardless of which endpoint `.env`/
 * `.env.local` points at, and against both a local dev server and a
 * deployed URL (E2E_BASE_URL) per playwright.config.ts.
 *
 * What this does NOT cover: that a *connected* wallet's balance read lands
 * on the public endpoint specifically, rather than some other RPC host —
 * that needs a signed-in wallet, which needs a local validator (see
 * demo.spec.ts), unavailable in this run.
 */
import { expect, test } from "playwright/test";

/** Hostname fragments seen in real Solana RPC providers, keyed or public. A
 *  chain read reintroduced into a component would show up as a request to
 *  one of these (or the local validator's JSON-RPC port, covered by the
 *  generic "solana" fragment matching clusterApiUrl hosts too). */
const RPC_HOST_FRAGMENTS = [
  "solana.com",
  "helius",
  "alchemy.com",
  "quicknode",
  "ankr.com",
  "syndica.io",
  "chainstack.com",
  "getblock.io",
  "triton.one",
  "rpcpool.com",
  "extrnode.com",
];

test("contacts no Solana RPC host while no wallet is connected", async ({ page }) => {
  // Hostnames only, never the full URL: a keyed endpoint carries its key in
  // the path, and a failure message is the last place that should print it.
  const rpcRequests: string[] = [];
  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname.toLowerCase();
    } catch {
      return;
    }
    if (RPC_HOST_FRAGMENTS.some((fragment) => hostname.includes(fragment))) {
      rpcRequests.push(hostname);
    }
  });

  await page.goto("/#play");
  // With no wallet the invite gate (AccessGate.tsx) is all that mounts; the
  // board only appears past it, so the gate is the "nothing connected" state.
  await expect(page.getByTestId("access-gate")).toBeVisible();
  // No event to wait for here — this is an absence check. One state-poll
  // cycle plus margin is enough to catch a chain read hiding in an effect
  // that fires after mount rather than on the first render.
  await page.waitForTimeout(3_000);

  expect(rpcRequests).toEqual([]);
});
