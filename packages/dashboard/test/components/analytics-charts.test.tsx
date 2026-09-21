// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { monitorData, entry, summary } from "../helpers/monitor-fixtures";

vi.mock("recharts", async () => (await import("../helpers/recharts-mock")).rechartsMockFactory());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

  it("keeps same-name keys separate and crosses from a key to its model without losing identity", () => {
    const data = monitorData({ filters: { range: "7d", key_id: "key-2" }, keys: [entry("key-1", { account_name: "Editor" }), entry("key-2", { account_name: "Editor" })] });
    render(<UsageExplorer data={data} dimension="key_id" />);
    const keyLinks = screen.getAllByRole("link", { name: /^Editor.*key-/ });
    expect(keyLinks).toHaveLength(2);
    expect(keyLinks[0]).toHaveAttribute("href", "/keys?range=7d&key_id=key-1");
    expect(keyLinks[1]).toHaveAttribute("href", "/keys?range=7d&key_id=key-2");
    const model = screen.getByRole("link", { name: /claude.opus-4.6/ });
    expect(new URL(model.getAttribute("href")!, "https://raven.test").searchParams.get("key_id")).toBe("key-2");
  });

  it("labels ambiguous historical key groups without presenting them as a specific current key", () => {
    render(<UsageExplorer data={monitorData({ filters: { range: "24h", key_id: "legacy:Editor" }, keys: [entry("legacy:Editor", { account_name: "Editor" })] })} dimension="key_id" />);
    expect(screen.getByText("Historical name group · may contain multiple keys")).toBeDefined();
  });

  it("does not turn an unattributed model into a link that silently clears the model filter", () => {
    render(<AnalyticsCharts data={monitorData({ models: [entry("")] })} />);
    expect(screen.getByText("Unattributed").closest("a")).toBeNull();
  });
});
