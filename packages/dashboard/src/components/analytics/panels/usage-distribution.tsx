"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip, ChartTooltipRow } from "@/components/dashboard/chart-primitives";
import { ANIMATION_PROPS, CHART_COLORS, formatCompact, formatPercent, getChartColor, RESPONSIVE_CONTAINER_PROPS } from "@/lib/chart-config";
import { keyIdentity, keyLabel, type UsageDimension } from "@/lib/monitor";
import type { BreakdownEntry } from "@/lib/types";
import { usageDistribution } from "@/lib/usage-distribution";
import { MonitorPanel } from "./monitor-panels";

export function UsageDistribution({ entries, total, dimension, selected }: {
  entries: BreakdownEntry[];
  total: number | null;
  dimension: UsageDimension;
  selected: string | undefined;
}) {
  const isKey = dimension === "key_id";
  const distribution = usageDistribution(entries, total);
  const slices = distribution.slices.map((slice, index) => {
    const entry = entries.find(item => item.key === slice.key);
    const label = slice.key === null ? "Others" : isKey && entry ? keyLabel(entry) : slice.key || "Unattributed";
    return { ...slice, label, color: slice.key === null ? CHART_COLORS.muted : getChartColor(index) };
  });
  return <MonitorPanel title={isKey ? "Key distribution" : "Model distribution"} description={`All ${isKey ? "keys" : "models"} · time and other filters retained`}>
    <div className="grid items-center gap-3 sm:grid-cols-2 xl:grid-cols-1">
      <div className="relative mx-auto size-44 max-w-full" role="img" aria-label={`${formatCompact(distribution.total)} requests across ${isKey ? "keys" : "models"}`}>
        {distribution.total > 0 ? <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}><PieChart>
          <Pie {...ANIMATION_PROPS} data={slices} dataKey="count" nameKey="label" innerRadius="68%" outerRadius="95%" startAngle={90} endAngle={-270} stroke="hsl(var(--basalt-card))" strokeWidth={2}>
            {slices.map(slice => <Cell key={slice.key === null ? "others" : `entry:${slice.key}`} fill={slice.color} />)}
          </Pie>
          <Tooltip content={({ active, payload }) => {
            const slice = payload?.[0]?.payload as typeof slices[number] | undefined;
            return active && slice ? <ChartTooltip title={slice.label}><ChartTooltipRow color={slice.color} label="Requests" value={`${formatCompact(slice.count)} · ${formatPercent(slice.count / distribution.total)}`} /></ChartTooltip> : null;
          }} />
        </PieChart></ResponsiveContainer> : <div className="absolute inset-3 rounded-full border-[20px] border-basalt-muted" />}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true"><strong className="text-2xl font-semibold tabular-nums">{formatCompact(distribution.total)}</strong><span className="text-xs text-basalt-muted-foreground">requests</span></div>
      </div>
      <div className="min-w-0 space-y-1">
        {slices.map(slice => {
          const content = <><span className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} /><span className="min-w-0 flex-1 text-left"><span className="block truncate">{slice.label}</span>{isKey && slice.key && <span className="block truncate font-mono text-xs text-basalt-muted-foreground">{slice.key.startsWith("legacy:") ? "historical" : slice.key.slice(-8)}</span>}</span><span className="shrink-0 tabular-nums">{formatCompact(slice.count)}</span><span className="w-12 shrink-0 text-right tabular-nums text-basalt-muted-foreground">{distribution.total ? formatPercent(slice.count / distribution.total) : "—"}</span></>;
          return <div key={slice.key === null ? "others" : `entry:${slice.key}`} title={isKey && slice.key ? `${slice.label} · ${keyIdentity(slice.key)}` : slice.label} className={`flex min-h-8 items-center gap-2 rounded-md px-1 py-1.5 text-xs ${selected === slice.key ? "bg-basalt-accent" : ""}`}>{content}</div>;
        })}
        {entries.length === 0 && <p className="text-xs text-basalt-muted-foreground">No distribution available</p>}
      </div>
    </div>
    <p className="mt-3 border-t border-basalt-border/50 pt-3 text-xs text-basalt-muted-foreground">{total === null ? "Available breakdown only · full total unavailable" : "Top five by requests · Others includes every remaining identity"}</p>
  </MonitorPanel>;
}
