"use client";

/**
 * Chart primitives — see docs/22-dashboard-design-system.md (Rule 6).
 *
 * Three reusable atoms that every recharts panel should use:
 *   - <DashboardCartesianGrid />  — opinionated default grid
 *   - <ChartTooltip />            — overlay-styled tooltip container
 *   - <ChartTooltipRow />         — single key/value row inside the tooltip
 *   - <ChartTooltipSummary />     — bottom summary row (e.g. Total)
 *
 * The tooltip atoms render the L3 overlay treatment: bg-popover, border, shadow.
 */

import type { ReactNode } from "react";
import { CartesianGrid } from "recharts";
import { cn } from "@/lib/utils";

interface DashboardCartesianGridProps {
  /** Override stroke color (defaults to `var(--chart-axis)` via CSS) */
  stroke?: string;
  /** Override dash pattern */
  strokeDasharray?: string;
  /** Override opacity (defaults to 0.15) */
  strokeOpacity?: number;
  /** Show vertical grid lines (defaults to false) */
  vertical?: boolean;
}

/**
 * Standard CartesianGrid for all dashboard charts.
 * Defaults match Rule 6: dashed, low opacity, horizontal-only.
 */
export function DashboardCartesianGrid({
  stroke,
  strokeDasharray = "3 3",
  strokeOpacity = 0.15,
  vertical = false,
}: DashboardCartesianGridProps) {
  return (
    <CartesianGrid
      stroke={stroke ?? "hsl(var(--chart-axis))"}
      strokeDasharray={strokeDasharray}
      strokeOpacity={strokeOpacity}
      vertical={vertical}
    />
  );
}

interface ChartTooltipProps {
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Tooltip container — L3 overlay surface.
 * Use as the `content` of recharts `<Tooltip>`, with the active/payload
 * gating handled by the caller.
 */
export function ChartTooltip({ title, className, children }: ChartTooltipProps) {
  return (
    <div
      className={cn(
        "rounded-md border bg-popover px-3 py-2 text-sm shadow-lg",
        "min-w-[140px]",
        className,
      )}
    >
      {title !== undefined && title !== null && title !== "" && (
        <p className="mb-1 font-medium text-popover-foreground">{title}</p>
      )}
      {children}
    </div>
  );
}

interface ChartTooltipRowProps {
  color?: string;
  label: ReactNode;
  value: ReactNode;
}

/**
 * Single key/value row inside a tooltip.
 * `color` renders a small swatch matching the series color.
 */
export function ChartTooltipRow({ color, label, value }: ChartTooltipRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: color }}
          />
        )}
        {label}
      </span>
      <span className="font-medium text-popover-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

interface ChartTooltipSummaryProps {
  label: ReactNode;
  value: ReactNode;
}

/**
 * Summary row (typically "Total") at the bottom of a tooltip,
 * separated by a divider.
 */
export function ChartTooltipSummary({ label, value }: ChartTooltipSummaryProps) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/30 pt-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-popover-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}
