"use client";

import { memo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ANIMATION_PROPS,
  RESPONSIVE_CONTAINER_PROPS,
  formatCompact,
} from "@/lib/chart-config";
import {
  ChartTooltip,
  ChartTooltipRow,
} from "@/components/dashboard/chart-primitives";
import {
  computePercent,
  type OccurrenceSlice,
} from "@/lib/sentinel-derive";

interface OccurrencesDonutProps {
  slices: OccurrenceSlice[];
}

interface SliceTooltipPayload {
  payload: OccurrenceSlice & { _total: number };
  value: number;
  color: string;
}

function SliceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: SliceTooltipPayload[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!;
  const total = p.payload._total;
  const pct = computePercent(p.value, total);
  return (
    <ChartTooltip title={p.payload.label}>
      <ChartTooltipRow
        color={p.payload.color}
        label="Count"
        value={`${p.value.toLocaleString()} (${pct}%)`}
      />
    </ChartTooltip>
  );
}

export const OccurrencesDonut = memo(function OccurrencesDonut({
  slices,
}: OccurrencesDonutProps) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const isEmpty = total === 0;

  // recharts Pie collapses a single zero datapoint; show a synthetic
  // grey ring for the empty state instead.
  const data = isEmpty
    ? [{ key: "empty", label: "No data", value: 1, color: "hsl(var(--basalt-chart-muted))", _total: 0 }]
    : slices.map((s) => ({ ...s, _total: total }));

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="relative flex-1 min-h-[160px]">
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius="62%"
              outerRadius="92%"
              startAngle={90}
              endAngle={-270}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              {...ANIMATION_PROPS}
            >
              {data.map((d) => (
                <Cell
                  key={d.key}
                  fill={d.color}
                  aria-label={`${d.label}: ${d.value} (${computePercent(d.value, total)}%)`}
                />
              ))}
            </Pie>
            {!isEmpty && <Tooltip content={<SliceTooltip />} />}
          </PieChart>
        </ResponsiveContainer>
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
          aria-hidden
        >
          <span className="text-2xl font-semibold tabular-nums leading-none">
            {formatCompact(total)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">
            401s
          </span>
        </div>
      </div>

      <div className="space-y-1 shrink-0">
        {isEmpty ? (
          <p className="text-meta text-muted-foreground text-center">
            No 401s recorded
          </p>
        ) : (
          <ul className="space-y-1 list-none m-0 p-0">
            {slices.map((s) => {
              const pct = computePercent(s.value, total);
              return (
                <li
                  key={s.key}
                  className="flex items-center gap-2 text-meta"
                  aria-label={`${s.label}: ${s.value} (${pct}%)`}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ background: s.color }}
                  />
                  <span className="text-muted-foreground flex-1 truncate">
                    {s.label}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {s.value.toLocaleString()}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70 w-9 text-right">
                    {pct}%
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});
