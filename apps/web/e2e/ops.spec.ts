/**
 * Ops console smoke (ops-console ticket 03). Needs the localnet stack the
 * other e2e specs use: a validator with a bootstrapped pool and the backend
 * indexing it, with VITE_API_URL pointing at that backend.
 */
import { expect, test } from "playwright/test";

test.use({ viewport: { width: 1280, height: 900 } });

test("ops console shows the pool, venue and yield panels with figures", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

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
