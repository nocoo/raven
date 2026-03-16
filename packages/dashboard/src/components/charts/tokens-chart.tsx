"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, BAR_RADIUS, RESPONSIVE_CONTAINER_PROPS, CHART_HEIGHTS, formatBucketTime } from "@/lib/chart-config";
import { formatCompact } from "@/lib/chart-config";
import type { TimeseriesBucket } from "@/lib/types";

interface TokensChartProps {
  data: TimeseriesBucket[];
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label ? formatBucketTime(label) : ""}</p>
      <p className={TOOLTIP_STYLES.value}>
        {formatCompact(payload[0]?.value ?? 0)} tokens
      </p>
    </div>
  );
}

export function TokensChart({ data }: TokensChartProps) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Token Consumption</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={formatCompact} {...AXIS_CONFIG} />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="total_tokens"
              fill={CHART_COLORS.primary}
              radius={BAR_RADIUS.vertical}
              maxBarSize={40}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
