/**
 * Ticket 03: the phone topbar fits the screen. Runs only on the "phone"
 * Playwright project (see playwright.config.ts's testMatch), so it never
 * runs against desktop chromium. Burner wallet, mocked backend: same
 * rationale as mobile-layout.phone.spec.ts, this only asserts on layout.
 */
import { expect, type Page } from "playwright/test";

import { test } from "./admitted";

const TAB_TESTIDS = ["tab-dashboard", "tab-mine"];

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBe(viewportWidth);
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

/**
 * Being inside the viewport is not enough. The tab strip is a scroll
 * container, so a tab scrolled past its right edge still reports a
 * bounding box inside the 390px viewport while sitting underneath
 * .topbar-right. That is how RANKS and ABOUT once passed this spec while
 * hidden behind the connect button. Hit-test the centre point instead: if
 * the tab is clipped or covered, something else answers.
 */
async function assertNotCovered(page: Page, testId: string): Promise<void> {
  const covering = await page.getByTestId(testId).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return el.contains(hit) ? null : (hit?.className ?? "nothing");
  });
  expect(covering, `${testId} is covered or clipped by: ${covering}`).toBeNull();
}

test.describe("phone topbar", () => {
  test("every tab and the connect button fit at 390px without scrolling the strip", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("tab-mine")).toBeVisible();
    for (const testId of TAB_TESTIDS) {
      await assertFullyInViewport(page, testId);
      await assertNotCovered(page, testId);
    }
    await assertFullyInViewport(page, "connect-button");
    await assertNotCovered(page, "connect-button");
    await assertNoHorizontalOverflow(page);
  });

  test("every tab is reachable by scrolling the strip at 320px, connect button stays in view", async ({
    page,
  }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(page.getByTestId("tab-mine")).toBeVisible();

    for (const testId of TAB_TESTIDS) {
      await page.getByTestId(testId).scrollIntoViewIfNeeded();
      await assertFullyInViewport(page, testId);
      await assertNotCovered(page, testId);
    }
    await assertFullyInViewport(page, "connect-button");
    await assertNotCovered(page, "connect-button");
    await assertNoHorizontalOverflow(page);
  });
});
