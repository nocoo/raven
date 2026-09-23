import { chromium, expect, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

export type CatalogFixtureFailure = "wrong-shape" | "non-json";

interface BrowserOptions {
  dashboardUrl: string;
  receiverUrl: string;
  proxyUrl: string;
  artifacts: string;
  inspect: () => { catalogCalls: number; generationCalls: number };
  nextCatalogResponse: (kind: CatalogFixtureFailure) => void;
}

export async function runRoutingBrowser(options: BrowserOptions) {
  const { dashboardUrl, receiverUrl, proxyUrl, artifacts, inspect } = options;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai", colorScheme: "light", serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  const blocked: string[] = [];
  const checks: string[] = [];
  const layouts: unknown[] = [];
  page.on("pageerror", error => { errors.push(`${page.url()}: ${error.message}`); });
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
    const card = page.getByRole("region", { name: path.startsWith("/api/upstreams") ? "Upstream configuration" : "Rule configuration", exact: true });
    const response = page.waitForResponse(response => response.url().includes(path) && response.request().method() === method);
    await card.getByRole("button", { name: "Save changes", exact: true }).click();
    const result = await response;
    expect(result.ok()).toBe(true);
    await expect(card.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: path.startsWith("/api/upstreams") ? "Upstream saved." : "Rule saved." }).last()).toBeVisible();
    await expect(card.getByText("All changes saved", { exact: true })).toHaveCount(0);
    return result.json();
  };
  const indicator = async (name: string) => {
    const active = page.getByRole("tab", { name, exact: true });
    await expect(active).toHaveAttribute("aria-selected", "true");
    const geometry = () => active.evaluate(element => {
      const list = element.closest<HTMLElement>("[role=tablist]")!;
      const line = list.querySelector<HTMLElement>("[data-slot=selection-indicator]")!;
      const tab = element.getBoundingClientRect();
      const bounds = line.getBoundingClientRect();
      return { name: element.textContent, x: tab.x, width: tab.width, indicatorX: bounds.x, indicatorWidth: bounds.width, height: bounds.height, overflow: getComputedStyle(list).overflow, opacity: getComputedStyle(line).opacity };
    });
    await expect.poll(async () => {
      const value = await geometry();
      return Math.abs(value.x - value.indicatorX) < 1.5 && Math.abs(value.width - value.indicatorWidth) < 1.5 && value.height > 0 && value.overflow === "visible" && Number(value.opacity) > 0;
    }, { message: `${name} indicator aligns with its tab and is not clipped` }).toBe(true);
    layouts.push({ kind: "tab-indicator", ...await geometry() });
  };
  const header = async (name: string) => {
    const card = page.getByRole("region", { name: `${name} configuration`, exact: true });
    const input = await card.getByLabel(`${name} name`, { exact: true }).boundingBox();
    const action = await card.getByRole("button", { name: "Save changes", exact: true }).boundingBox();
    expect(input).not.toBeNull();
    expect(action).not.toBeNull();
    expect(Math.abs(input!.y - action!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(input!.height - action!.height)).toBeLessThanOrEqual(1);
    layouts.push({ kind: "configuration-header", name, input, action });
  };
  const feedbackPlacement = async (feedback: Locator) => {
    const card = page.getByRole("region", { name: /^(Upstream|Rule) configuration$/ });
    const title = await card.locator("[aria-label$=' name'], h2").first().boundingBox();
    const banner = await feedback.boundingBox();
    const tabs = await card.getByRole("tablist").boundingBox();
    expect(banner).not.toBeNull();
    expect(banner!.y).toBeGreaterThan(title!.y);
    expect(banner!.y + banner!.height).toBeLessThanOrEqual(tabs!.y);
  };
  const shot = (name: string) => page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true, animations: "disabled" });
  const layout = async (name: string) => {
    const geometry = await page.evaluate(() => {
      const island = document.querySelector<HTMLElement>("main [data-basalt-surface-root]")!;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        bodyHeight: document.body.scrollHeight,
        island: { clientHeight: island.clientHeight, scrollHeight: island.scrollHeight, clientWidth: island.clientWidth, scrollWidth: island.scrollWidth, position: getComputedStyle(island).position },
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
    expect(geometry.island.scrollWidth).toBeLessThanOrEqual(geometry.island.clientWidth);
    expect(geometry.screenReaderLabels.every(label => label.contained)).toBe(true);
  };
  try {
    await page.goto(`${dashboardUrl}/routing/upstreams`);
    await expect(page.getByRole("heading", { name: "Upstreams", exact: true })).toBeVisible();
    await indicator("Connection");
    expect(inspect()).toEqual({ catalogCalls: 0, generationCalls: 0 });
    await page.getByRole("button", { name: "New upstream", exact: true }).click();
    const upstreamDirectory = page.getByRole("navigation", { name: "Upstreams", exact: true });
    await expect(upstreamDirectory.getByRole("button", { name: /Untitled upstream/ })).toContainText("Draft");
    await page.getByLabel("Upstream name", { exact: true }).fill("Discarded provider");
    await expect(upstreamDirectory.getByRole("button", { name: /Discarded provider/ })).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(upstreamDirectory.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(upstreamDirectory.getByRole("button", { name: /GitHub Copilot/ })).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "New upstream", exact: true }).click();
    await page.getByLabel("Upstream name", { exact: true }).fill("Research provider");
    await header("Upstream");
    await select(page, "Native API format", "OpenAI Chat Completions");
    await page.getByLabel("Base URL", { exact: true }).fill(`${receiverUrl}/v1`);
    await page.getByLabel("API key", { exact: true }).fill("fixture-provider");
    const upstream = await save("/api/upstreams", "POST") as { id: string };
    expect(inspect()).toEqual({ catalogCalls: 0, generationCalls: 0 });
    checkpoint("whole-card upstream drafts are visible, discardable and cache-only");
    await shot("upstreams-connection-desktop");

    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await indicator("Models");
    await page.getByRole("button", { name: "Manual model IDs", exact: true }).click();
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

    const upstreamCard = page.getByRole("region", { name: "Upstream configuration", exact: true });
    await page.getByLabel("Test model", { exact: true }).fill("fixture-unexpected");
    await page.getByLabel("Test model", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "Send one test", exact: true }).click();
    const unexpected = upstreamCard.getByRole("status");
    await expect(unexpected).toContainText("Request succeeded · unexpected answer");
    await expect(unexpected.getByRole("region", { name: "Model reply", exact: true })).toHaveText("Fixture reply: hello from the provider.");
    await expect(unexpected.getByRole("region", { name: "Response body", exact: true })).toBeVisible();
    await feedbackPlacement(unexpected);
    expect(inspect().generationCalls).toBe(2);
    await shot("upstream-unexpected-reply-desktop");
    checkpoint("unexpected diagnostics expose the actual reply and native response");

    for (const failure of ["wrong-shape", "non-json"] as const) {
      const before = inspect();
      options.nextCatalogResponse(failure);
      const response = page.waitForResponse(response => response.url().endsWith(`/api/upstreams/${upstream.id}/models/refresh`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "Refresh models", exact: true }).click();
      expect((await response).status()).toBe(503);
      const banner = upstreamCard.getByRole("alert");
      await expect(banner).toContainText("Model refresh failed");
      await expect(banner).toContainText(failure === "wrong-shape" ? "Model discovery did not return a data array" : "Model discovery returned HTTP 502");
      await banner.getByRole("button", { name: "Response details", exact: true }).click();
      await expect(banner.getByText(failure === "wrong-shape" ? "200" : "502", { exact: true })).toBeVisible();
      await expect(banner.getByText("503", { exact: true })).toBeVisible();
      const body = banner.getByRole("region", { name: "Response body", exact: true });
      await expect(body).toContainText(failure === "wrong-shape" ? '"models": []' : "Fixture gateway unavailable");
      await expect(body).toContainText("[REDACTED]");
      await expect(body).not.toContainText("fixture-provider");
      await banner.getByRole("button", { name: "Copy to clipboard", exact: true }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain("[REDACTED]");
      expect(copied).not.toContain("fixture-provider");
      await feedbackPlacement(banner);
      await expect(page.getByRole("list", { name: "Fetched models" }).getByText("fixture-fast", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Manual model IDs", { exact: true })).toHaveValue("Manual.Raw-ID");
      expect(inspect()).toEqual({ catalogCalls: before.catalogCalls + 1, generationCalls: before.generationCalls });
      await shot(`upstream-catalog-${failure}-desktop`);
    }
    await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect(upstreamCard.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
    expect(inspect()).toEqual({ catalogCalls: 4, generationCalls: 2 });
    checkpoint("JSON and HTML discovery failures share detailed redacted feedback and preserve cached models");

    await page.getByRole("button", { name: "New upstream", exact: true }).click();
    await page.getByLabel("Upstream name", { exact: true }).fill("Reasoning provider");
    await select(page, "Native API format", "OpenAI Responses");
    await page.getByLabel("Base URL", { exact: true }).fill(`${receiverUrl}/v1`);
    await page.getByLabel("API key", { exact: true }).fill("fixture-provider");
    await save("/api/upstreams", "POST");
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByLabel("Test model", { exact: true }).fill("fixture-reasoning-only");
    await page.getByLabel("Test model", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "Send one test", exact: true }).click();
    const empty = upstreamCard.getByRole("status");
    await expect(empty).toContainText("Request succeeded · no text returned");
    await expect(empty.getByRole("region", { name: "Model reply", exact: true })).toHaveCount(0);
    await expect(empty.getByText("max_output_tokens", { exact: true })).toBeVisible();
    await expect(empty.getByRole("region", { name: "Response body", exact: true })).toContainText("reasoning");
    await feedbackPlacement(empty);
    expect(inspect()).toEqual({ catalogCalls: 4, generationCalls: 3 });
    await shot("upstream-reasoning-only-desktop");
    checkpoint("reasoning-only Responses diagnostics show the empty answer and finish reason");

    await upstreamDirectory.getByRole("button", { name: /Research provider/ }).click();
    await page.getByRole("tab", { name: "Quota", exact: true }).click();
    await indicator("Quota");
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
    await expect(upstreamCard.getByText(/\bUTC\b/)).toHaveCount(0);
    checkpoint("local quota timetable persists UTC and preserves the five-hour window");
    await shot("upstreams-quota-desktop");

    await page.goto(`${dashboardUrl}/routing/rules`);
    await indicator("Targets");
    await header("Rule");
    await page.getByRole("button", { name: "New rule", exact: true }).click();
    const ruleDirectory = page.getByRole("navigation", { name: "Routing rules", exact: true });
    await expect(ruleDirectory.getByRole("button", { name: /Untitled rule/ })).toContainText("Draft");
    await page.getByLabel("Rule name", { exact: true }).fill("Discarded rule");
    await expect(ruleDirectory.getByRole("button", { name: /Discarded rule/ })).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(ruleDirectory.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Rule name", { exact: true })).toHaveValue("GitHub Copilot");
    await page.getByRole("button", { name: "New rule", exact: true }).click();
    await page.getByLabel("Rule name", { exact: true }).fill("Follow the sun");
    await expect(ruleDirectory.getByRole("button", { name: /Follow the sun/ })).toContainText("Draft");
    await page.getByRole("tab", { name: "Protocol", exact: true }).click();
    await indicator("Protocol");
    await expect(page.getByRole("switch", { name: "Allow protocol conversion" })).not.toBeChecked();
    await page.getByRole("tab", { name: "Targets", exact: true }).click();
    checkpoint("rule drafts appear immediately and initial or switched tabs align");
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

    await page.getByRole("tab", { name: "Protocol", exact: true }).click();
    await page.getByRole("switch", { name: "Allow protocol conversion" }).click();
    await page.getByRole("tab", { name: "Schedule", exact: true }).click();
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
    await expect(page.getByRole("region", { name: "Rule configuration", exact: true }).getByText(/\bUTC\b/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "23:30–01:00", exact: true })).toBeVisible();
    await expect(page.getByText("Local time · Asia/Shanghai", { exact: true })).toBeVisible();
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
    expect(inspect()).toEqual({ catalogCalls: 4, generationCalls: 5 });
    checkpoint("real HTTP key authentication, auto selection, explicit IDs and cached model listing");

    await page.goto(`${dashboardUrl}/requests`);
    const requestRow = page.getByRole("row").filter({ hasText: "Manual.Exact-ID" }).first();
    const instant = await requestRow.locator("time").getAttribute("datetime");
    const localTime = new Date(Date.parse(instant!) + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    await expect(requestRow.locator("time")).toHaveText(localTime);
    await requestRow.click();
    await expect(page.getByRole("region", { name: "Routing details" })).toContainText("Research provider");
    await expect(page.getByRole("region", { name: "Routing details" })).toContainText("Manual.Exact-ID");
    await shot("requests-routing-desktop");
    checkpoint("Requests displays persisted routing, usage and browser-local timestamps");

    await page.goto(`${dashboardUrl}/routing/upstreams`);
    await page.getByRole("navigation", { name: "Upstreams", exact: true }).getByRole("button", { name: /Research provider/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete upstream", exact: true }).click();
    const upstreamEditor = page.getByRole("region", { name: "Upstream configuration", exact: true });
    await expect(upstreamEditor.getByRole("alert")).toContainText("Follow the sun");
    checkpoint("BFF preserves reference conflicts with actionable rule names");
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByLabel("Test model", { exact: true }).fill("fixture-fail");
    await page.getByLabel("Test model", { exact: true }).press("Tab");
    await expect(page.getByLabel("Test model", { exact: true })).toHaveValue("fixture-fail");
    const failedTest = page.waitForResponse(response => response.url().endsWith(`/api/upstreams/${upstream.id}/test`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send one test", exact: true }).click();
    const failureResponse = await failedTest;
    expect(failureResponse.status()).toBe(429);
    const failureBody = await failureResponse.json() as { error: { details: { request_id: string } } };
    const failedDiagnostic = upstreamEditor.getByRole("alert");
    await expect(failedDiagnostic).toContainText("Model test failed");
    await failedDiagnostic.getByRole("button", { name: "Response details", exact: true }).click();
    await expect(failedDiagnostic.getByRole("region", { name: "Response body", exact: true })).toContainText("Fixture quota refusal");
    expect(failureBody.error.details.request_id).toBeTruthy();
    await expect(failedDiagnostic).toContainText(failureBody.error.details.request_id);
    await expect(failedDiagnostic).not.toContainText("fixture-provider");
    await feedbackPlacement(failedDiagnostic);
    expect(inspect().generationCalls).toBe(6);
    await shot("upstream-diagnostic-failure-desktop");
    await page.getByRole("tab", { name: "Quota", exact: true }).click();
    await page.getByRole("button", { name: "Reload status", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reload status", exact: true })).toBeEnabled();
    expect(inspect()).toEqual({ catalogCalls: 4, generationCalls: 6 });
    checkpoint("failed diagnostics stop after one attempt; status reload stays cache-only");

    await page.goto(`${dashboardUrl}/routing/rules`);
    await page.getByRole("navigation", { name: "Routing rules", exact: true }).getByRole("button", { name: /Follow the sun/ }).click();
    await page.getByRole("tab", { name: "Schedule", exact: true }).click();
    await page.evaluate(() => { localStorage.setItem("theme", "dark"); document.documentElement.classList.add("dark"); document.documentElement.classList.remove("light"); document.documentElement.dataset.mode = "dark"; });
    await shot("routing-weekly-dark");
    await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
    await shot("routing-timetable-dark");
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    expect(await page.locator(".routing-enter").evaluateAll(elements => elements.every(element => getComputedStyle(element).animationName === "none"))).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["routing/rules", "routing/upstreams", "connect"]) {
      await page.goto(`${dashboardUrl}/${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      if (path === "routing/rules") await page.getByRole("navigation", { name: "Routing rules", exact: true }).getByRole("button", { name: /Follow the sun/ }).click();
      if (path === "routing/upstreams") await page.getByRole("navigation", { name: "Upstreams", exact: true }).getByRole("button", { name: /Research provider/ }).click();
      await layout(path);
      await shot(`${path.replaceAll("/", "-")}-mobile-dark`);
      if (path === "routing/rules") {
        await indicator("Targets");
        await page.getByRole("tab", { name: "Schedule", exact: true }).click();
        await indicator("Schedule");
        await layout("routing/rules/schedule");
        await page.getByRole("region", { name: "Local schedule visualization" }).scrollIntoViewIfNeeded();
        await shot("routing-timetable-mobile-dark");
        await select(page, "End time", "01:00");
        await expect(page.getByRole("combobox", { name: "Start time", exact: true })).toContainText("23:30");
        await shot("routing-period-mobile-dark");
      } else if (path === "routing/upstreams") {
        await indicator("Connection");
        await page.getByRole("tab", { name: "Quota", exact: true }).click();
        await indicator("Quota");
        await layout("routing/upstreams/quota");
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
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => localStorage.setItem("theme", value), theme);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of [2560, 1920, 1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
        for (const [path, group, title] of [
          ["", "Monitor", "Overview"], ["models", "Monitor", "Models"],
          ["keys", "Monitor", "API Keys"], ["requests", "Monitor", "Requests"],
          ["copilot/models", "Copilot", "Models"], ["copilot/account", "Copilot", "Account"],
          ["routing/rules", "Routing", "Routing Rules"], ["routing/upstreams", "Routing", "Upstreams"],
          ["settings", "Settings", "General"], ["settings/proxy", "Settings", "Proxy"],
          ["settings/server-tools", "Tools", "Server Tools"], ["connect", "Settings", "Connect"],
        ] as const) {
          await page.goto(`${dashboardUrl}/${path}`);
          const frame = page.locator(".dashboard-page");
          const heading = frame.getByRole("heading", { level: 1, name: title, exact: true });
          await expect(heading).toBeVisible();
          const header = page.getByRole("main").locator("header").first();
          await expect(header.getByRole("heading", { name: title, exact: true })).toBeVisible();
          if (width !== 390) await expect(header.getByRole("navigation", { name: "Breadcrumb" })).toHaveText(group);
          const bounds = await frame.boundingBox();
          expect(Math.abs((await heading.boundingBox())!.x - bounds!.x)).toBeLessThan(1);
          const edges = await frame.evaluate(element => {
            const island = element.parentElement!;
            const padding = getComputedStyle(island);
            return { available: island.clientWidth - Number.parseFloat(padding.paddingLeft) - Number.parseFloat(padding.paddingRight), maxWidth: getComputedStyle(element).maxWidth };
          });
          expect(edges.maxWidth).toBe("none");
          expect(Math.abs(bounds!.width - edges.available)).toBeLessThan(1);
          if (width >= 1920) expect(bounds!.width).toBeGreaterThan(1280);
          if (path === "connect") {
            await page.getByRole("tab", { name: "Code", exact: true }).click();
            await indicator("Code");
            await expect(page.getByRole("tab", { name: "Claude Code", exact: true })).toBeHidden();
            await page.getByRole("button", { name: "Client setup guides" }).click();
            await expect(page.getByRole("tab", { name: "Claude Code", exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Client setup guides" }).click();
          }
          if (path === "copilot/account") {
            await expect(page.getByText("fixture-tracking")).toBeHidden();
            await page.getByRole("button", { name: "Endpoints and properties" }).click();
            await expect(page.getByText("fixture-tracking")).toBeVisible();
          }
          if (path === "settings/proxy") {
            await expect(page.getByRole("textbox", { name: "Host", exact: true })).toBeVisible();
            await expect(page.getByLabel(/Username/)).toBeHidden();
            await page.getByRole("button", { name: "Authentication (optional)" }).click();
            await expect(page.getByLabel(/Username/)).toBeVisible();
          }
          if (path === "settings/server-tools") {
            const disclosure = page.getByRole("button", { name: /API key ·/ });
            await expect(disclosure).toHaveAttribute("aria-expanded", "false");
            await disclosure.click();
            await expect(page.getByLabel("Tavily API key")).toBeVisible();
          }
          if (path === "settings") {
            expect(await frame.locator("h2").evaluateAll(headings => headings.every(heading => heading.closest("[data-basalt-surface]")))).toBe(true);
            const disclosure = page.getByRole("button", { name: "Allowed IPs · 0" });
            await expect(disclosure).toHaveAttribute("aria-expanded", "false");
            await expect(page.getByPlaceholder("e.g., 192.168.1.0/24")).toBeHidden();
            await shot(`settings-collapsed-${width}-${theme}`);
            await disclosure.focus();
            await page.keyboard.press("Enter");
            await expect(page.getByPlaceholder("e.g., 192.168.1.0/24")).toBeVisible();
            await expect(page.getByRole("switch", { name: "Restrict client IPs" })).not.toBeChecked();
          }
          const grid = frame.locator(".settings-grid").first();
          if (await grid.count() && width !== 1280) {
            expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(width === 390 ? 1 : 2);
          }
          await layout(`${path || "overview"}/${width}/${theme}`);
          await shot(`${path.replaceAll("/", "-") || "overview"}-${width}-${theme}`);
          if (path === "settings" && width === 1280) {
            await page.getByRole("button", { name: "Collapse sidebar" }).click();
            await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
            await layout(`general/collapsed-sidebar/${theme}`);
            await shot(`general-collapsed-sidebar-${theme}`);
          }
        }
      }
    }
    checkpoint("all 12 sidebar destinations fill the island with responsive cards and disclosures in both themes at four widths");
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    return { checks, errors, blocked, layouts, viewport: [2560, 1080, 1920, 1080, 1440, 1100, 1280, 1080, 390, 844], timezone: "Asia/Shanghai" };
  } catch (error) {
    await shot("failure");
    throw error;
  } finally {
    await browser.close();
  }
}
