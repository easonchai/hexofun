/**
 * ABOUT tab on a phone: single column, no horizontal overflow, the wallet
 * menu entry is reachable. Runs only on the "phone" Playwright project.
 */
import { expect } from "playwright/test";

import { test } from "./admitted";

test("about page stacks without horizontal overflow", async ({ page }) => {
  await page.goto("/#about");
  await expect(page.getByTestId("about-screen")).toBeVisible();
  // A connected wallet moves ABOUT from the navbar into the wallet menu on phones.
  await expect(page.getByTestId("tab-about")).toBeHidden();
  await page.getByTestId("connect-button").click();
  await expect(page.getByTestId("wallet-menu-about")).toBeVisible();
  await page.keyboard.press("Escape");

  const { scrollWidth, viewportWidth } = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".about")!;
    return { scrollWidth: el.scrollWidth, viewportWidth: window.innerWidth };
  });
  expect(scrollWidth).toBe(viewportWidth);

  // Board above the copy, both inside the viewport width.
  const board = await page.getByTestId("demo-board").boundingBox();
  const h1 = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(board).not.toBeNull();
  expect(h1).not.toBeNull();
  expect(board!.y).toBeLessThan(h1!.y);
  expect(board!.width).toBeLessThanOrEqual(viewportWidth);
});
