/**
 * Ticket 02: stake bar + bet drawer facts that must hold with the burner wallet and
 * a mocked backend (same render path mobile-layout.phone.spec.ts relies on — see
 * that file's header comment). Runs only on the "phone" Playwright project
 * (see playwright.config.ts's testMatch).
 *
 * The desktop-only in-flow `ControlPanel` and the drawer's own copy share
 * the same `data-testid`s once the drawer is open (spec.md "Breakpoint":
 * both are always mounted on the MINE tab, CSS decides which one shows), so
 * every lookup below that could match either instance is scoped through
 * `page.getByTestId("bet-drawer")` first.
 */
import { expect, type Page } from "playwright/test";

import { test } from "./admitted";

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("stake-bar").click();
  await expect(page.getByTestId("bet-drawer")).toBeVisible();
}

test.describe("phone stake bar and bet drawer, mocked backend", () => {
  test("the control panel is hidden until the stake bar is tapped", async ({
    page,
  }) => {
    await page.goto("/#play");
    await expect(page.getByTestId("tile-0")).toBeVisible();

    // Mounted (spec.md "Breakpoint" exception) but not visible.
    await expect(page.getByTestId("stake-bar")).toBeVisible();
    await expect(page.getByTestId("control-panel")).toHaveCount(1);
    await expect(page.getByTestId("control-panel")).not.toBeVisible();
    await expect(page.getByTestId("bet-drawer")).toHaveCount(0);

    await openDrawer(page);
    await expect(
      page.getByTestId("bet-drawer").getByTestId("control-panel"),
    ).toBeVisible();
  });

  test("closes on backdrop tap", async ({ page }) => {
    await page.goto("/#play");
    await openDrawer(page);

    // click({ position }) with { force: true } would still target the
    // overlay's own box; a plain click at the overlay's top, away from the
    // sheet, lands on the dimmed board (spec.md "Drawer": "tap the backdrop").
    await page.getByTestId("bet-drawer-overlay").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/#play");
    await openDrawer(page);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
  });

  test("a Tile tap through the open drawer does not change the Tile count", async ({
    page,
  }) => {
    await page.goto("/#play");
    const tileCount = page.getByTestId("bet-drawer").getByTestId("tile-count");

    await openDrawer(page);
    const before = await tileCount.innerText();

    // The backdrop sits above the board at this point (spec.md "Drawer":
    // "the board locked while the drawer is open"); force through
    // Playwright's actionability check so the click still dispatches at
    // tile-0's coordinates, and let the browser's real hit-test decide who
    // receives it.
    await page.getByTestId("tile-0").click({ force: true, timeout: 5_000 });

    await expect(page.getByTestId("bet-drawer")).toBeVisible();
    await expect(tileCount).toHaveText(before);
  });

  test("LAST WIN tab swaps the deploy form for the miner feed, and reopening resets to DEPOSIT", async ({
    page,
  }) => {
    await page.goto("/#play");
    await openDrawer(page);
    const drawer = page.getByTestId("bet-drawer");

    await expect(drawer.getByTestId("deploy")).toBeVisible();
    await expect(drawer.getByTestId("miner-feed")).toHaveCount(0);

    await drawer.getByTestId("drawer-tab-lastwin").click();
    await expect(drawer.getByTestId("miner-feed")).toBeVisible();
    await expect(drawer.getByTestId("deploy")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bet-drawer")).toHaveCount(0);
    await openDrawer(page);
    await expect(
      page.getByTestId("bet-drawer").getByTestId("drawer-tab-deposit"),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("the page behind does not scroll while the drawer is open", async ({
    page,
  }) => {
    await page.goto("/#play");
    await openDrawer(page);

    // mouse.wheel isn't supported on mobile WebKit (the "phone" project);
    // window.scrollTo is a plain JS call and works everywhere, so it drives
    // the same "did the page move" check the wheel gesture would.
    const before = await page.evaluate(() => window.scrollY);
    const after = await page.evaluate(() => {
      window.scrollTo(0, 400);
      return window.scrollY;
    });
    expect(after).toBe(before);
  });
});
