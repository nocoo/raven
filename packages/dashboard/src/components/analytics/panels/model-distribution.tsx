"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  getChartColor,
} from "@/lib/chart-config";
import type { ModelCount } from "./types";

function ModelTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ModelCount }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{d.model}</p>
      <p className={TOOLTIP_STYLES.value}>{d.count} requests</p>
    </div>
  );
}

interface ModelDistributionProps {
  data: ModelCount[];
}

/**
 * Horizontal bar chart showing model distribution (top-N models by count).
 * Works with both live aggregated data and historical breakdown API.
 */
export function ModelDistribution({ data }: ModelDistributionProps) {
  if (data.length === 0) return null;
  const total = data.reduce((sum, m) => sum + m.count, 0);
  const topModel = data[0];
  const summary = `Model distribution chart. ${data.length} models, ${total} total requests. Most used: ${topModel?.model ?? "none"} with ${topModel?.count ?? 0} requests.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Models
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 8, top: 4, bottom: 4 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke={CHART_COLORS.muted}
              strokeOpacity={0.3}
              horizontal={false}
            />
            <XAxis type="number" allowDecimals={false} {...AXIS_CONFIG} />
            <YAxis
              type="category"
              dataKey="model"
              width={90}
              {...AXIS_CONFIG}
              tick={{ fontSize: 10, fill: AXIS_CONFIG.tick.fill }}
            />
            <Tooltip content={<ModelTooltip />} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20} {...ANIMATION_PROPS}>
              {data.map((_, i) => (
                <Cell key={i} fill={getChartColor(i)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
