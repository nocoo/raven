import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function verifySidebarHydration(dashboardUrl: string, artifacts: string) {
  const browser = await chromium.launch({ headless: true });
  const results: unknown[] = [];
  const errors: string[] = [];
  const blocked: string[] = [];
  try {
    for (const width of [1440, 390]) for (const preference of ["false", "true"]) {
      const context = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: "block", reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`));
      page.on("console", message => { if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`); });
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin === dashboardUrl) return route.continue();
        blocked.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      await context.addInitScript(value => {
        if (!sessionStorage.getItem("raven-hydration-seeded")) {
          localStorage.setItem("raven:sidebar-collapsed", value);
          sessionStorage.setItem("raven-hydration-seeded", "true");
        }
        localStorage.setItem("raven-setup-dismissed", "true");
        const writes: string[] = [];
        (window as typeof window & { __ravenSidebarWrites: string[] }).__ravenSidebarWrites = writes;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, next) {
          if (this === localStorage && key === "raven:sidebar-collapsed") writes.push(next);
          return setItem.call(this, key, next);
        };
      }, preference);
      const storage = () => page.evaluate(() => ({
        value: localStorage.getItem("raven:sidebar-collapsed"),
        writes: (window as typeof window & { __ravenSidebarWrites: string[] }).__ravenSidebarWrites,
      }));
      const rail = page.locator("[data-basalt-sidebar]");
      const restored = async (value: string) => {
        await expect(page.getByRole("button", { name: value === "true" ? "Expand sidebar" : "Collapse sidebar", exact: true })).toBeVisible();
        await expect.poll(() => rail.evaluate(element => element.getBoundingClientRect().width)).toBe(value === "true" ? 68 : 260);
        expect((await storage()).value).toBe(value);
      };
      for (const route of ["settings", "connect"]) {
        await page.goto(`${dashboardUrl}/${route}`);
        if (width === 390) {
          const opener = page.getByRole("button", { name: "Open navigation", exact: true });
          await opener.click();
          await expect(rail).toBeVisible();
          await expect.poll(() => rail.evaluate(element => element.getBoundingClientRect().width)).toBe(260);
          await page.keyboard.press("Escape");
          await expect(page.locator("[data-slot='sidebar-drawer']")).toBeHidden();
          await expect(opener).toBeFocused();
        } else {
          await restored(preference);
        }
        const initialStorage = await storage();
        expect(initialStorage).toEqual({ value: preference, writes: [] });
        await page.setViewportSize({ width: 1440, height: 1100 });
        await restored(preference);
        const opposite = preference === "true" ? "false" : "true";
        await page.getByRole("button", { name: preference === "true" ? "Expand sidebar" : "Collapse sidebar", exact: true }).click();
        await restored(opposite);
        expect((await storage()).writes).toEqual([opposite]);
        await page.reload();
        await restored(opposite);
        expect((await storage()).writes).toEqual([]);
        await page.getByRole("button", { name: opposite === "true" ? "Expand sidebar" : "Collapse sidebar", exact: true }).click();
        await restored(preference);
        await page.setViewportSize({ width, height: 1100 });
        await page.reload();
        if (width === 390) await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
        else await restored(preference);
        expect(await storage()).toEqual({ value: preference, writes: [] });
        await page.screenshot({ path: join(artifacts, `hydration-${width}-${preference}-${route}.png`), animations: "disabled" });
        results.push({ width, preference, route, initialStorage, finalStorage: await storage(), errors: [...errors] });
        writeFileSync(join(artifacts, "sidebar-hydration.json"), JSON.stringify({ results, errors, blocked }, null, 2));
        expect(errors).toEqual([]);
        expect(blocked).toEqual([]);
      }
      await context.close();
    }
    return results;
  } finally {
    writeFileSync(join(artifacts, "sidebar-hydration.json"), JSON.stringify({ results, errors, blocked }, null, 2));
    await browser.close();
  }
}
