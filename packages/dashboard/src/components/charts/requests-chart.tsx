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
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, RESPONSIVE_CONTAINER_PROPS } from "@/lib/chart-config";
import type { TimeseriesBucket } from "@/lib/types";

interface RequestsChartProps {
  data: TimeseriesBucket[];
}

function formatTime(bucket: number): string {
  const d = new Date(bucket);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label ? formatTime(label) : ""}</p>
      <p className={TOOLTIP_STYLES.value}>
        {payload[0]?.value?.toLocaleString() ?? 0} requests
      </p>
    </div>
  );
}

export function RequestsChart({ data }: RequestsChartProps) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Request Volume</h3>
      <div className="h-[220px]">
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="requestFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatTime} {...AXIS_CONFIG} />
            <YAxis {...AXIS_CONFIG} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="count"
              stroke={CHART_COLORS.primary}
              fill="url(#requestFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
