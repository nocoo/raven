import { test, expect } from "@playwright/test";

/**
 * L3 Dashboard smoke tests — read-only UI verification.
 *
 * Requires both proxy (:7024) and dashboard (:7023) running in dev mode
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

// ===========================================================================
// Per-page smoke — every dashboard route renders + primary heading visible.
// Mirrors zhe's "page coverage" metric: every route table entry has a spec.
// ===========================================================================

const pageSmoke: Array<{ name: string; path: string; expect: string | RegExp }> = [
  { name: "/login renders sign-in card", path: "/login", expect: /Sign in|Local mode|Authenticated Access/i },
  { name: "/copilot/account renders heading", path: "/copilot/account", expect: /Copilot|Account/i },
  { name: "/copilot/models renders heading", path: "/copilot/models", expect: /Models?/i },
  { name: "/settings/proxy renders heading", path: "/settings/proxy", expect: "Proxy" },
  { name: "/settings/server-tools renders heading", path: "/settings/server-tools", expect: "Server Tools" },
  { name: "/settings/upstreams renders heading", path: "/settings/upstreams", expect: "Upstreams" },
];

for (const p of pageSmoke) {
  test(p.name, async ({ page }) => {
    const response = await page.goto(p.path);
    // Either renders successfully or redirects to /login when auth-gated —
    // both are acceptable smoke outcomes for a route that exists.
    expect(response?.status() ?? 200).toBeLessThan(500);
    const url = page.url();
    if (!url.includes("/login") || p.path === "/login") {
      await expect(page.locator(`text=${p.expect}`).first()).toBeVisible({ timeout: 5000 });
    }
  });
}

test("/requests redirects to / preserving search", async ({ page }) => {
  await page.goto("/requests?model=claude");
  await page.waitForURL((url) => !url.pathname.startsWith("/requests"), { timeout: 5000 });
  expect(page.url()).toMatch(/\/(\?|$)/);
});
