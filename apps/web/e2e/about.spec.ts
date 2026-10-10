/**
 * ABOUT tab smoke: the page mounts from its hash, the self-playing board
 * renders its 36 tiles, and the FAQ opens natively. Burner wallet, mocked backend (./admitted).
 */
import { expect } from "playwright/test";

import { test } from "./admitted";

test.use({ viewport: { width: 1280, height: 900 } });

test("about page renders", async ({ page }) => {
  await page.goto("/#about");
  await expect(page.getByTestId("about-screen")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "play your luck",
  );
  await expect(page.getByTestId("demo-board").locator("[data-tile]")).toHaveCount(36);

  const first = page.getByTestId("about-faq").locator("details").first();
  await expect(first).not.toHaveAttribute("open", "");
  await first.locator("summary").click();
  await expect(first).toHaveAttribute("open", "");
  await expect(first.locator("p")).toContainText("Only tickets are.");

  await page.getByTestId("tab-about").click();
  await expect(page.getByTestId("about-screen")).toBeVisible();
});
