// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { Input } from "@nocoo/basalt";
import { describe, expect, it, vi } from "vitest";
import { ChainEditor } from "@/components/routing/chain-editor";
import { ScheduleEditor } from "@/components/routing/schedule-editor";
import type { RoutingTarget, ScheduleMode } from "@/lib/routing-types";
import type { LocalWindow } from "@/lib/routing-schedule";
import { fixtureUpstreams, makeCopilot, makeUpstream } from "../helpers/routing-fixtures";
import { selectOption } from "../helpers/routing-interactions";

const custom = { upstream_id: "custom:research", model: "research-large" };
const copilot = { upstream_id: "builtin:copilot", model: "gpt-5.6-sol" };

function ChainHarness({ initial = [custom, copilot], onChange = vi.fn() }: { initial?: RoutingTarget[]; onChange?: (value: RoutingTarget[]) => void }) {
  const [chain, setChain] = useState(initial);
  return <ChainEditor label="Test chain" value={chain} upstreams={fixtureUpstreams} conversion={false} onChange={next => { setChain(next); onChange(next); }} />;
}

describe("ordered target controls", () => {
  it("exposes terminal semantics and keeps the native/blocked protocol preview available on demand", async () => {
    render(<ChainHarness />);
    const rows = within(screen.getByRole("list", { name: "Test chain targets" })).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Quota candidate")).toBeVisible();
    expect(within(rows[1]!).getByText("Terminal fallback")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Target 1 protocol preview" })).toBeNull();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Protocol preview" }));
    const preview = within(screen.getByRole("region", { name: "Target 1 protocol preview" }));
    expect(preview.getByText("Chat:", { exact: false })).toHaveTextContent("Native");
    expect(preview.getByText("Responses:", { exact: false })).toHaveTextContent("Blocked");
    expect(screen.getByRole("button", { name: "Move target 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move target 2 down" })).toBeDisabled();
  });

  it("selects a cached upstream model and accepts an unlisted raw model on blur", async () => {
    const changes = vi.fn();
    render(<ChainHarness onChange={changes} />);
    await selectOption("Upstream 1", "GitHub Copilot");
    const model = screen.getByRole("combobox", { name: "Model 1" });
    expect(model).toHaveValue("gpt-5.6-sol");
    const user = userEvent.setup({ delay: null });
    await user.clear(model); await user.type(model, "vendor/raw-model"); await user.tab();
    expect(changes.mock.lastCall?.[0][0]).toEqual({ upstream_id: "builtin:copilot", model: "vendor/raw-model" });
    await user.click(screen.getByRole("button", { name: "Protocol preview" }));
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/unreachable/)).toBeVisible();
  });

  it("keeps one required terminal target and inserts new quota candidates before it", async () => {
    render(<ChainHarness initial={[copilot]} />);
    const user = userEvent.setup({ delay: null });
    expect(screen.getByRole("button", { name: "Remove target 1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add quota candidate" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove target 1" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Target", { exact: true })).toBeVisible();
  });

  it("supports drag/drop, cancels stale drags, and preserves the model/upstream pair", () => {
    const changes = vi.fn();
    render(<ChainHarness onChange={changes} />);
    const rows = screen.getAllByRole("listitem");
    fireEvent.dragOver(rows[1]!);
    fireEvent.drop(rows[1]!);
    expect(changes).not.toHaveBeenCalled();
    const handle = screen.getByRole("button", { name: "Move target 1" });
    const transfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("text/plain", expect.stringContaining(":0"));
    expect(rows[0]).toHaveAttribute("data-dragging", "true");
    fireEvent.dragOver(rows[1]!);
    expect(rows[1]).toHaveAttribute("data-over", "true");
    fireEvent.drop(rows[1]!);
    expect(changes).toHaveBeenLastCalledWith([copilot, custom]);
    expect(screen.getByRole("combobox", { name: "Model 2" })).toHaveValue("research-large");
    fireEvent.dragEnd(handle);
    expect(screen.getAllByRole("listitem").every(row => row.getAttribute("data-dragging") === "false")).toBe(true);
  });

  it("supports keyboard and visible button reordering with retained focus", async () => {
    const changes = vi.fn();
    render(<ChainHarness onChange={changes} />);
    const handle = screen.getByRole("button", { name: "Move target 1" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(changes).toHaveBeenLastCalledWith([copilot, custom]);
    expect(handle).toHaveFocus();
    fireEvent.keyDown(handle, { key: "ArrowUp", altKey: true });
    expect(changes).toHaveBeenLastCalledWith([custom, copilot]);
    fireEvent.keyDown(handle, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(changes).toHaveBeenCalledTimes(2);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Move target 1 down" }));
    expect(changes).toHaveBeenLastCalledWith([copilot, custom]);
    await user.click(screen.getByRole("button", { name: "Move target 2 up" }));
    expect(changes).toHaveBeenLastCalledWith([custom, copilot]);
  });

  it("allows configuring a disabled upstream and accurately marks unavailable catalogs", async () => {
    const changes = vi.fn();
    const upstreams = [makeUpstream({ is_enabled: false, models: [], manual_models: [] }), makeCopilot()];
    const { rerender } = render(<ChainEditor label="Empty cache" value={[custom]} upstreams={upstreams} conversion onChange={changes} />);
    expect(screen.getByText("Disabled · request stops")).toBeInTheDocument();
    rerender(<ChainEditor label="Empty cache" value={[copilot]} upstreams={upstreams} conversion onChange={changes} />);
    await selectOption("Upstream 1", "Research gateway · disabled");
    expect(changes).toHaveBeenCalledWith([{ ...custom, model: "" }]);
  });

  it("keeps an editable placeholder if all upstreams have disappeared", async () => {
    const changes = vi.fn();
    render(<ChainEditor label="Missing" value={[custom]} upstreams={[]} conversion={false} onChange={changes} />);
    expect(screen.getByText("Missing upstream")).toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Add quota candidate" }));
    expect(changes).toHaveBeenCalledWith([{ upstream_id: "", model: "" }, custom]);
  });
});

function ScheduleHarness({ initialMode = "all_day", initial = [], onChange = vi.fn() }: { initialMode?: ScheduleMode; initial?: LocalWindow<number>[]; onChange?: (mode: ScheduleMode, windows: LocalWindow<number>[]) => void }) {
  const [mode, setMode] = useState(initialMode);
  const [windows, setWindows] = useState(initial);
  return <ScheduleEditor mode={mode} windows={windows} offset={0} onChange={(nextMode, nextWindows) => { setMode(nextMode); setWindows(nextWindows); onChange(nextMode, nextWindows); }} newValue={() => 1} summarize={value => `${value}×`}
    renderValue={(value, change) => <Input aria-label="Period value" value={value} onChange={event => change(Number(event.target.value))} />} emptyLabel="Default covers all day" />;
}
const morning = { id: "morning", day: 0, start: 540, end: 600, value: 1 };

describe("visual schedule workbench", () => {
  it("bounds the 49-option time popup and supports keyboard selection across midnight", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="weekly" initial={[{ ...morning, start: 1410, end: 1440 }]} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    const trigger = screen.getByRole("combobox", { name: "End time" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const popup = await screen.findByRole("listbox");
    const options = within(popup).getAllByRole("option", { hidden: true });
    expect(popup).toBeVisible();
    expect(options).toHaveLength(49);
    expect(popup).toHaveStyle({ maxHeight: "min(20rem, var(--radix-select-content-available-height))" });
    expect(popup.querySelector("[data-radix-select-viewport]")).toHaveStyle({ overflow: "hidden auto" });
    expect(options[48]).toHaveTextContent("24:00");
    await waitFor(() => expect(options[48]).toHaveFocus());
    await user.keyboard("{Home}");
    expect(options[0]).toHaveTextContent("00:00");
    await waitFor(() => expect(options[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveTextContent("00:30");
    await waitFor(() => expect(options[1]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(options[2]).toHaveTextContent("01:00");
    await waitFor(() => expect(options[2]).toHaveFocus());
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveTextContent("01:00");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByText("Ends next day")).toBeVisible();
    expect(changes).toHaveBeenLastCalledWith("weekly", [{ ...morning, start: 1410, end: 1500 }]);
  });

  it("edits local overnight ranges without exposing storage fragments", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    expect(screen.getByText("Default covers all day")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Every day" }));
    await user.click(screen.getByRole("button", { name: "Add period" }));
    await selectOption("Start time", "23:00");
    await selectOption("End time", "01:00");
    expect(screen.getByText("Ends next day")).toBeVisible();
    expect(screen.getByRole("button", { name: "23:00–01:00" })).toBeVisible();
    expect(screen.queryByText(/UTC/)).toBeNull();
    expect(changes.mock.lastCall?.[1][0]).toMatchObject({ day: 0, start: 1380, end: 1500 });
    fireEvent.change(screen.getByRole("textbox", { name: "Period value" }), { target: { value: "0.5" } });
    expect(changes.mock.lastCall?.[1][0].value).toBe(0.5);
    await user.click(screen.getByRole("button", { name: /overnight continuation/ }));
    expect(screen.getByText("Ends next day")).toBeVisible();
  });

  it("chooses weekdays, edits start day and copies periods under new identities", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="weekly" initial={[morning]} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    await selectOption("Starts on", "Tuesday");
    expect(changes.mock.lastCall?.[1][0].day).toBe(1);
    await user.click(screen.getByRole("button", { name: "Copy day" }));
    const dialog = within(screen.getByRole("dialog", { name: "Copy Tuesday" }));
    await user.click(dialog.getByRole("checkbox", { name: "Thursday" }));
    const friday = dialog.getByRole("checkbox", { name: "Friday" });
    await user.click(friday);
    await user.click(friday);
    await user.click(dialog.getByRole("button", { name: "Apply copy" }));
    const copied = changes.mock.lastCall?.[1] as LocalWindow<number>[];
    expect(copied.map(window => window.day)).toEqual([1, 3]);
    expect(copied[1]!.id).not.toBe(morning.id);
    expect(copied[1]).toMatchObject({ day: 3, start: 540, end: 600, value: 1 });
    await user.click(screen.getByRole("button", { name: "Thu" }));
    expect(screen.getByRole("button", { name: /Thursday 09:00 to 10:00/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "09:00–10:00" }));
    expect(screen.getByRole("combobox", { name: "Starts on" })).toHaveTextContent("Thursday");
  });

  it("cancels day copying without changing periods", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="weekly" initial={[morning]} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Copy day" }));
    const dialog = within(screen.getByRole("dialog", { name: "Copy Monday" }));
    await user.click(dialog.getByRole("checkbox", { name: "Thursday" }));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("adds a period on an empty weekday without changing existing periods", async () => {
    const changes = vi.fn();
    const initial = [morning, { ...morning, id: "thursday", day: 3 }];
    render(<ScheduleHarness initialMode="weekly" initial={initial} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Wed" }));
    await user.click(screen.getByRole("button", { name: "Add a period" }));
    expect(changes).toHaveBeenCalledExactlyOnceWith("weekly", [...initial, { id: expect.any(String), day: 2, start: 540, end: 600, value: 1 }]);
  });

  it("refuses the complete copy on overlap with an overnight tail", async () => {
    const initial = [{ ...morning, start: 30, end: 120 }, { ...morning, id: "late", start: 1380, end: 1530 }];
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="weekly" initial={initial} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Copy day" }));
    await user.click(screen.getByRole("checkbox", { name: "Tuesday" }));
    await user.click(screen.getByRole("button", { name: "Apply copy" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("overlap");
    expect(changes).not.toHaveBeenCalled();
  });

  it("confirms removal of overrides when changing recurrence modes", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="weekly" initial={[morning]} onChange={changes} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("radio", { name: "Every day" }));
    expect(screen.getByText(/Only periods starting on Monday/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(changes).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Every day" }));
    await user.click(screen.getByRole("button", { name: "Change timetable" }));
    expect(changes.mock.lastCall?.[0]).toBe("daily");
    await user.click(screen.getByRole("radio", { name: "Weekly" }));
    expect(changes.mock.lastCall?.[1]).toHaveLength(7);
    await user.click(screen.getByRole("radio", { name: "All day" }));
    await user.click(screen.getByRole("button", { name: "Change timetable" }));
    expect(changes).toHaveBeenLastCalledWith("all_day", []);
  });

  it("reports a full day, removes a period, and rejects zero-length ranges", async () => {
    render(<ScheduleHarness initialMode="daily" initial={[{ ...morning, start: 0, end: 1440 }]} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Add period" }));
    expect(screen.getByRole("alert")).toHaveTextContent("day is full");
    await user.click(screen.getByRole("button", { name: "Remove period" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add a period" }));
    await selectOption("End time", "09:00");
    expect(screen.getByRole("alert")).toHaveTextContent("nonempty period");
  });

  it("retains a malformed draft instead of silently saving overlapping weekly copies", async () => {
    const changes = vi.fn();
    render(<ScheduleHarness initialMode="daily" initial={[morning, { ...morning, id: "overlap", start: 570, end: 630 }]} onChange={changes} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("radio", { name: "Weekly" }));
    expect(screen.getByRole("alert")).toHaveTextContent("overlap");
    expect(changes).not.toHaveBeenCalled();
  });

  it("preserves offset minutes while offering half-hour edits in a fractional timezone", async () => {
    const changes = vi.fn();
    const initial = [{ ...morning, start: 555, end: 615 }];
    render(<ScheduleEditor mode="daily" windows={initial} offset={-345} onChange={changes} newValue={() => 1} summarize={value => `${value}×`} renderValue={() => null} emptyLabel="Default" />);
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveTextContent("09:15");
    expect(screen.getByRole("button", { name: "09:15–10:15" })).toBeVisible();
    expect(screen.queryByText(/UTC/)).toBeNull();
    await selectOption("Start time", "09:30");
    expect(changes).toHaveBeenCalledWith("daily", [{ ...initial[0], start: 570 }]);
  });
});
