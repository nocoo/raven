// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { monitorData, entry, summary } from "../helpers/monitor-fixtures";

vi.mock("recharts", async () => (await import("../helpers/recharts-mock")).rechartsMockFactory());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());

import { AnalyticsCharts } from "@/app/analytics-charts";
import { MonitorSummary } from "@/components/analytics/panels/monitor-panels";
import { UsageExplorer } from "@/components/analytics/panels/usage-explorer";

describe("monitor investigation links", () => {
  it("carries time, key and native selection into model and error investigation", () => {
    const data = monitorData({ filters: { range: "custom", from: 60_000, to: 239_999, key_id: "key-1", protocol_mode: "native" } });
    render(<AnalyticsCharts data={data} />);
    const model = new URL(screen.getByRole("link", { name: /claude.opus-4.6/ }).getAttribute("href")!, "https://raven.test");
    expect(model.pathname).toBe("/models");
    expect(model.searchParams.get("key_id")).toBe("key-1");
    expect(model.searchParams.get("protocol_mode")).toBe("native");
    expect(model.searchParams.get("from")).toBe("60000");
    const failures = new URL(screen.getByRole("link", { name: "2 errors" }).getAttribute("href")!, model);
    expect(failures.pathname).toBe("/requests");
    expect(failures.searchParams.get("status")).toBe("error");
    expect(failures.searchParams.get("to")).toBe("239999");
  });

  it("does not inflate native adoption by dropping unknown records", () => {
    render(<MonitorSummary summary={summary({ native_count: 4, translated_count: 3, unknown_count: 3 })} percentiles={null} filters={{ range: "24h" }} />);
    expect(screen.getByText("40.0%")).toBeDefined();
    expect(screen.getByRole("link", { name: "3 unknown" })).toHaveAttribute("href", "/requests?protocol_mode=unknown");
  });

  it("switches same-name keys separately and preserves model, protocol and time filters", async () => {
    const data = monitorData({ filters: { range: "7d", key_id: "key-2", account: "Editor", protocol_mode: "native", model: "claude.opus-4.6" }, keys: [entry("key-1", { account_name: "Editor" }), entry("key-2", { account_name: "Editor" })] });
    render(<UsageExplorer data={data} dimension="key_id" />);
    expect(screen.getByRole("tab", { name: "Editor key-2" })).toHaveAttribute("aria-selected", "true");
    const model = screen.getByRole("link", { name: /claude.opus-4.6/ });
    expect(new URL(model.getAttribute("href")!, "https://raven.test").searchParams.get("key_id")).toBe("key-2");
    await userEvent.click(screen.getByRole("tab", { name: "Editor key-1" }));
    expect(push).toHaveBeenLastCalledWith("/keys?range=7d&model=claude.opus-4.6&key_id=key-1&protocol_mode=native", { scroll: false });
    await userEvent.click(screen.getByRole("tab", { name: "All keys" }));
    expect(push).toHaveBeenLastCalledWith("/keys?range=7d&model=claude.opus-4.6&protocol_mode=native", { scroll: false });
  });

  it("selects a model literally named all without clearing it or the calling key", async () => {
    render(<UsageExplorer dimension="model" data={monitorData({ models: [entry("all"), entry("second")], filters: { range: "custom", from: 60_000, to: 239_999, key_id: "key-1", protocol_mode: "translated" } })} />);
    await userEvent.click(screen.getByRole("tab", { name: "all" }));
    expect(push).toHaveBeenLastCalledWith("/models?range=custom&from=60000&to=239999&model=all&key_id=key-1&protocol_mode=translated", { scroll: false });
    expect(screen.getByRole("region", { name: "Calling keys" })).toBeDefined();
  });

  it("keeps an identity outside the top breakdown selectable and clearable", async () => {
    render(<UsageExplorer dimension="key_id" data={monitorData({ filters: { range: "24h", key_id: "unlisted-key" }, keys: [] })} />);
    expect(screen.getByRole("tab", { name: "unlisted-key" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "All keys" }));
    expect(push).toHaveBeenLastCalledWith("/keys", { scroll: false });
  });

  it("selects an identity from the ring legend and does not navigate when it is already selected", async () => {
    const data = monitorData({ filters: { range: "24h", key_id: "key-1" }, distributionTotal: 40 });
    const { rerender } = render(<UsageExplorer dimension="key_id" data={data} />);
    const legend = screen.getByRole("button", { name: "Select Editor · key-1: 10 requests (25.0%)" });
    await userEvent.click(legend);
    expect(push).not.toHaveBeenCalled();
    rerender(<UsageExplorer dimension="key_id" data={{ ...data, filters: { range: "24h" } }} />);
    await userEvent.click(legend);
    expect(push).toHaveBeenLastCalledWith("/keys?key_id=key-1", { scroll: false });
    expect(screen.getByText("Others")).toBeDefined();
  });

  it("labels ambiguous historical key groups without presenting them as a specific current key", () => {
    render(<UsageExplorer data={monitorData({ filters: { range: "24h", key_id: "legacy:Editor" }, keys: [entry("legacy:Editor", { account_name: "Editor" })] })} dimension="key_id" />);
    expect(screen.getByText("Historical name group · may contain multiple keys")).toBeDefined();
  });

  it("distinguishes a name-only filter from all keys and lets All keys clear that filter", async () => {
    render(<UsageExplorer dimension="key_id" data={monitorData({ filters: { range: "7d", account: "Editor", model: "M" } })} />);
    expect(screen.getByRole("tab", { name: "Name group: Editor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "All keys" })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: "All keys" }));
    expect(push).toHaveBeenLastCalledWith("/keys?range=7d&model=M", { scroll: false });
  });

  it("disables request investigation until the new selection finishes loading", async () => {
    let finishNavigation!: () => void;
    push.mockReturnValue(new Promise<void>(resolve => { finishNavigation = resolve; }));
    render(<UsageExplorer dimension="key_id" data={monitorData({ keys: [entry("key-1", { account_name: "Editor" }), entry("key-2", { account_name: "Editor" })], filters: { range: "24h", key_id: "key-1" } })} />);
    await userEvent.click(screen.getByRole("tab", { name: "Editor key-2" }));
    expect(screen.getByRole("status", { name: "Loading usage details" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Inspect requests" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Inspect requests" })).toBeNull();
    await act(async () => finishNavigation());
  });

  it("does not turn an unattributed model into a link that silently clears the model filter", () => {
    render(<AnalyticsCharts data={monitorData({ models: [entry("")] })} />);
    expect(screen.getByText("Unattributed").closest("a")).toBeNull();
  });
});
