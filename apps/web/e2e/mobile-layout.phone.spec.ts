/**
 * Ticket 01: phone layout facts that must hold with no real backend. Runs
 * only on the "phone" Playwright project (see playwright.config.ts's
 * testMatch), so it never runs against desktop chromium.
 *
 * The app mounts only past the invite gate, so `test` from ./admitted loads
 * each page with the dev burner connected and an idle mocked backend. The
 * arena (36 tiles + the hexpot ticker) renders from that; no live stack.
 */
import { expect, type Page } from "playwright/test";

import { test } from "./admitted";

/** Ticket 01: Tiles 1, 6, 7, 12, 13, 18, 19, 24, 25, 30, 31, 36 (display
 * numbers), zero-indexed as tile-{n} testids. */
const EDGE_TILE_TESTIDS = [
  "tile-0",
  "tile-5",
  "tile-6",
  "tile-11",
  "tile-12",
  "tile-17",
  "tile-18",
  "tile-23",
  "tile-24",
  "tile-29",
  "tile-30",
  "tile-35",
];

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBe(viewportWidth);
}

/**
 * Nothing may sit unreachable below the fold. Two things make that true and
 * neither is a document-level scroll, so asserting `scrollHeight >
 * clientHeight` on the document would be wrong on every tab:
 *
 * - MINE is deliberately exactly one viewport tall once the bet panel moves
 *   into the drawer (ticket 02). There is nothing below its fold to reach.
 * - The other tabs, ABOUT's `.about` among them, are absolutely positioned
 *   over the split container and scroll internally. Their content never
 *   contributes to document height.
 *
 * What the shell fix has to guarantee is that the split container still gets
 * a real height under 960px, so that internal scroller has room. If `.app`
 * or `#root` clipped it back to zero, ABOUT's copy would be unreachable.
 */
async function assertLongTabContentIsReachable(page: Page): Promise<void> {
  await page.goto("/#about");
  const screen = page.locator(".about");
  await expect(screen).toBeVisible();
  const scrolled = await screen.evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight) return null;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, "ABOUT is not taller than its container, nothing to scroll").not.toBeNull();
  expect(scrolled ?? 0).toBeGreaterThan(0);
}

async function assertFullyInViewport(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} has no box (not rendered)`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1); // +1: subpixel rounding
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
}

async function assertLayoutFacts(page: Page): Promise<void> {
  await assertNoHorizontalOverflow(page);
  for (const testId of EDGE_TILE_TESTIDS) {
    await assertFullyInViewport(page, testId);
  }
  await assertFullyInViewport(page, "round-pot-pill");
}

test.describe("phone layout: MINE tab, no wallet, no backend", () => {
  test("fits at the phone project's default viewport", async ({ page }) => {
    await page.goto("/#play");
    await expect(page.getByTestId("tile-0")).toBeVisible();
    await assertLayoutFacts(page);
  });

  test("still fits at a 320px viewport", async ({ page }) => {
    await page.goto("/#play");
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(page.getByTestId("tile-0")).toBeVisible();
    await assertLayoutFacts(page);
  });

  test("a tab longer than the screen stays reachable by scrolling", async ({
    page,
  }) => {
    // A hash-only goto after /#play is a same-document navigation and the
    // app only reads the hash on mount, so load ABOUT directly.
    await assertLongTabContentIsReachable(page);
  });
});
