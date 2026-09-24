// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render as baseRender, screen, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@nocoo/basalt";
import type { ReactNode } from "react";

import userEvent from "@testing-library/user-event";
import { monitorData, entry, summary } from "../helpers/monitor-fixtures";

vi.mock("recharts", async () => (await import("../helpers/recharts-mock")).rechartsMockFactory());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());

import { AnalyticsCharts } from "@/app/analytics-charts";
import { MonitorSummary } from "@/components/analytics/panels/monitor-panels";
import { UsageExplorer } from "@/components/analytics/panels/usage-explorer";
import { UsageDistribution } from "@/components/analytics/panels/usage-distribution";

const render = (ui: ReactNode) => baseRender(ui, { wrapper: TooltipProvider });

describe("monitor investigation links", () => {
  it("reveals key identity on hover and keyboard focus without a permanent ID row", async () => {
    const user = userEvent.setup();
    const id = "d210803b-9413-4e8c-b6da-5678109ea884";
    render(<AnalyticsCharts data={monitorData({ keys: [entry(id, { account_name: "Editor" })] })} />);
    const key = screen.getByRole("link", { name: /Editor/ });
    expect(screen.queryByText(id)).toBeNull();
    expect(key).toHaveAttribute("href", expect.stringContaining(`key_id=${id}`));
    await user.hover(key);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(id);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Last in range");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    act(() => key.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(id);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("keeps token-accounting details available from the compact chart header", async () => {
    render(<AnalyticsCharts data={monitorData()} />);
    expect(screen.queryByText(/Cache counters are separate/)).toBeNull();
    act(() => screen.getByRole("button", { name: "About token composition" }).focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Hit rate uses observed input only");
  });

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
    expect(screen.getByRole("tab", { name: "Editor key-2" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "Editor key-2" })).toHaveAttribute("title", "key-2");
    expect(screen.getByRole("tab", { name: "Editor key-2" })).toHaveTextContent(/^Editor$/);
    await userEvent.click(screen.getByRole("tab", { name: "Editor key-2" }));
    expect(push).not.toHaveBeenCalled();
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

  it("keeps the overall ring read-only while showing the selected identity's share", async () => {
    render(<UsageDistribution dimension="key_id" entries={[entry("key-1", { account_name: "Editor" })]} total={40} selected="key-1" />);
    expect(screen.getByRole("img", { name: "40 requests across keys" })).toBeDefined();
    expect(screen.getByText("25.0%")).toBeDefined();
    expect(screen.getByText("Others")).toBeDefined();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "About key distribution" })).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(screen.getByText("Editor"));
    expect(push).not.toHaveBeenCalled();
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

  it.each(["key_id", "model"] as const)("switches the entire %s statistics view without leaving stale drill-downs active", async dimension => {
    let finishNavigation!: () => void;
    push.mockReturnValue(new Promise<void>(resolve => { finishNavigation = resolve; }));
    const data = monitorData({ keys: [entry("first", { account_name: "Editor" }), entry("second", { account_name: "Editor" })], models: [entry("first"), entry("second")], filters: { range: "24h", [dimension]: "first" } });
    const { rerender } = render(<UsageExplorer dimension={dimension} data={data} />);
    const first = dimension === "key_id" ? "Editor first" : "first";
    const second = dimension === "key_id" ? "Editor second" : "second";
    const statistics = within(screen.getByRole("tabpanel", { name: first }));
    expect(statistics.getByText("Traffic", { exact: true })).toBeDefined();
    expect(statistics.getByRole("heading", { name: "Token composition" })).toBeDefined();
    await userEvent.click(screen.getByRole("tab", { name: second }));
    const pending = screen.getByRole("tabpanel", { name: second });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(within(pending).getByRole("status", { name: "Loading usage statistics" })).toBeDefined();
    expect(within(pending).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText("Traffic", { exact: true })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Token composition" })).toBeNull();
    await act(async () => {
      rerender(<UsageExplorer dimension={dimension} data={{ ...data, filters: { range: "24h", [dimension]: "second" }, summary: summary({ total_requests: 4 }) }} />);
      finishNavigation();
    });
    expect(screen.getByRole("tabpanel", { name: second })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("status", { name: "Loading usage statistics" })).toBeNull();
    expect(screen.getByRole("link", { name: "Inspect requests" })).toHaveAttribute("href", `/requests?${dimension}=second`);
    expect(screen.getAllByText("4")).toHaveLength(2);
  });

  it("does not turn an unattributed model into a link that silently clears the model filter", () => {
    render(<AnalyticsCharts data={monitorData({ models: [entry("")] })} />);
    expect(screen.getByText("Unattributed").closest("a")).toBeNull();
  });
});
