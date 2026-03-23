import { test, expect } from "@playwright/test";

/**
 * L3 Dashboard smoke tests — read-only UI verification.
 *
 * Requires both proxy (:7033) and dashboard (:7032) running in dev mode
 * (no RAVEN_API_KEY / RAVEN_INTERNAL_KEY set, so auth is bypassed).
 *
 * Use `bun run test:ui` or `bun run scripts/run-playwright.ts` to auto
 * start/stop servers and run these tests.
 */

test.describe("smoke", () => {
  test("homepage loads and shows overview heading", async ({ page }) => {
    await page.goto("/");
    // Overview page should render with stat cards
    await expect(page.locator("h1, h2, h3").first()).toBeVisible();
    // Should contain navigation links
    await expect(page.locator("nav")).toBeVisible();
  });

  test("connect page loads", async ({ page }) => {
    await page.goto("/connect");
    // Connect page shows connection info or API keys section
    await expect(page.locator("text=Connect")).toBeVisible();
  });

  test("logs page loads", async ({ page }) => {
    await page.goto("/logs");
    await expect(page.locator("text=Logs")).toBeVisible();
  });

  test("settings page loads", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("text=Settings")).toBeVisible();
  });

  test("models page loads", async ({ page }) => {
    await page.goto("/models");
    await expect(page.locator("text=Model")).toBeVisible();
  });

  test("navigation between pages works", async ({ page }) => {
    await page.goto("/");

    // Click on a nav link to another page
    const logsLink = page.locator('nav a[href="/logs"], nav >> text=Logs');
    if (await logsLink.count()) {
      await logsLink.first().click();
      await page.waitForURL("**/logs");
      await expect(page.locator("text=Logs")).toBeVisible();
    }
  });

  test("no console errors on page load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Filter out expected Next.js dev mode noise
    const realErrors = errors.filter(
      (e) =>
        !e.includes("Download the React DevTools") &&
        !e.includes("Warning:") &&
        !e.includes("Hydration"),
    );
    expect(realErrors).toHaveLength(0);
  });
});
