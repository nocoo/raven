// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock recharts to avoid ResizeObserver + canvas issues in jsdom
// ---------------------------------------------------------------------------

vi.mock("recharts", () => {
  const React = require("react");
  const MockResponsiveContainer = ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "responsive-container" }, children);
  const MockChart = ({ children, data }: { children: React.ReactNode; data?: unknown[] }) =>
    React.createElement("div", { "data-testid": "chart", "data-points": String(data?.length ?? 0) }, children);
  // Render children for components that accept them (Legend renders display labels)
  const MockWithChildren = ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
    React.createElement("div", { "data-testid": "chart-element", "data-name": props.name || props.dataKey || "" }, children);
  const MockElement = (props: { name?: string; dataKey?: string }) =>
    React.createElement("span", { "data-testid": "chart-leaf", "data-key": props.dataKey ?? props.name ?? "" });

  return {
    AreaChart: MockChart,
    Area: MockElement,
    BarChart: MockChart,
    Bar: MockElement,
    LineChart: MockChart,
    Line: MockElement,
    XAxis: MockElement,
    YAxis: MockElement,
    CartesianGrid: MockElement,
    Tooltip: MockWithChildren,
    ResponsiveContainer: MockResponsiveContainer,
    Legend: MockElement,
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AnalyticsCharts } from "@/app/analytics-charts";
import type { ExtendedTimeseriesBucket, BreakdownEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBucket(overrides: Partial<ExtendedTimeseriesBucket> = {}): ExtendedTimeseriesBucket {
  return {
    bucket: Date.now(),
    count: 100,
    success_count: 90,
    error_count: 10,
    stream_count: 60,
    sync_count: 40,
    total_tokens: 5000,
    input_tokens: 3000,
    output_tokens: 2000,
    avg_latency_ms: 250,
    p95_latency_ms: 800,
    p99_latency_ms: 1200,
    avg_ttft_ms: 50,
    p95_ttft_ms: 150,
    avg_processing_ms: 200,
    status_codes: { "200": 90, "429": 10 },
    ...overrides,
  };
}

function makeBreakdown(key: string, count: number): BreakdownEntry {
  return {
    key,
    count,
    input_tokens: count * 30,
    output_tokens: count * 20,
    total_tokens: count * 50,
    avg_latency_ms: 300,
    p95_latency_ms: 800,
    avg_ttft_ms: 50,
    error_count: Math.floor(count * 0.1),
    error_rate: 0.1,
    first_seen: Date.now() - 86400000,
    last_seen: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalyticsCharts", () => {
  it("renders section headings after mount", async () => {
    const timeseries = [makeBucket(), makeBucket({ bucket: Date.now() + 3600000 })];
    render(<AnalyticsCharts timeseries={timeseries} />);

    // Wait for useEffect mount
    await vi.waitFor(() => {
      expect(screen.getByText("Traffic")).toBeDefined();
    });

    expect(screen.getByText("Performance")).toBeDefined();
    expect(screen.getByText("Reliability")).toBeDefined();
    expect(screen.getByText("Breakdowns")).toBeDefined();
  });

  it("renders all sections when timeseries has data", async () => {
    const timeseries = [makeBucket()];
    render(<AnalyticsCharts timeseries={timeseries} />);

    await vi.waitFor(() => {
      expect(screen.getByText("Traffic")).toBeDefined();
    });

    // Verify all major sections rendered
    expect(screen.getByText("Performance")).toBeDefined();
    expect(screen.getByText("Reliability")).toBeDefined();
    expect(screen.getByText("Breakdowns")).toBeDefined();
  });

  it("renders chart sub-headings after mount", async () => {
    const timeseries = [makeBucket(), makeBucket()];
    render(<AnalyticsCharts timeseries={timeseries} />);

    await vi.waitFor(() => {
      expect(screen.getByText("Request Volume")).toBeDefined();
    });

    expect(screen.getByText("Stream vs Sync")).toBeDefined();
    expect(screen.getByText("Latency")).toBeDefined();
    expect(screen.getByText("Error Rate")).toBeDefined();
    expect(screen.getByText("Token Usage")).toBeDefined();
  });

  it("renders TTFT chart when data has avg_ttft_ms", async () => {
    const timeseries = [makeBucket({ avg_ttft_ms: 50 }), makeBucket({ avg_ttft_ms: 80 })];
    render(<AnalyticsCharts timeseries={timeseries} />);

    await vi.waitFor(() => {
      expect(screen.getByText("Time to First Token")).toBeDefined();
    });
  });

  it("hides TTFT chart when all buckets have null avg_ttft_ms", async () => {
    const timeseries = [makeBucket({ avg_ttft_ms: null }), makeBucket({ avg_ttft_ms: null })];
    render(<AnalyticsCharts timeseries={timeseries} />);

    await vi.waitFor(() => {
      expect(screen.getByText("Latency")).toBeDefined();
    });

    expect(screen.queryByText("Time to First Token")).toBeNull();
  });

  it("renders breakdown bars with data", async () => {
    const timeseries = [makeBucket()];
    const modelBreakdown = [makeBreakdown("claude-3", 50), makeBreakdown("gpt-4o", 30)];
    const clientBreakdown = [makeBreakdown("vscode", 40)];
    const strategyBreakdown = [makeBreakdown("copilot-native", 60)];

    render(
      <AnalyticsCharts
        timeseries={timeseries}
        modelBreakdown={modelBreakdown}
        clientBreakdown={clientBreakdown}
        strategyBreakdown={strategyBreakdown}
      />,
    );

    await vi.waitFor(() => {
      expect(screen.getByText("Top Models")).toBeDefined();
    });

    expect(screen.getByText("Top Clients")).toBeDefined();
    expect(screen.getByText("Top Strategies")).toBeDefined();
    expect(screen.getByText("claude-3")).toBeDefined();
    expect(screen.getByText("gpt-4o")).toBeDefined();
    expect(screen.getByText("vscode")).toBeDefined();
    expect(screen.getByText("copilot-native")).toBeDefined();
  });

  it("shows 'No data' for empty breakdowns", async () => {
    const timeseries = [makeBucket()];
    render(<AnalyticsCharts timeseries={timeseries} />);

    await vi.waitFor(() => {
      expect(screen.getByText("Top Models")).toBeDefined();
    });

    // All three breakdown sections should show "No data"
    const noDataElements = screen.getAllByText("No data");
    expect(noDataElements.length).toBe(3);
  });

  it("renders breakdown bars with (empty) label for empty keys", async () => {
    const timeseries = [makeBucket()];
    const modelBreakdown = [makeBreakdown("", 50)];

    render(<AnalyticsCharts timeseries={timeseries} modelBreakdown={modelBreakdown} />);

    await vi.waitFor(() => {
      expect(screen.getByText("(empty)")).toBeDefined();
    });
  });
});
