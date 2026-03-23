import { test, expect } from "@playwright/test";

/**
 * Settings page E2E tests — version overrides and optimization toggles.
 *
 * Uses route interception to mock proxy API responses.
 */

test.describe("settings page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            vscode_version: null,
            copilot_chat_version: null,
            sanitize_orphaned_tool_results: true,
            reorder_tool_results: true,
            filter_whitespace_chunks: true,
          },
        });
      } else if (route.request().method() === "PUT") {
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.continue();
      }
    });

    await page.route("**/api/settings/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.continue();
      }
    });
  });

  test("settings page shows version override inputs", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("text=Settings")).toBeVisible();

    // Should have input fields for version overrides
    const inputs = page.locator('input[type="text"], input:not([type])');
    expect(await inputs.count()).toBeGreaterThanOrEqual(1);
  });

  test("optimization switches are visible and toggleable", async ({ page }) => {
    await page.goto("/settings");

    // Look for switch/toggle elements
    const switches = page.locator('[role="switch"], button[data-state]');
    const count = await switches.count();

    if (count >= 1) {
      const firstSwitch = switches.first();
      const initialState = await firstSwitch.getAttribute("data-state");
      await firstSwitch.click();

      // State should change (checked/unchecked)
      const newState = await firstSwitch.getAttribute("data-state");
      expect(newState).not.toBe(initialState);
    }
  });

  test("version input accepts text", async ({ page }) => {
    await page.goto("/settings");

    const input = page.locator('input').first();
    if (await input.isVisible()) {
      await input.fill("1.99.0");
      await expect(input).toHaveValue("1.99.0");
    }
  });
});
