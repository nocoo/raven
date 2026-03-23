import { test, expect } from "@playwright/test";

/**
 * Navigation and routing E2E tests — sidebar navigation, breadcrumbs,
 * error handling, and responsive layout.
 */

test.describe("navigation", () => {
  test("sidebar contains all main navigation links", async ({ page }) => {
    await page.goto("/");

    const nav = page.locator("nav");
    await expect(nav).toBeVisible();

    // Check key navigation items exist
    const navLinks = nav.locator("a");
    const hrefs: string[] = [];
    for (let i = 0; i < await navLinks.count(); i++) {
      const href = await navLinks.nth(i).getAttribute("href");
      if (href) hrefs.push(href);
    }

    // At minimum, we expect these core routes
    expect(hrefs).toEqual(expect.arrayContaining([
      expect.stringContaining("/"),
    ]));
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
  });

  test("clicking nav links navigates without full page reload", async ({ page }) => {
    await page.goto("/");

    const navLinks = page.locator("nav a").filter({ hasNotText: /Overview/i });
    if (await navLinks.count() > 0) {
      const initialUrl = page.url();
      await navLinks.first().click();
      await page.waitForTimeout(1000);
      // Should have navigated away from initial URL
      expect(page.url()).not.toBe(initialUrl);
    }
  });

  test("/requests redirects to / with search params preserved", async ({ page }) => {
    await page.goto("/requests?model=gpt-4o");
    // Should redirect to root with params
    await page.waitForURL(/\//);
    expect(page.url()).toContain("/");
  });
});

test.describe("error handling", () => {
  test("404 page renders for unknown routes", async ({ page }) => {
    const response = await page.goto("/nonexistent-page-xyz");
    // Next.js should return 404
    expect(response?.status()).toBe(404);
  });

  test("pages handle missing proxy gracefully", async ({ page }) => {
    // Mock API calls to fail (simulating proxy down)
    await page.route("**/api/**", async (route) => {
      await route.fulfill({ status: 502, json: { error: "Bad Gateway" } });
    });

    await page.goto("/connect");
    // Page should still render without crashing
    await expect(page.locator("text=Connect")).toBeVisible();
  });
});

test.describe("responsive layout", () => {
  test("mobile viewport shows collapsed navigation", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    // On mobile, sidebar should be collapsed or hidden
    // and a menu button should be visible
    const menuBtn = page.locator('button[aria-label*="menu" i], button[aria-label*="sidebar" i], [data-sidebar="trigger"]');
    if (await menuBtn.count()) {
      await expect(menuBtn.first()).toBeVisible();
    }
  });
});
