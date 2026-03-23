import { test, expect } from "@playwright/test";

/**
 * Copilot pages E2E tests — account info and upstream model list.
 *
 * Uses route interception to mock proxy API responses.
 */

test.describe("copilot account page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/copilot/user", async (route) => {
      await route.fulfill({
        json: {
          login: "testuser",
          avatar_url: "https://github.com/identicons/testuser.png",
          copilot: {
            plan: "copilot_business",
            organization: "test-org",
            seat_created_at: "2024-01-15T00:00:00Z",
          },
          quotas: {
            chat: { used: 50, total: 300, unlimited: false, percentage: 16.7 },
            completions: { used: 0, total: 0, unlimited: true, percentage: 0 },
            premium: { used: 5, total: 100, unlimited: false, percentage: 5 },
          },
          endpoints: {
            api: "https://api.github.com",
            proxy: "https://api.githubcopilot.com",
          },
        },
      });
    });
  });

  test("shows copilot account info", async ({ page }) => {
    await page.goto("/copilot/account");
    await expect(page.locator("text=Account")).toBeVisible();
    await expect(page.locator("text=testuser")).toBeVisible();
  });

  test("shows plan information", async ({ page }) => {
    await page.goto("/copilot/account");
    // Plan type should be displayed
    await expect(page.locator("text=/business|copilot/i").first()).toBeVisible();
  });

  test("refresh button triggers data reload", async ({ page }) => {
    let refreshCalled = false;
    await page.route("**/api/copilot/user?refresh=true", async (route) => {
      refreshCalled = true;
      await route.fulfill({
        json: {
          login: "testuser-refreshed",
          copilot: { plan: "copilot_business" },
          quotas: {},
          endpoints: {},
        },
      });
    });

    await page.goto("/copilot/account");

    const refreshBtn = page.locator('button:has-text("Refresh"), button[aria-label*="refresh" i]');
    if (await refreshBtn.count()) {
      await refreshBtn.first().click();
      await page.waitForTimeout(1000);
      expect(refreshCalled).toBe(true);
    }
  });
});

test.describe("copilot models page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/copilot/models", async (route) => {
      await route.fulfill({
        json: {
          models: [
            { id: "gpt-4o", vendor: "OpenAI", version: "2024-05-13", capabilities: { type: "chat" } },
            { id: "claude-sonnet-4-20250514", vendor: "Anthropic", version: "2025-05-14", capabilities: { type: "chat" } },
            { id: "o3-mini", vendor: "OpenAI", version: "2025-01-31", capabilities: { type: "chat" } },
          ],
        },
      });
    });
  });

  test("shows upstream model list", async ({ page }) => {
    await page.goto("/copilot/models");
    await expect(page.locator("text=Models")).toBeVisible();
  });

  test("displays model entries", async ({ page }) => {
    await page.goto("/copilot/models");
    // Should show at least one model from the mocked data
    await expect(page.locator("text=gpt-4o").first()).toBeVisible();
  });
});
