"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { getChartColor, RESPONSIVE_CONTAINER_PROPS, TOOLTIP_STYLES, PIE_LABEL_LINE, CHART_HEIGHTS, ANIMATION_PROPS } from "@/lib/chart-config";
import type { ModelStats } from "@/lib/types";

interface ModelPieProps {
  data: ModelStats[];
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
  const chartData = [...data].sort((a, b) => b.count - a.count);
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
              label={({ x, y, model, percent, textAnchor }: { x: number; y: number; model: string; percent: number; textAnchor: "start" | "middle" | "end" }) => (
                <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fontSize={11} fill="currentColor">
                  {`${model.split("/").pop() ?? model} ${(percent * 100).toFixed(0)}%`}
                </text>
              )}
              {...ANIMATION_PROPS}
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
