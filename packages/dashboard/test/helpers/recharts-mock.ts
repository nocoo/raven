/**
 * Shared recharts mock for jsdom-based component tests.
 *
 * recharts needs ResizeObserver, getBBox, and canvas — none of which
 * jsdom provides. Mocking each chart primitive to a thin `<div>` /
 * `<span>` lets us assert layout/text without trying to render SVG.
 *
 * Usage at the top of a test file (BEFORE importing the component):
 *
 *   import { vi } from "vitest";
 *   vi.mock("recharts", async () => {
 *     const { rechartsMockFactory } = await import("../helpers/recharts-mock");
 *     return rechartsMockFactory();
 *   });
 *
 * The dynamic import is required because `vi.mock` is hoisted above
 * top-level imports — a synchronous static import of the helper would
 * be evaluated too late.
 */

import type * as React from "react";

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

// Re-exported as a vi.mock factory so test files can compose it.
export function rechartsMockFactory() {
  // vi.mock factories run before ES imports resolve, so require() is
  // the only way to grab React at factory-invocation time.
  const ReactImpl: typeof React = require("react");

  const MockResponsiveContainer = ({ children }: AnyProps) =>
    ReactImpl.createElement(
      "div",
      { "data-testid": "responsive-container" },
      children,
    );

  const MockChart = ({ children, data }: AnyProps & { data?: unknown[] }) =>
    ReactImpl.createElement(
      "div",
      { "data-testid": "chart", "data-points": String(data?.length ?? 0) },
      children,
    );

  // Components that accept children (e.g. <Legend />, <Tooltip />)
  const MockWithChildren = (props: AnyProps) => {
    const { children, ...rest } = props;
    return ReactImpl.createElement(
      "div",
      {
        "data-testid": "chart-element",
        "data-name": String(rest.name ?? rest.dataKey ?? ""),
      },
      children,
    );
  };

  // Leaf components (Area, Bar, Line, XAxis, YAxis, etc.) — render nothing
  // beyond a span with metadata for query introspection.
  const MockElement = (props: AnyProps) =>
    ReactImpl.createElement("span", {
      "data-testid": "chart-leaf",
      "data-key": String(props.dataKey ?? props.name ?? ""),
    });

  // Pie/Cell — Pie takes a children prop containing Cell nodes; Cell uses
  // an aria-label / fill so tests can assert per-slice metadata.
  const MockPie = ({ children, data }: AnyProps & { data?: unknown[] }) =>
    ReactImpl.createElement(
      "div",
      {
        "data-testid": "chart-pie",
        "data-points": String(data?.length ?? 0),
      },
      children,
    );

  const MockCell = (props: AnyProps & { fill?: string; "aria-label"?: string }) =>
    ReactImpl.createElement("span", {
      "data-testid": "chart-cell",
      "data-fill": props.fill ?? "",
      "aria-label": props["aria-label"] ?? "",
      role: "img",
    });

  return {
    AreaChart: MockChart,
    Area: MockElement,
    BarChart: MockChart,
    ComposedChart: MockChart,
    Bar: MockElement,
    LineChart: MockChart,
    Line: MockElement,
    PieChart: MockChart,
    Pie: MockPie,
    Cell: MockCell,
    XAxis: MockElement,
    YAxis: MockElement,
    CartesianGrid: MockElement,
    Tooltip: MockWithChildren,
    ResponsiveContainer: MockResponsiveContainer,
    Legend: MockElement,
  };
}
