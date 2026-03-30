import { defineConfig } from "@playwright/test";

/**
 * Playwright config for dashboard E2E smoke tests.
 *
 * Does NOT include `webServer` — use scripts/run-playwright.ts to
 * automatically start/stop both proxy and dashboard dev servers.
 */
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  workers: 1, // serial — dashboard depends on proxy state
  use: {
    baseURL: "http://localhost:7023",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
