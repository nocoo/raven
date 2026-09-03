"use client";

import { useId } from "react";

interface SparklineProps {
  data: number[];
}

/** Lightweight SVG sparkline — no recharts overhead for a tiny inline chart. */
export function Sparkline({ data }: SparklineProps) {
  const gradientId = useId();
  if (data.length < 2) return null;
  const w = 80;
  const h = 24;
  const padding = 1;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = (w - padding * 2) / (data.length - 1);

  const points = data.map((v, i) => {
    const x = padding + i * step;
    const y = h - padding - ((v - min) / range) * (h - padding * 2);
    return `${x},${y}`;
  });

  const areaPoints = [
    ...points,
    `${padding + (data.length - 1) * step},${h}`,
    `${padding},${h}`,
  ].join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0"
      role="img"
      aria-hidden
    >
      <title>Sparkline</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--basalt-primary))" stopOpacity={0.2} />
          <stop offset="100%" stopColor="hsl(var(--basalt-primary))" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradientId})`} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="hsl(var(--basalt-primary))"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
