"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { getChartColor, RESPONSIVE_CONTAINER_PROPS, TOOLTIP_STYLES, PIE_LABEL_LINE, CHART_HEIGHTS, MODEL_TOP_N } from "@/lib/chart-config";
import type { ModelStats } from "@/lib/types";

interface ModelPieProps {
  data: ModelStats[];
}

/** Aggregate models beyond top-N into an "Others" bucket */
function aggregateModels(data: ModelStats[]): ModelStats[] {
  if (data.length <= MODEL_TOP_N) return data;
  const sorted = [...data].sort((a, b) => b.count - a.count);
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
}

function CustomTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: ModelStats }>;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  if (!entry) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{entry.name}</p>
      <p className={TOOLTIP_STYLES.value}>{entry.value.toLocaleString()} requests</p>
    </div>
  );
}

export function ModelPie({ data }: ModelPieProps) {
  const chartData = aggregateModels(data);
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Request Distribution</h3>
      <div style={{ height: CHART_HEIGHTS.full }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="count"
              nameKey="model"
              cx="50%"
              cy="50%"
              outerRadius={100}
              labelLine={PIE_LABEL_LINE}
              label={({ model, percent }: { model: string; percent: number }) =>
                `${model.split("/").pop() ?? model} ${(percent * 100).toFixed(0)}%`
              }
            >
              {chartData.map((_entry, index) => (
                <Cell key={index} fill={getChartColor(index)} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
