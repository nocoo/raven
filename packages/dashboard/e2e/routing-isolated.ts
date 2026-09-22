import { chromium, expect, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

interface BrowserOptions {
  dashboardUrl: string;
  receiverUrl: string;
  proxyUrl: string;
  artifacts: string;
  inspect: () => { catalogCalls: number; generationCalls: number };
}

export async function runRoutingBrowser(options: BrowserOptions) {
  const { dashboardUrl, receiverUrl, proxyUrl, artifacts, inspect } = options;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai", colorScheme: "light", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors: string[] = [];
  const blocked: string[] = [];
  const checks: string[] = [];
  const layouts: unknown[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === dashboardUrl) return route.continue();
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => localStorage.setItem("raven-setup-dismissed", "true"));
  const checkpoint = (name: string) => { checks.push(name); console.info(`浏览器验收通过：${name}`); };
  const select = async (scope: Page | Locator, label: string, value: string) => {
    await scope.getByRole("combobox", { name: label, exact: true }).click();
    const popup = page.getByRole("listbox");
    await expect(popup).toBeVisible();
    await expect.poll(async () => {
      const bounds = await popup.boundingBox();
      return bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height;
    }, { message: `${label} popup fits the viewport after Popper positions it` }).toBe(true);
    if (label === "End time" && value === "01:00") {
      const size = page.viewportSize()!.width < 768 ? "mobile" : "desktop";
      await page.screenshot({ path: join(artifacts, `end-time-popup-${size}.png`) });
    }
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  const save = async (path: string, method: string) => {
    const response = page.waitForResponse(response => response.url().includes(path) && response.request().method() === method);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const result = await response;
    expect(result.ok()).toBe(true);
    await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
    return result.json();
  };
  const shot = (name: string) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true, animations: "disabled" });
  const layout = async (name: string) => {
    const geometry = await page.evaluate(() => {
      const island = document.querySelector<HTMLElement>("main [data-basalt-surface-root]")!;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        bodyHeight: document.body.scrollHeight,
        island: { clientHeight: island.clientHeight, scrollHeight: island.scrollHeight, position: getComputedStyle(island).position },
        screenReaderLabels: [...island.querySelectorAll<HTMLElement>(".sr-only")].map(element => ({
          text: element.textContent?.slice(0, 80),
          offsetParent: element.offsetParent?.tagName ?? null,
          contained: element.offsetParent !== null && island.contains(element.offsetParent),
        })),
      };
    });
    layouts.push({ name, ...geometry });
    expect(geometry.document.width).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.document.height).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.bodyHeight).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.screenReaderLabels.every(label => label.contained)).toBe(true);
  };
  try {
    await page.goto(`${dashboardUrl}/routing/upstreams`);
    await expect(page.getByRole("heading", { name: "Upstreams", exact: true })).toBeVisible();
    expect(inspect()).toEqual({ catalogCalls: 0, generationCalls: 0 });
    await page.getByRole("button", { name: "New upstream", exact: true }).click();
    await page.getByLabel("Upstream name", { exact: true }).fill("Research provider");
    await select(page, "Native API format", "OpenAI Chat Completions");
    await page.getByLabel("Base URL", { exact: true }).fill(`${receiverUrl}/v1`);
    await page.getByLabel("API key", { exact: true }).fill("fixture-provider");
    const upstream = await save("/api/upstreams", "POST") as { id: string };
    expect(inspect()).toEqual({ catalogCalls: 0, generationCalls: 0 });
    checkpoint("upstream create and reads are cache-only");

    await page.getByRole("tab", { name: "Models & test", exact: true }).click();
    await page.getByLabel("Manual model IDs", { exact: true }).fill("Manual.Raw-ID");
    await save(`/api/upstreams/${upstream.id}`, "PUT");
    expect(inspect().catalogCalls).toBe(0);
    await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect(page.getByRole("list", { name: "Fetched models" }).getByText("fixture-fast", { exact: true })).toBeVisible();
    expect(inspect().catalogCalls).toBe(1);
    await expect(page.getByLabel("Manual model IDs")).toHaveValue("Manual.Raw-ID");
    await page.getByLabel("Test model", { exact: true }).fill("fixture-fast");
    await page.getByLabel("Test model", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "Send one test", exact: true }).click();
    await expect(page.getByText("Received pong", { exact: true })).toBeVisible();
    expect(inspect().generationCalls).toBe(1);
    checkpoint("manual models survive refresh; diagnostic sends exactly once");
    await shot("upstreams-models-desktop");

    await page.getByRole("tab", { name: "Shared quota", exact: true }).click();
    await page.getByLabel("Enable shared token quota", { exact: true }).click();
    await page.getByLabel("1× token allowance", { exact: true }).fill("1000000");
    await expect(page.getByLabel("Window (minutes)")).toHaveValue("300");
    await page.getByText("Every day", { exact: true }).click();
    await page.getByRole("button", { name: "Add period", exact: true }).click();
    await select(page, "Start time", "09:00");
    await select(page, "End time", "17:00");
    await page.getByLabel("Token multiplier", { exact: true }).fill("2");
    const limited = await save(`/api/upstreams/${upstream.id}`, "PUT");
    expect(limited.quota).toMatchObject({ limit_tokens: 1000000, window_minutes: 300, mode: "daily", multipliers: [{ start_minute: 60, end_minute: 540, multiplier: 2 }] });
    checkpoint("local quota timetable persists UTC and preserves the five-hour window");
    await shot("upstreams-quota-desktop");

    await page.goto(`${dashboardUrl}/routing/rules`);
    await page.getByRole("button", { name: "New rule", exact: true }).click();
    await page.getByLabel("Rule name", { exact: true }).fill("Follow the sun");
    await expect(page.getByRole("switch", { name: "Allow protocol conversion" })).not.toBeChecked();
    const chain = page.getByRole("region", { name: "Default chain", exact: true });
    await select(chain, "Upstream 1", "Research provider");
    await chain.getByLabel("Model 1", { exact: true }).fill("Manual.Raw-ID");
    await chain.getByRole("button", { name: "Add quota candidate", exact: true }).click();
    await select(chain, "Upstream 1", "Research provider");
    await chain.getByLabel("Model 1", { exact: true }).fill("fixture-fast");
    await chain.getByLabel("Model 1", { exact: true }).press("Tab");
    await chain.getByRole("button", { name: "Move target 1", exact: true }).dragTo(chain.locator("li").nth(1));
    await expect(chain.getByLabel("Model 1", { exact: true })).toHaveValue("Manual.Raw-ID");
    await chain.getByRole("button", { name: "Move target 1 down", exact: true }).click();
    await expect(chain.getByLabel("Model 1", { exact: true })).toHaveValue("fixture-fast");
    await chain.getByRole("button", { name: "Move target 1", exact: true }).press("Alt+ArrowDown");
    await expect(chain.getByLabel("Model 1", { exact: true })).toHaveValue("Manual.Raw-ID");
    await chain.getByRole("button", { name: "Move target 1", exact: true }).press("Alt+ArrowDown");
    await expect(chain.getByLabel("Model 1", { exact: true })).toHaveValue("fixture-fast");
    checkpoint("native drag, reorder buttons and keyboard preserve target identities");

    await page.getByRole("switch", { name: "Allow protocol conversion" }).click();
    await page.getByText("Weekly", { exact: true }).click();
    await page.getByRole("button", { name: "Add period", exact: true }).click();
    await select(page, "Start time", "23:30");
    await select(page, "End time", "01:00");
    await expect(page.getByText("Ends next day", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Copy day", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Saturday", { exact: true }).click();
    await page.getByRole("dialog").getByLabel("Sunday", { exact: true }).click();
    await page.getByRole("button", { name: "Apply copy", exact: true }).click();
    const rule = await save("/api/routing-rules", "POST") as { id: string; periods: { id: string; start_minute: number; end_minute: number }[] };
    expect(rule.periods.map(period => [period.start_minute, period.end_minute])).toEqual([[930, 1020], [8130, 8220], [9570, 9660]]);
    expect(new Set(rule.periods.map(period => period.id)).size).toBe(3);
    checkpoint("overnight weekly periods and day copying persist correct UTC intervals");
    await shot("routing-weekly-desktop");
    await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
    await shot("routing-timetable-desktop");

    await page.getByLabel("Rule name").fill("Unsaved draft");
    await page.getByRole("navigation", { name: "Routing rules", exact: true }).getByRole("button", { name: /GitHub Copilot/ }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Discard unsaved changes?");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Rule name")).toHaveValue("Unsaved draft");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByLabel("Rule name")).toHaveValue("Follow the sun");
    checkpoint("unsaved drafts require a deliberate discard");

    await page.goto(`${dashboardUrl}/connect`);
    await page.getByRole("button", { name: "Create Key", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Browser acceptance");
    await select(page.getByRole("dialog"), "Routing rule", "Follow the sun");
    const created = page.waitForResponse(response => response.url().endsWith("/api/keys") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const client = await (await created).json() as { id: string; key: string; rule_id: string };
    expect(client.rule_id).toBe(rule.id);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change rule for Browser acceptance" })).toContainText("Follow the sun");
    await page.getByRole("button", { name: "Change rule for Browser acceptance" }).click();
    await select(page.getByRole("dialog"), "Routing rule", "GitHub Copilot");
    await page.getByRole("button", { name: "Save binding", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change rule for Browser acceptance" })).toContainText("GitHub Copilot");
    await page.getByRole("button", { name: "Change rule for Browser acceptance" }).click();
    await select(page.getByRole("dialog"), "Routing rule", "Follow the sun");
    await page.getByRole("button", { name: "Save binding", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change rule for Browser acceptance" })).toContainText("Follow the sun");
    checkpoint("Connect creates and rebinds a key to exactly one rule");
    await shot("connect-desktop");

    for (const model of ["auto", "Manual.Exact-ID"]) {
      const response = await fetch(`${proxyUrl}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${client.key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }) });
      expect(response.status).toBe(200);
      expect((await response.json() as { model: string }).model).toBe(model === "auto" ? "fixture-fast" : model);
    }
    const modelsResponse = await fetch(`${proxyUrl}/v1/models`, { headers: { authorization: `Bearer ${client.key}` } });
    const catalog = await modelsResponse.json() as { data: { id: string }[] };
    expect(catalog.data.map(model => model.id).sort()).toEqual(["auto", "fixture-fast", "fixture-smart", "gpt-5.6-sol", "Manual.Raw-ID"].sort());
    expect(inspect()).toEqual({ catalogCalls: 1, generationCalls: 3 });
    checkpoint("real HTTP key authentication, auto selection, explicit IDs and cached model listing");

    await page.goto(`${dashboardUrl}/requests`);
    await page.getByRole("row").filter({ hasText: "Manual.Exact-ID" }).first().click();
    await expect(page.getByRole("region", { name: "Routing details" })).toContainText("Research provider");
    await expect(page.getByRole("region", { name: "Routing details" })).toContainText("Manual.Exact-ID");
    await shot("requests-routing-desktop");
    checkpoint("Requests displays persisted routing and usage attribution");

    await page.goto(`${dashboardUrl}/routing/upstreams`);
    await page.getByRole("navigation", { name: "Upstreams", exact: true }).getByRole("button", { name: /Research provider/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete upstream", exact: true }).click();
    const upstreamEditor = page.getByRole("group", { name: "Upstream editor", exact: true });
    await expect(upstreamEditor.getByRole("alert")).toContainText("Follow the sun");
    checkpoint("BFF preserves reference conflicts with actionable rule names");
    await page.getByRole("tab", { name: "Models & test", exact: true }).click();
    await page.getByLabel("Test model", { exact: true }).fill("fixture-fail");
    await page.getByLabel("Test model", { exact: true }).press("Tab");
    await expect(page.getByLabel("Test model", { exact: true })).toHaveValue("fixture-fail");
    const failedTest = page.waitForResponse(response => response.url().endsWith(`/api/upstreams/${upstream.id}/test`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send one test", exact: true }).click();
    expect((await failedTest).ok()).toBe(false);
    await expect(upstreamEditor.getByRole("alert")).toBeVisible();
    expect(inspect().generationCalls).toBe(4);
    await page.getByRole("button", { name: "Reload status", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reload status", exact: true })).toBeEnabled();
    expect(inspect()).toEqual({ catalogCalls: 1, generationCalls: 4 });
    checkpoint("failed diagnostics stop after one attempt; status reload stays cache-only");

    await page.goto(`${dashboardUrl}/routing/rules`);
    await page.getByRole("navigation", { name: "Routing rules", exact: true }).getByRole("button", { name: /Follow the sun/ }).click();
    await page.evaluate(() => { localStorage.setItem("theme", "dark"); document.documentElement.classList.add("dark"); document.documentElement.classList.remove("light"); document.documentElement.dataset.mode = "dark"; });
    await shot("routing-weekly-dark");
    await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
    await shot("routing-timetable-dark");
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    expect(await page.locator(".routing-enter").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["routing/rules", "routing/upstreams", "connect"]) {
      await page.goto(`${dashboardUrl}/${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      if (path === "routing/rules") await page.getByRole("navigation", { name: "Routing rules", exact: true }).getByRole("button", { name: /Follow the sun/ }).click();
      if (path === "routing/upstreams") await page.getByRole("navigation", { name: "Upstreams", exact: true }).getByRole("button", { name: /Research provider/ }).click();
      await layout(path);
      await shot(`${path.replaceAll("/", "-")}-mobile-dark`);
      if (path === "routing/rules") {
        await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
        await shot("routing-timetable-mobile-dark");
        await select(page, "End time", "01:00");
        await expect(page.getByRole("combobox", { name: "Start time", exact: true })).toContainText("23:30");
        await shot("routing-period-mobile-dark");
      } else if (path === "routing/upstreams") {
        await page.getByRole("tab", { name: "Shared quota", exact: true }).click();
        await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
        await shot("upstream-quota-mobile-dark");
      } else {
        await page.getByRole("button", { name: "Change rule for Browser acceptance" }).click();
        const binding = page.getByRole("dialog");
        await expect(binding).toBeInViewport({ ratio: 1 });
        await expect(binding).toHaveCSS("opacity", "1");
        layouts.push({ name: "connect-binding", bounds: await binding.boundingBox() });
        await shot("connect-binding-mobile-dark");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
    }
    checkpoint("desktop/mobile, dark theme and reduced-motion layouts");
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    return { checks, errors, blocked, layouts, viewport: [1440, 1100, 390, 844], timezone: "Asia/Shanghai" };
  } catch (error) {
    await shot("failure");
    throw error;
  } finally {
    await browser.close();
  }
}
