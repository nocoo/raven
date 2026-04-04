"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, RESPONSIVE_CONTAINER_PROPS, CHART_HEIGHTS, ANIMATION_PROPS, formatBucketTime } from "@/lib/chart-config";
import { formatLatency } from "@/lib/chart-config";
import type { TimeseriesBucket } from "@/lib/types";

interface ErrorRateChartProps {
  data: Array<TimeseriesBucket & { error_rate: number }>;
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const latencyEntry = payload.find((p) => p.dataKey === "avg_latency_ms");
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label ? formatBucketTime(label) : ""}</p>
      <p className={TOOLTIP_STYLES.value}>
        {latencyEntry ? formatLatency(latencyEntry.value) : "—"} avg latency
      </p>
    </div>
  );
}

export function LatencyChart({ data }: ErrorRateChartProps) {
  // Generate accessible summary
  const validLatencies = data.filter((b) => b.avg_latency_ms > 0);
  const avgLatency = validLatencies.length > 0
    ? validLatencies.reduce((sum, b) => sum + b.avg_latency_ms, 0) / validLatencies.length
    : 0;
  const peak = Math.max(...data.map((b) => b.avg_latency_ms));
  const peakTime = data.find((b) => b.avg_latency_ms === peak);
  const summary = `Latency chart showing average response times over ${data.length} time periods. Overall average: ${formatLatency(avgLatency)}. Peak: ${formatLatency(peak)}${peakTime ? ` at ${formatBucketTime(peakTime.bucket)}` : ""}.`;

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Avg Latency</h3>
      <div style={{ height: CHART_HEIGHTS.standard }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={(v: number) => formatLatency(v)} {...AXIS_CONFIG} />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="avg_latency_ms"
              stroke={CHART_COLORS.warning}
              strokeWidth={2}
              dot={false}
              {...ANIMATION_PROPS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
