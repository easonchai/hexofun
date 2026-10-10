/**
 * Ops console smoke (ops-console ticket 03). Needs the localnet stack the
 * other e2e specs use: a validator with a bootstrapped pool and the backend
 * indexing it, with VITE_API_URL pointing at that backend. Set E2E_LIVE_STACK=1
 * once that stack is up; without it the test skips.
 */
import { expect, test } from "playwright/test";

test.use({ viewport: { width: 1280, height: 900 } });

test.skip(!process.env.E2E_LIVE_STACK, "needs a live localnet stack (set E2E_LIVE_STACK=1)");

test("ops console shows the banner, headline, and the pool, venue and yield panels under Details", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByTestId("ops-alerts")).toBeVisible();
  await expect(page.getByTestId("ops-headline").locator("[data-figure]").first()).toContainText(/\d/);

  // Details starts collapsed unless this browser opened it before.
  const details = page.getByTestId("section-details");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").click();

  for (const id of ["pool", "venue", "yield"]) {
    const panel = page.getByTestId(`panel-${id}`);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("sync-line")).toBeVisible();
    // Non-empty: at least one figure rendered a real value, not the loading line.
    await expect(panel.locator("[data-figure]").first()).not.toBeEmpty();
  }

  await expect(
    page.getByTestId("panel-pool").locator("[data-figure]").first(),
  ).toContainText(/\d/);
  await expect(page.getByTestId("panel-rate-chart")).toBeVisible();
});
