"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  getChartColor,
} from "@/lib/chart-config";
import type { ConcurrencyBucket } from "./types";

function formatMinute(minute: number): string {
  const d = new Date(minute);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function ConcurrencyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>
        {label ? formatMinute(label) : ""}
      </p>
      <p className={TOOLTIP_STYLES.value}>
        {payload[0]?.value ?? 0} sessions
      </p>
    </div>
  );
}

interface ConcurrencyChartProps {
  data: ConcurrencyBucket[];
  /** Optional gradient ID (for unique SVG defs when multiple instances on page) */
  gradientId?: string;
}

/**
 * Area chart showing concurrent sessions over time (step-after curve).
 * Works with both live SSE session tracking and historical API data.
 */
export function ConcurrencyChart({ data, gradientId = "concurrencyFill" }: ConcurrencyChartProps) {
  if (data.length < 2) return null;
  const peak = Math.max(...data.map((p) => p.sessions));
  const current = data[data.length - 1]?.sessions ?? 0;
  const summary = `Parallel sessions chart over ${data.length} minutes. Current: ${current} sessions. Peak: ${peak} sessions.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Parallel Sessions
        <span className="ml-1 font-normal text-muted-foreground/60">
          / min
        </span>
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient
                id={gradientId}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={getChartColor(2)}
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor={getChartColor(2)}
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke={CHART_COLORS.muted}
              strokeOpacity={0.3}
            />
            <XAxis
              dataKey="minute"
              tickFormatter={formatMinute}
              {...AXIS_CONFIG}
            />
            <YAxis allowDecimals={false} {...AXIS_CONFIG} width={20} />
            <Tooltip content={<ConcurrencyTooltip />} />
            <Area
              type="stepAfter"
              dataKey="sessions"
              stroke={getChartColor(2)}
              fill={`url(#${gradientId})`}
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
