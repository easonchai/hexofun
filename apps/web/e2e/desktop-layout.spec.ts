/**
 * Ticket 01: proves the mobile media query (max-width: 960px) leaves
 * desktop untouched. Runs on the "chromium" project. Burner wallet, mocked backend:
 * same board render this spec's sibling mobile-layout.spec.ts relies on.
 */
import { expect } from "playwright/test";

import { test } from "./admitted";

// Wide and tall enough to clear the pre-existing, unrelated
// `(min-width: 961px) and (max-height: ...)` short-screen overrides
// further down styles.css, so this only exercises the plain >960px case.
test.use({ viewport: { width: 1280, height: 900 } });

test("board scale and hexpot placement are unchanged above 960px", async ({ page }) => {
  await page.goto("/#play");
  await expect(page.getByTestId("tile-0")).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(viewport!.width).toBeGreaterThan(960);

  const stageBox = await page.locator(".hex-stage-container").boundingBox();
  expect(stageBox).not.toBeNull();
  // Desktop's unchanged transform is `scale(0.82)` on a 620x600 design box.
  expect(stageBox!.width).toBeCloseTo(620 * 0.82, 0);
  expect(stageBox!.height).toBeCloseTo(600 * 0.82, 0);

  // Desktop keeps the hexpot pill absolutely positioned just under the
  // hexagon's bottom edge (`bottom: -40px`, ~5px gap once scaled), not
  // pushed further down into flow the way the mobile override places it.
  const hexpotBox = await page.getByTestId("round-pot-pill").boundingBox();
  expect(hexpotBox).not.toBeNull();
  const gap = hexpotBox!.y - (stageBox!.y + stageBox!.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(20);
});

// Ticket 02: the stake bar and the bet drawer are phone-only.
test("no stake bar and no drawer render above 960px", async ({ page }) => {
  await page.goto("/#play");
  await expect(page.getByTestId("tile-0")).toBeVisible();

  // Mounted unconditionally on the MINE tab and hidden by CSS above 960px
  // (spec.md "Breakpoint"), so it exists in the DOM but must not be visible.
  await expect(page.getByTestId("stake-bar")).toBeAttached();
  await expect(page.getByTestId("stake-bar")).not.toBeVisible();

  // The drawer only mounts once opened; nothing on desktop can open it
  // (the trigger is the invisible stake bar), so it must never appear.
  await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
  await expect(page.getByTestId("bet-drawer-overlay")).toHaveCount(0);
});
