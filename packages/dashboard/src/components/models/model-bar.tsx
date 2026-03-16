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
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, BAR_RADIUS, RESPONSIVE_CONTAINER_PROPS, CHART_HEIGHTS, MODEL_TOP_N } from "@/lib/chart-config";
import { formatCompact } from "@/lib/chart-config";
import type { ModelStats } from "@/lib/types";

interface ModelBarProps {
  data: ModelStats[];
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label}</p>
      <p className={TOOLTIP_STYLES.value}>
        {formatCompact(payload[0]?.value ?? 0)} tokens
      </p>
    </div>
  );
}

export function ModelBar({ data }: ModelBarProps) {
  // Aggregate models beyond top-N
  const aggregated = (() => {
    if (data.length <= MODEL_TOP_N) return data;
    const sorted = [...data].sort((a, b) => b.total_tokens - a.total_tokens);
    const top = sorted.slice(0, MODEL_TOP_N);
    const rest = sorted.slice(MODEL_TOP_N);
    if (rest.length === 0) return top;
    const others: ModelStats = {
      model: `Others (${rest.length})`,
      count: rest.reduce((s, m) => s + m.count, 0),
      total_tokens: rest.reduce((s, m) => s + m.total_tokens, 0),
      avg_latency_ms: rest.length > 0
        ? rest.reduce((s, m) => s + m.avg_latency_ms, 0) / rest.length
        : 0,
    };
    return [...top, others];
  })();

  // Shorten model names for display
  const chartData = aggregated.map((m) => ({
    ...m,
    shortName: m.model.split("/").pop() ?? m.model,
  }));

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Token Consumption by Model</h3>
      <div style={{ height: CHART_HEIGHTS.full }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <BarChart data={chartData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis type="number" tickFormatter={formatCompact} {...AXIS_CONFIG} />
            <YAxis type="category" dataKey="shortName" width={120} {...AXIS_CONFIG} />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="total_tokens"
              fill={CHART_COLORS.primary}
              radius={BAR_RADIUS.horizontal}
              maxBarSize={30}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
