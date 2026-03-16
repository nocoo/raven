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
import { CHART_COLORS, AXIS_CONFIG, TOOLTIP_STYLES, BAR_RADIUS, RESPONSIVE_CONTAINER_PROPS, CHART_HEIGHTS } from "@/lib/chart-config";
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
  // Shorten model names for display
  const chartData = data.map((m) => ({
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
