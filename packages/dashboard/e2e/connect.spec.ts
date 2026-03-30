import { test, expect } from "@playwright/test";

/**
 * Connect page E2E tests — API key management and code examples.
 *
 * Uses route interception to mock proxy API responses.
 */

test.describe("connect page", () => {
  test.beforeEach(async ({ page }) => {
    // Mock API responses for connect page
    await page.route("**/api/keys", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: [
            { id: 1, name: "test-key-1", prefix: "rk-abc123", status: "active", createdAt: new Date().toISOString() },
            { id: 2, name: "revoked-key", prefix: "rk-def456", status: "revoked", createdAt: new Date().toISOString() },
          ],
        });
      } else if (route.request().method() === "POST") {
        await route.fulfill({
          json: { id: 3, name: "new-key", key: "rk-0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff" },
        });
      } else {
        await route.continue();
      }
    });

    await page.route("**/api/connection-info", async (route) => {
      await route.fulfill({
        json: {
          host: "localhost:7024",
          endpoints: {
            messages: "/v1/messages",
            chat: "/v1/chat/completions",
            embeddings: "/v1/embeddings",
            models: "/v1/models",
          },
          models: ["claude-sonnet-4-20250514", "gpt-4o"],
          authMode: "api_key",
        },
      });
    });
  });

  test("shows connection endpoints", async ({ page }) => {
    await page.goto("/connect");
    await expect(page.locator("text=/v1/messages/")).toBeVisible();
    await expect(page.locator("text=/v1/chat/completions/")).toBeVisible();
  });

  test("code example tabs switch content", async ({ page }) => {
    await page.goto("/connect");

    // Find tab buttons — look for curl/Python/TypeScript tabs
    const tabs = page.locator('button, [role="tab"]');
    const pythonTab = tabs.filter({ hasText: "Python" });

    if (await pythonTab.count()) {
      await pythonTab.first().click();
      // Python example should show import or client
      await expect(page.locator("text=/import|client/i").first()).toBeVisible();
    }
  });

  test("API key list shows active and revoked keys", async ({ page }) => {
    await page.goto("/connect");
    await expect(page.locator("text=test-key-1")).toBeVisible();
    await expect(page.locator("text=revoked-key")).toBeVisible();
  });

  test("create key dialog opens and closes", async ({ page }) => {
    await page.goto("/connect");

    const createBtn = page.locator('button:has-text("Create")').first();
    if (await createBtn.isVisible()) {
      await createBtn.click();

      // Dialog should appear with name input
      const dialog = page.locator('[role="dialog"], dialog');
      await expect(dialog).toBeVisible();

      // Close dialog
      const closeBtn = dialog.locator('button:has-text("Cancel"), button:has-text("Close"), button[aria-label="Close"]');
      if (await closeBtn.count()) {
        await closeBtn.first().click();
      } else {
        await page.keyboard.press("Escape");
      }
    }
  });
});
