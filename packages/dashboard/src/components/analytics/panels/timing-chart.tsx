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
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  formatLatency as fmtLatency,
  getChartColor,
} from "@/lib/chart-config";
import type { TimingPoint } from "./types";

function TimingTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimingPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{d.model}</p>
      <p className={TOOLTIP_STYLES.value}>Duration: {fmtLatency(d.latencyMs)}</p>
      {d.ttftMs !== null && (
        <p className={TOOLTIP_STYLES.value}>TTFT: {fmtLatency(d.ttftMs)}</p>
      )}
      {d.processingMs !== null && (
        <p className={TOOLTIP_STYLES.value}>Processing: {fmtLatency(d.processingMs)}</p>
      )}
    </div>
  );
}

interface TimingChartProps {
  data: TimingPoint[];
}

/**
 * Multi-line chart showing latency, TTFT, and processing time per request.
 * Works with both live SSE timing data and historical API responses.
 */
export function TimingChart({ data }: TimingChartProps) {
  if (data.length < 2) return null;
  const avgLatency = data.reduce((sum, p) => sum + p.latencyMs, 0) / data.length;
  const peak = Math.max(...data.map((p) => p.latencyMs));
  const summary = `Request timing chart showing last ${data.length} requests. Average duration: ${fmtLatency(avgLatency)}. Peak: ${fmtLatency(peak)}.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Timing
        <span className="ml-1 font-normal text-muted-foreground/60">
          (last {data.length})
        </span>
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="index" {...AXIS_CONFIG} tick={false} />
            <YAxis tickFormatter={(v: number) => fmtLatency(v)} {...AXIS_CONFIG} width={40} />
            <Tooltip content={<TimingTooltip />} />
            <Line
              type="monotone"
              dataKey="latencyMs"
              name="Duration"
              stroke={CHART_COLORS.warning}
              strokeWidth={2}
              dot={{ r: 2, fill: CHART_COLORS.warning }}
              activeDot={{ r: 4 }}
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="ttftMs"
              name="TTFT"
              stroke={getChartColor(1)}
              strokeWidth={1.5}
              dot={{ r: 1.5, fill: getChartColor(1) }}
              activeDot={{ r: 3 }}
              connectNulls
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="processingMs"
              name="Processing"
              stroke={getChartColor(3)}
              strokeWidth={1.5}
              dot={{ r: 1.5, fill: getChartColor(3) }}
              activeDot={{ r: 3 }}
              connectNulls
              strokeDasharray="4 2"
              {...ANIMATION_PROPS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
