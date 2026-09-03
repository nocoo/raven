"use client";

import { memo } from "react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ANIMATION_PROPS,
  RESPONSIVE_CONTAINER_PROPS,
} from "@/lib/chart-config";
import {
  ChartTooltip,
  ChartTooltipRow,
} from "@/components/dashboard/chart-primitives";
import {
  computePercent,
  type RetryStacks,
} from "@/lib/sentinel-derive";

interface RetryBarProps {
  stacks: RetryStacks;
}

interface StackTooltipPayload {
  dataKey: string;
  name?: string;
  value: number;
  color: string;
  payload: { _total: number };
}

function StackTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: StackTooltipPayload[];
}) {
  if (!active || !payload?.length) return null;
  const total = payload[0]!.payload._total;
  return (
    <ChartTooltip title="LLM-401 outcomes">
      {payload
        .filter((p) => p.value > 0)
        .map((p) => (
          <ChartTooltipRow
            key={p.dataKey}
            color={p.color}
            label={p.name ?? p.dataKey}
            value={`${p.value.toLocaleString()} (${computePercent(p.value, total)}%)`}
          />
        ))}
    </ChartTooltip>
  );
}

export const RetryBar = memo(function RetryBar({ stacks }: RetryBarProps) {
  const { segments, total } = stacks;
  const isEmpty = total === 0;

  // Build a single row of data keyed by segment id for the stacked bar.
  const row: Record<string, number | string> = { _total: total };
  for (const s of segments) row[s.key] = s.value;

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex-1 min-h-[60px] flex items-center">
        {isEmpty ? (
          <div
            className="h-full w-full rounded-md bg-basalt-muted/40 flex items-center justify-center"
            role="img"
            aria-label="No LLM-401 retry attempts yet"
          >
            <span className="text-meta text-basalt-muted-foreground">
              No LLM-401 retry attempts yet
            </span>
          </div>
        ) : (
          <div className="w-full h-[44px]">
            <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
            <BarChart
              layout="vertical"
              data={[row]}
              stackOffset="expand"
              margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
              barCategoryGap={0}
            >
              <XAxis type="number" hide domain={[0, 1]} />
              <YAxis type="category" dataKey="_kind" hide />
              <Tooltip content={<StackTooltip />} cursor={false} />
              {segments.map((s, i) => {
                const radius: [number, number, number, number] =
                  i === 0
                    ? [4, 0, 0, 4]
                    : i === segments.length - 1
                    ? [0, 4, 4, 0]
                    : [0, 0, 0, 0];
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    stackId="retry"
                    name={s.label}
                    fill={s.color}
                    radius={radius}
                    aria-label={`${s.label}: ${s.value} (${computePercent(s.value, total)}%)`}
                    {...ANIMATION_PROPS}
                  />
                );
              })}
            </BarChart>
          </ResponsiveContainer>
          </div>
        )}
      </div>

      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 shrink-0 list-none m-0 p-0">
        {segments.map((s) => {
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
              <span className="text-basalt-muted-foreground flex-1 truncate">
                {s.label}
              </span>
              <span className="tabular-nums text-basalt-foreground">
                {s.value.toLocaleString()}
              </span>
              <span className="tabular-nums text-basalt-muted-foreground/70 w-8 text-right">
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
