// @vitest-environment jsdom
import { toast } from "@nocoo/basalt";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { UpstreamsContent } from "@/app/routing/upstreams/upstreams-content";
import { QuotaEditor, QuotaStatusView } from "@/components/routing/quota-editor";
import { quotaDraft } from "@/lib/upstream-model";
import { fixtureMigration, fixtureQuota, fixtureUpstreams, FIXTURE_NOW, makeCopilot, makeDiagnostic, makeUpstream } from "../helpers/routing-fixtures";
import { selectOption } from "../helpers/routing-interactions";

let fetchSpy: MockInstance<typeof fetch>;
let offsetSpy: MockInstance<() => number>;
beforeEach(() => {
  vi.spyOn(toast, "success").mockReturnValue("fixture-toast");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
  offsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
  vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
});
afterEach(() => vi.restoreAllMocks());

const user = () => userEvent.setup({ delay: null });
const tab = (name: string) => user().click(screen.getByRole("tab", { name }));
const click = (name: string) => user().click(screen.getByRole("button", { name }));
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const payload = () => JSON.parse(fetchSpy.mock.lastCall![1]!.body as string);

describe("Upstreams workbench", () => {
  it("keeps Copilot protected and page reads free from refresh or generation requests", async () => {
    render(<UpstreamsContent upstreams={fixtureUpstreams} migration={null} />);
    expect(screen.getByRole("heading", { name: "Upstreams" })).toBeVisible();
    expect(screen.getByText("Built-in · protected")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Fetched models" })).toBeNull();
    expect(screen.queryByText("No limit")).toBeNull();
    expect(screen.queryByText("Migration summary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("link", { name: "Manage Copilot account" })).toHaveAttribute("href", "/copilot/account");
    expect(screen.queryByRole("combobox", { name: "Native API format" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Enabled" })).toBeNull();
    await tab("Models");
    expect(screen.getByRole("list", { name: "Fetched models" })).toHaveTextContent("gpt-5.6-sol");
    expect(screen.getByText(/Copilot needs a cached endpoint/)).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows persisted migration details, fetched IDs, manual IDs and exact quota usage separately", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={fixtureMigration} />);
    await user().click(screen.getByText("Migration summary"));
    expect(screen.getByText("Retained IDs: research-manual")).toBeVisible();
    expect(screen.getByText("Discarded patterns: research-*")).toBeVisible();
    expect(screen.getByText("Work laptop · builtin:copilot")).toBeVisible();
    await tab("Models");
    expect(screen.getByRole("textbox", { name: "Manual model IDs" })).toHaveValue("research-manual");
    expect(screen.getByRole("list", { name: "Fetched models" })).not.toHaveTextContent("research-manual");
    await tab("Quota");
    expect(screen.getByText("18,420.5", { exact: false })).toBeVisible();
    expect(screen.getByText("81,579.5")).toBeVisible();
    expect(screen.getByText("Usage complete")).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates one custom format with explicit auth/proxy options and no discovery side effect", async () => {
    render(<UpstreamsContent upstreams={[]} migration={null} />);
    expect(screen.getByRole("textbox", { name: "Upstream name" })).toHaveValue("");
    expect(within(screen.getByRole("navigation", { name: "Upstreams" })).getByRole("button", { name: /Untitled upstream.*Draft/ })).toHaveAttribute("aria-current", "true");
    change("Upstream name", "Responses lab");
    change("Base URL", "https://fixture.invalid/responses/v1/");
    change("API key", "synthetic-fixture-secret");
    await selectOption("Native API format", "OpenAI Responses");
    expect(screen.queryByRole("combobox", { name: "Authentication header" })).toBeNull();
    await click("Advanced connection settings");
    await selectOption("Authentication header", "x-api-key");
    await selectOption("SOCKS5 proxy", "Always use proxy");
    await user().click(screen.getByRole("switch", { name: "Enabled" }));
    await user().click(screen.getByRole("switch", { name: "Reasoning support" }));
    await tab("Models");
    expect(screen.getByRole("button", { name: "Refresh models" })).toBeDisabled();
    expect(screen.getByText(/No fetched models yet/)).toBeVisible();
    await click("Manual model IDs");
    change("Manual model IDs", "lab-a, lab-b\nlab-a");
    expect(within(screen.getByRole("navigation", { name: "Upstreams" })).getByRole("button", { name: /Responses lab.*Draft/ })).toHaveAttribute("aria-current", "true");
    const configuration = within(screen.getByRole("region", { name: "Upstream configuration" }));
    expect(configuration.getByRole("textbox", { name: "Upstream name" })).toHaveValue("Responses lab");
    expect(configuration.getByRole("button", { name: "Save changes" })).toBeEnabled();
    fetchSpy.mockResolvedValueOnce(Response.json(makeUpstream({ id: "new:lab", name: "Responses lab", format: "responses", is_enabled: false, manual_models: ["lab-a", "lab-b"], quota: null })));
    await click("Save changes");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/upstreams");
    expect(payload()).toEqual({ name: "Responses lab", base_url: "https://fixture.invalid/responses/v1", format: "responses", api_key: "synthetic-fixture-secret", is_enabled: false, supports_reasoning: true, auth_style: "x-api-key", use_socks5: true, manual_models: ["lab-a", "lab-b"], quota: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Upstream saved.", expect.any(Object)));
    expect(screen.getByRole("navigation", { name: "Upstreams" })).toHaveTextContent("Responses lab");
  });

  it("keeps the saved secret when editing a connection and allows returning auth/proxy overrides to defaults", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={null} />);
    await tab("Connection");
    expect(screen.getByLabelText("Replace API key")).toHaveValue("");
    change("Upstream name", "Renamed research");
    expect(screen.getByRole("button", { name: "Advanced connection settings" })).toHaveAttribute("aria-expanded", "true");
    await selectOption("Authentication header", "Protocol default");
    await selectOption("SOCKS5 proxy", "Direct connection");
    await selectOption("SOCKS5 proxy", "Use Raven setting");
    fetchSpy.mockResolvedValueOnce(Response.json(makeUpstream({ name: "Renamed research", auth_style: null, use_socks5: null })));
    await click("Save changes");
    expect(fetchSpy.mock.lastCall?.[0]).toBe("/api/upstreams/custom%3Aresearch");
    expect(payload()).not.toHaveProperty("api_key");
    expect(payload()).toMatchObject({ name: "Renamed research", auth_style: null, use_socks5: null });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("refreshes only on POST, adopts the enriched status and preserves manual IDs on failure", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={null} />);
    await tab("Models");
    const refreshed = makeUpstream({ models: [{ id: "new-fetched", supported_endpoints: ["/responses"] }], quota_status: { ...makeUpstream().quota_status, remaining_tokens: 12_345.5 } });
    fetchSpy.mockResolvedValueOnce(Response.json(refreshed));
    await click("Refresh models");
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/upstreams/custom%3Aresearch/models/refresh", { method: "POST" });
    expect(screen.getByRole("list", { name: "Fetched models" })).toHaveTextContent("new-fetched");
    expect(screen.getByRole("textbox", { name: "Manual model IDs" })).toHaveValue("research-manual");
    await tab("Quota");
    expect(screen.getByText("12,345.5")).toBeVisible();
    await tab("Models");
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: "Catalog authentication failed", type: "upstream_error" } }, { status: 502 }));
    await click("Refresh models");
    expect(screen.getByRole("alert")).toHaveTextContent("Catalog authentication failed");
    expect(screen.getByRole("list", { name: "Fetched models" })).toHaveTextContent("new-fetched");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("runs one quota-accounted diagnostic, independently reports expected_pong=%s, and reloads cached status only on demand", async expected => {
    let finish!: (response: Response) => void;
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={null} />);
    await tab("Models");
    const input = screen.getByRole("combobox", { name: "Test model" });
    await user().clear(input); await user().type(input, "vendor/unlisted"); await user().tab();
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    await click("Send one test");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.lastCall?.[0]).toBe("/api/upstreams/custom%3Aresearch/test");
    expect(payload()).toEqual({ model: "vendor/unlisted" });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh models" })).toBeDisabled();
    await click("Send one test");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => finish(Response.json(makeDiagnostic({ model: "vendor/unlisted", latency_ms: 42, answer: expected ? "pong" : "Hello from fixture", expected_pong: expected }))));
    expect(screen.getByText(expected ? "Received pong" : "Request succeeded · unexpected answer")).toBeVisible();
    expect(screen.getByText(/42 ms · openai/)).toBeVisible();
    expect(screen.getByLabelText("Model reply")).toHaveTextContent(expected ? "pong" : "Hello from fixture");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockResolvedValueOnce(Response.json(makeUpstream({ quota_status: { ...makeUpstream().quota_status, used_tokens: 18_425.5 } })));
    await tab("Quota");
    await click("Reload status");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Quota status updated.", expect.any(Object)));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.lastCall?.[0]).toBe("/api/upstreams/custom%3Aresearch");
    expect(fetchSpy.mock.lastCall?.[1]?.method).toBeUndefined();
  });

  it("requires an explicit model and a saved configuration, and never retries a failed generation", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={null} />);
    await tab("Models");
    const input = screen.getByRole("combobox", { name: "Test model" });
    await user().clear(input); await user().type(input, "auto"); await user().tab();
    expect(screen.getByRole("button", { name: "Send one test" })).toBeDisabled();
    await user().clear(input); await user().tab();
    expect(screen.getByRole("button", { name: "Send one test" })).toBeDisabled();
    await user().type(input, "raw-id"); await user().tab();
    change("Manual model IDs", "new-manual");
    expect(screen.getByRole("button", { name: "Send one test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh models" })).toBeDisabled();
    expect(screen.getByText(/Save or discard changes before/)).toBeVisible();
    await tab("Quota");
    expect(screen.getByRole("button", { name: "Reload status" })).toBeDisabled();
    await tab("Models");
    await click("Discard");
    fetchSpy.mockRejectedValueOnce(new Error("Generation connection lost"));
    await click("Send one test");
    expect(screen.getByRole("alert")).toHaveTextContent("Generation connection lost");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Received pong")).toBeNull();
  });

  it("edits protected Copilot quota using local reset time and the shared multiplier timetable", async () => {
    offsetSpy.mockReturnValue(-480);
    render(<UpstreamsContent upstreams={[makeCopilot()]} migration={null} />);
    await tab("Quota");
    await user().click(screen.getByRole("switch", { name: "Enable shared token quota" }));
    expect(screen.getByRole("spinbutton", { name: "Window (minutes)" })).toHaveValue(300);
    change("1× token allowance", "20000");
    change("Window (minutes)", "60");
    change("Next reset (local time)", "2026-09-22T17:00");
    expect(screen.getByText("2026-09-22 17:00")).toBeVisible();
    expect(screen.queryByText(/2026-09-22 09:00 UTC/)).toBeNull();
    await user().click(screen.getByRole("radio", { name: "Every day" }));
    await click("Add period");
    await selectOption("End time", "09:30");
    change("Token multiplier", "0.5");
    fetchSpy.mockResolvedValueOnce(Response.json(makeCopilot({ quota: { ...fixtureQuota, limit_tokens: 20_000, window_minutes: 60, mode: "daily", multipliers: [{ id: "saved-period", start_minute: 60, end_minute: 90, multiplier: 0.5 }] } })));
    await click("Save changes");
    expect(payload()).toEqual({ manual_models: [], quota: { limit_tokens: 20_000, window_minutes: 60, next_reset_at: Date.UTC(2026, 8, 22, 9), mode: "daily", multipliers: [{ id: expect.any(String), start_minute: 60, end_minute: 90, multiplier: 0.5 }] } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("disables quota without resetting usage and validates an invalid reset draft before sending", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream()]} migration={null} />);
    await tab("Quota");
    change("Next reset (local time)", "");
    expect(screen.getByText("Choose a valid reset time")).toBeVisible();
    await click("Save changes");
    expect(screen.getByRole("alert")).toHaveTextContent("valid next reset");
    expect(fetchSpy).not.toHaveBeenCalled();
    await user().click(screen.getByRole("switch", { name: "Enable shared token quota" }));
    expect(screen.queryByLabelText("1× token allowance")).toBeNull();
    fetchSpy.mockResolvedValueOnce(Response.json(makeUpstream({ quota: null })));
    await click("Save changes");
    expect(payload().quota).toBeNull();
    expect(payload()).not.toHaveProperty("used_tokens");
  });

  it("guards dirty selection and clears failed saves only on edit or discard", async () => {
    render(<UpstreamsContent upstreams={fixtureUpstreams} migration={null} />);
    await tab("Models");
    await click("Manual model IDs");
    change("Manual model IDs", "keep-this");
    fetchSpy.mockRejectedValueOnce(new Error("Storage unavailable"));
    await click("Save changes");
    expect(screen.getByRole("alert")).toHaveTextContent("Storage unavailable");
    expect(screen.getByRole("textbox", { name: "Manual model IDs" })).toHaveValue("keep-this");
    await user().click(within(screen.getByRole("navigation", { name: "Upstreams" })).getByRole("button", { name: /Research gateway/ }));
    await click("Cancel");
    expect(screen.getByRole("textbox", { name: "Manual model IDs" })).toHaveValue("keep-this");
    await click("New upstream");
    await click("Discard changes");
    expect(screen.getByRole("textbox", { name: "Upstream name" })).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("discards an entire draft across tabs and returns to the prior saved upstream", async () => {
    render(<UpstreamsContent upstreams={fixtureUpstreams} migration={null} />);
    const directory = within(screen.getByRole("navigation", { name: "Upstreams" }));
    await user().click(directory.getByRole("button", { name: /Research gateway/ }));
    change("Upstream name", "Edited gateway");
    await user().click(directory.getByRole("button", { name: /Edited gateway/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText("Upstream name")).toHaveValue("Edited gateway");
    await click("Discard");
    await click("New upstream");
    await user().click(directory.getByRole("button", { name: /Research gateway/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await click("New upstream");
    change("Upstream name", "Temporary provider");
    await tab("Models");
    await click("Manual model IDs");
    change("Manual model IDs", "temporary-model");
    await click("Discard");
    expect(screen.getByLabelText("Upstream name")).toHaveValue("Research gateway");
    expect(screen.getByLabelText("Manual model IDs")).toHaveValue("research-manual");
    expect(directory.queryByText("Draft")).toBeNull();
    expect(directory.getByRole("button", { name: /Research gateway/ })).toHaveAttribute("aria-current", "true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves referenced upstreams on conflict and deletes only after explicit confirmation", async () => {
    render(<UpstreamsContent upstreams={[makeUpstream(), makeCopilot()]} migration={null} />);
    await click("Delete"); await click("Cancel");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: "Upstream is in use", references: [{ id: "rule:work", name: "Work rule" }] } }, { status: 409 }));
    await click("Delete"); await click("Delete upstream");
    expect(screen.getByRole("alert")).toHaveTextContent("Work rule");
    expect(screen.getByRole("navigation", { name: "Upstreams" })).toHaveTextContent("Research gateway");
    fetchSpy.mockResolvedValueOnce(Response.json({ success: true }));
    await click("Delete"); await click("Delete upstream");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Upstream deleted.", expect.any(Object)));
    expect(screen.getByRole("navigation", { name: "Upstreams" })).not.toHaveTextContent("Research gateway");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh form after deleting the last custom upstream and shows retained catalog failures", async () => {
    const upstream = makeUpstream({ models: [], manual_models: [], last_refreshed_at: null, last_refresh_error: "Fixture timeout", is_enabled: false });
    render(<UpstreamsContent upstreams={[upstream]} migration={{ ...fixtureMigration, upstreams: [{ ...fixtureMigration.upstreams[0]!, retained_models: [], discarded_patterns: [] }] }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    await tab("Models");
    expect(screen.getByText("Last refresh: Never")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Cached models were retained");
    await user().click(screen.getByText("Migration summary"));
    expect(screen.getByText("Retained IDs: None")).toBeVisible();
    expect(screen.getByText("Discarded patterns: None")).toBeVisible();
    fetchSpy.mockResolvedValueOnce(Response.json({ success: true }));
    await click("Delete"); await click("Delete upstream");
    expect(within(screen.getByRole("navigation", { name: "Upstreams" })).getByRole("button", { name: /Untitled upstream.*Draft/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox", { name: "Upstream name" })).toHaveValue("");
  });
});

describe("quota health presentation", () => {
  it.each([true, false])("explains unhealthy accounting with quota enabled=%s", limited => {
    const upstream = makeUpstream({ quota: limited ? fixtureQuota : null, quota_status: { ...makeUpstream().quota_status, healthy: false, usage_complete: false, remaining_tokens: 0, used_tokens: 100_001.5 } });
    render(<QuotaStatusView upstream={upstream} />);
    expect(screen.getByText("Accounting blocked")).toBeVisible();
    expect(screen.getByText(/Usage incomplete/)).toBeVisible();
    expect(screen.getByText(limited ? "Exhausted" : "No limit")).toBeVisible();
    expect(screen.getByText(limited ? /New requests stop/ : /requests may proceed/)).toBeVisible();
  });

  it("keeps an invalid multiplier draft editable", () => {
    const draft = { ...quotaDraft(fixtureQuota, 0, FIXTURE_NOW), mode: "daily" as const, windows: [{ id: "bad", day: 0, start: 540, end: 570, value: Number.NaN }] };
    render(<QuotaEditor value={draft} onChange={vi.fn()} clock={{ offset: 0, zone: "UTC", now: FIXTURE_NOW }} />);
    expect(screen.getByRole("spinbutton", { name: "Token multiplier" })).toHaveValue(null);
  });
});
