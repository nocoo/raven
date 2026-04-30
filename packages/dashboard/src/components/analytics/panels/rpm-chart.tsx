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
} from "@/lib/chart-config";
import type { MinuteBucket } from "./types";

function formatMinute(minute: number): string {
  const d = new Date(minute);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function RpmTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const count = payload.find((p) => p.dataKey === "count");
  const errors = payload.find((p) => p.dataKey === "errors");
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label ? formatMinute(label) : ""}</p>
      <p className={TOOLTIP_STYLES.value}>{count?.value ?? 0} requests</p>
      {(errors?.value ?? 0) > 0 && (
        <p className="text-red-500 text-xs">{errors?.value} errors</p>
      )}
    </div>
  );
}

interface RpmChartProps {
  data: MinuteBucket[];
  /** Optional gradient ID (for unique SVG defs when multiple instances on page) */
  gradientId?: string;
}

/**
 * Requests-per-minute area chart. Works with both live SSE buckets and historical API data.
 */
export function RpmChart({ data, gradientId = "rpmFill" }: RpmChartProps) {
  if (data.length < 2) return null;
  const total = data.reduce((sum, b) => sum + b.count, 0);
  const peak = Math.max(...data.map((b) => b.count));
  const summary = `Requests per minute chart. ${total} total requests over ${data.length} minutes. Peak: ${peak} requests/min.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Requests / min
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="minute" tickFormatter={formatMinute} {...AXIS_CONFIG} />
            <YAxis allowDecimals={false} {...AXIS_CONFIG} width={30} />
            <Tooltip content={<RpmTooltip />} />
            <Area
              type="monotone"
              dataKey="count"
              stroke={CHART_COLORS.primary}
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
