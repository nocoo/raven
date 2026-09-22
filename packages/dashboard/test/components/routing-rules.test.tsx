// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { RulesContent } from "@/app/routing/rules/rules-content";
import { fixtureRules, fixtureUpstreams, makeRule } from "../helpers/routing-fixtures";
import "../helpers/routing-interactions";

let fetchSpy: MockInstance<typeof fetch>;
let offsetSpy: MockInstance<() => number>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
  offsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());

const user = () => userEvent.setup({ delay: null });
const nameInput = () => screen.getByRole("textbox", { name: "Rule name" });
const save = () => user().click(screen.getByRole("button", { name: "Save changes" }));

describe("Routing Rules workbench", () => {
  it("shows a protected default chain, native conversion policy and timezone without requests", () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    expect(screen.getByRole("heading", { name: "Routing Rules" })).toBeVisible();
    expect(screen.getByText("Built-in · protected")).toBeVisible();
    expect(screen.getByRole("region", { name: "Default chain" })).toBeVisible();
    expect(screen.getByText(/UTC\+00:00/)).toBeVisible();
    expect(screen.getByRole("switch", { name: "Allow protocol conversion" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("saves a rule edit with exact wire fields and clears dirty state", async () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    fireEvent.change(nameInput(), { target: { value: "Evening work" } });
    await user().click(screen.getByRole("switch", { name: "Allow protocol conversion" }));
    const saved = makeRule({ name: "Evening work", allow_conversion: false });
    fetchSpy.mockResolvedValueOnce(Response.json(saved));
    await save();
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/routing-rules/builtin%3Acopilot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Evening work", mode: "all_day", allow_conversion: false, default_chain: saved.default_chain, periods: [] }),
    });
    expect(screen.getByText(/Rule saved/)).toBeVisible();
    expect(screen.getByText("All changes saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("creates a new rule with conversion off, then opens another pristine draft", async () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    await user().click(screen.getByRole("button", { name: "New rule" }));
    expect(screen.getByRole("switch", { name: "Allow protocol conversion" })).not.toBeChecked();
    fireEvent.change(nameInput(), { target: { value: "Native research" } });
    fetchSpy.mockResolvedValueOnce(Response.json(makeRule({ id: "new-rule", name: "Native research", allow_conversion: false, is_builtin: false })));
    await save();
    expect(fetchSpy).toHaveBeenCalledWith("/api/routing-rules", expect.objectContaining({ method: "POST" }));
    expect(screen.getByRole("navigation", { name: "Routing rules" })).toHaveTextContent("Native research");
    await user().click(screen.getByRole("button", { name: "New rule" }));
    expect(nameInput()).toHaveValue("");
  });

  it("keeps period and default chains separate when saving a scheduled rule", async () => {
    const scheduled = fixtureRules[1]!;
    render(<RulesContent rules={[scheduled]} upstreams={fixtureUpstreams} />);
    const period = screen.getByRole("region", { name: "Period chain" });
    const field = within(period).getByRole("combobox", { name: "Model 1" });
    await user().clear(field); await user().type(field, "unlisted/period-model"); await user().tab();
    const saved = { ...scheduled, periods: scheduled.periods.map(item => item.id === "monday-focus" ? { ...item, targets: [{ ...item.targets[0]!, model: "unlisted/period-model" }, ...item.targets.slice(1)] } : item) };
    fetchSpy.mockResolvedValueOnce(Response.json(saved));
    await save();
    const payload = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(payload.default_chain).toEqual(scheduled.default_chain);
    expect(payload.periods.find((item: { id: string }) => item.id === "monday-focus").targets[0].model).toBe("unlisted/period-model");
    expect(payload.periods.filter((item: { id: string }) => item.id === "friday-night")).toHaveLength(2);
  });

  it("starts a new daily override from an independent copy of the visible default chain", async () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    await user().click(screen.getByRole("radio", { name: "Every day" }));
    await user().click(screen.getByRole("button", { name: "Add period" }));
    const period = within(screen.getByRole("region", { name: "Period chain" }));
    expect(period.getByRole("combobox", { name: "Model 1" })).toHaveValue("gpt-5.6-sol");
    await user().clear(period.getByRole("combobox", { name: "Model 1" }));
    await user().type(period.getByRole("combobox", { name: "Model 1" }), "different-period-model");
    await user().tab();
    expect(within(screen.getByRole("region", { name: "Default chain" })).getByRole("combobox", { name: "Model 1" })).toHaveValue("gpt-5.6-sol");
    fetchSpy.mockResolvedValueOnce(Response.json(makeRule({ mode: "daily", periods: [{ id: "saved", start_minute: 540, end_minute: 600, targets: [{ upstream_id: "builtin:copilot", model: "different-period-model" }] }] })));
    await save();
    expect(screen.getByRole("navigation", { name: "Routing rules" })).toHaveTextContent("Daily timetable");
    expect(JSON.parse(fetchSpy.mock.lastCall![1]!.body as string)).toMatchObject({ mode: "daily", default_chain: [{ upstream_id: "builtin:copilot", model: "gpt-5.6-sol" }], periods: [{ id: expect.any(String), start_minute: 540, end_minute: 600, targets: [{ upstream_id: "builtin:copilot", model: "different-period-model" }] }] });
  });

  it("guards navigation and browser close while dirty, then allows an explicit discard", async () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    fireEvent.change(nameInput(), { target: { value: "Unsaved" } });
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await user().click(screen.getByRole("button", { name: /Working hours.*Weekly timetable/ }));
    await user().click(screen.getByRole("button", { name: "Cancel" }));
    expect(nameInput()).toHaveValue("Unsaved");
    await user().click(screen.getByRole("button", { name: /Working hours.*Weekly timetable/ }));
    await user().click(screen.getByRole("button", { name: "Discard changes" }));
    expect(nameInput()).toHaveValue("Working hours");
    fireEvent.change(nameInput(), { target: { value: "Another edit" } });
    await user().click(screen.getByRole("button", { name: "Discard" }));
    expect(nameInput()).toHaveValue("Working hours");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("validates a draft without sending and retains a failed save for retry", async () => {
    render(<RulesContent rules={[]} upstreams={fixtureUpstreams} />);
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("name");
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.change(nameInput(), { target: { value: "Keep me" } });
    fetchSpy.mockRejectedValueOnce(new Error("Proxy is offline"));
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("Proxy is offline");
    expect(nameInput()).toHaveValue("Keep me");
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not permit duplicate saves or edits while a save is pending", async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    fireEvent.change(nameInput(), { target: { value: "Pending" } });
    await save();
    expect(nameInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => finish(Response.json(makeRule({ name: "Pending" }))));
    expect(nameInput()).not.toBeDisabled();
  });

  it("requires a fresh local-time draft after the browser offset changes", async () => {
    render(<RulesContent rules={fixtureRules} upstreams={fixtureUpstreams} />);
    fireEvent.change(nameInput(), { target: { value: "Timezone moved" } });
    offsetSpy.mockReturnValue(60);
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("timezone offset changed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows reference conflicts on delete, then supports an explicit successful delete", async () => {
    const removable = makeRule({ id: "rule:working-hours", name: "Working hours", is_builtin: false });
    render(<RulesContent rules={[removable, fixtureRules[0]!]} upstreams={fixtureUpstreams} />);
    await user().click(screen.getByRole("button", { name: "Delete" }));
    await user().click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: "Rule is in use.", references: [{ id: "key", name: "Laptop" }] } }, { status: 409 }));
    await user().click(screen.getByRole("button", { name: "Delete" }));
    await user().click(screen.getByRole("button", { name: "Delete rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Laptop");
    expect(nameInput()).toHaveValue("Working hours");
    fetchSpy.mockResolvedValueOnce(Response.json({ success: true }));
    await user().click(screen.getByRole("button", { name: "Delete" }));
    await user().click(screen.getByRole("button", { name: "Delete rule" }));
    expect(await screen.findByText("Rule deleted.")).toBeVisible();
    expect(nameInput()).toHaveValue("GitHub Copilot");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith("/api/routing-rules/rule%3Aworking-hours", { method: "DELETE" });
  });

  it("returns to a creation form after deleting the only custom rule", async () => {
    render(<RulesContent rules={[makeRule({ id: "rule:custom", is_builtin: false })]} upstreams={fixtureUpstreams} />);
    fetchSpy.mockResolvedValueOnce(Response.json({ success: true }));
    await user().click(screen.getByRole("button", { name: "Delete" }));
    await user().click(screen.getByRole("button", { name: "Delete rule" }));
    expect(await screen.findByRole("heading", { name: "New routing rule" })).toBeVisible();
  });
});
