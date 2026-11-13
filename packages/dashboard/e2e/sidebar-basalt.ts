import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function verifyBasaltSidebar(page: Page, dashboardUrl: string, artifacts: string) {
  const measurements: unknown[] = [];
  const capture = async (sidebar: Locator, name: string) => {
    const geometry = await sidebar.evaluate(element => {
      const rect = (node: Element) => node.getBoundingClientRect().toJSON();
      const brand = (slot: string) => {
        const node = element.querySelector<HTMLElement>(`[data-slot='sidebar-brand-${slot}']`)!;
        const bounds = node.getBoundingClientRect();
        let left = Math.max(0, bounds.left);
        let right = Math.min(innerWidth, bounds.right);
        let top = Math.max(0, bounds.top);
        let bottom = Math.min(innerHeight, bounds.bottom);
        for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return { bounds: bounds.toJSON(), paintedWidth: 0, paintedHeight: 0 };
          const clip = parent.getBoundingClientRect();
          if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        }
        return { bounds: bounds.toJSON(), paintedWidth: Math.max(0, right - left), paintedHeight: Math.max(0, bottom - top) };
      };
      const avatar = element.querySelector(".h-basalt-9.w-basalt-9")!;
      const email = element.querySelector("[data-slot='sidebar-user'] p:last-child");
      const drawer = element.closest("[data-slot='sidebar-drawer']");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        sidebar: rect(element), avatar: rect(avatar),
        emailLineHeight: email ? getComputedStyle(email).lineHeight : null,
        logo: rect(element.querySelector("[data-slot='sidebar-brand-logo'] img")!),
        brandName: brand("name"), brandVersion: brand("version"),
        drawer: drawer ? { bounds: rect(drawer), paddingLeft: getComputedStyle(drawer).paddingLeft, paddingRight: getComputedStyle(drawer).paddingRight } : null,
      };
    });
    measurements.push({ name, ...geometry });
    writeFileSync(join(artifacts, "basalt-sidebar-measurements.json"), JSON.stringify(measurements, null, 2));
    await page.screenshot({ path: join(artifacts, `basalt-${name}.png`), fullPage: true, animations: "disabled" });
    expect(geometry.avatar.width).toBe(36);
    expect(geometry.avatar.height).toBe(36);
    expect(geometry.logo.width).toBe(24);
    expect(geometry.logo.height).toBe(24);
    return geometry;
  };
  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${dashboardUrl}/settings`);
    await page.evaluate(value => {
      localStorage.setItem("theme", value);
      localStorage.setItem("raven:sidebar-collapsed", "false");
    }, theme);
    await page.reload();
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const sidebar = page.locator("[data-basalt-sidebar]");
    await expect(sidebar).toHaveCount(1);
    await expect(sidebar.locator(".h-basalt-9.w-basalt-9")).toBeVisible();
    await page.mouse.move(1000, 800);
    const expanded = await capture(sidebar, `expanded-${theme}`);
    expect(expanded.sidebar.width).toBe(260);
    expect(expanded.emailLineHeight).toBe("16px");
    expect(expanded.brandName.paintedWidth).toBeGreaterThan(0);
    expect(expanded.brandVersion.paintedWidth).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page.mouse.move(1000, 800);
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(68);
    const collapsed = await capture(sidebar, `collapsed-${theme}`);
    expect(collapsed.avatar.y).toBe(expanded.avatar.y);
    expect(collapsed.logo.x).toBe(expanded.logo.x);
    expect(collapsed.logo.y).toBe(expanded.logo.y);
    expect(collapsed.brandName.paintedWidth).toBe(0);
    expect(collapsed.brandVersion.paintedWidth).toBe(0);
    for (const width of [320, 390, 700]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${dashboardUrl}/connect`);
      const opener = page.getByRole("button", { name: "Open navigation", exact: true });
      await opener.click();
      const drawer = page.locator("[data-slot='sidebar-drawer']");
      await expect(drawer).toBeVisible();
      await expect(opener).toHaveAttribute("aria-controls", await drawer.getAttribute("id") as string);
      await expect(drawer.locator("[data-slot='sidebar-toggle']")).toHaveAttribute("data-mode", "dismiss");
      const mobile = await capture(drawer.locator("[data-basalt-sidebar]"), `drawer-${width}-${theme}`);
      expect(mobile.drawer!.bounds.width).toBe(260);
      expect(mobile.sidebar.width).toBe(260);
      expect(mobile.drawer!.paddingLeft).toBe("0px");
      expect(mobile.drawer!.paddingRight).toBe("0px");
      expect(mobile.emailLineHeight).toBe("16px");
      expect(mobile.brandName.paintedWidth).toBeGreaterThan(0);
      expect(mobile.brandVersion.paintedWidth).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(opener).toBeFocused();
      await opener.click();
      await drawer.getByRole("button", { name: "General", exact: true }).click();
      await expect(page).toHaveURL(`${dashboardUrl}/settings`);
      await expect(drawer).toBeHidden();
      await expect(opener).toBeFocused();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { localStorage.setItem("theme", "light"); localStorage.setItem("raven:sidebar-collapsed", "false"); });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
