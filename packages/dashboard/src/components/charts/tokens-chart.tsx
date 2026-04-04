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
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, BAR_RADIUS, RESPONSIVE_CONTAINER_PROPS, CHART_HEIGHTS, ANIMATION_PROPS, formatBucketTime } from "@/lib/chart-config";
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
  // Generate accessible summary
  const total = data.reduce((sum, b) => sum + b.total_tokens, 0);
  const peak = Math.max(...data.map((b) => b.total_tokens));
  const peakTime = data.find((b) => b.total_tokens === peak);
  const summary = `Token consumption chart showing ${formatCompact(total)} total tokens over ${data.length} time periods. Peak: ${formatCompact(peak)} tokens${peakTime ? ` at ${formatBucketTime(peakTime.bucket)}` : ""}.`;

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Token Consumption</h3>
      <div style={{ height: CHART_HEIGHTS.standard }} role="img" aria-label={summary}>
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
              {...ANIMATION_PROPS}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
