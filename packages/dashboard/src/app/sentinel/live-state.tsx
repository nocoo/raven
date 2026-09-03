"use client";

import { memo, useEffect, useRef } from "react";
import { Sparkline } from "@/components/charts/sparkline";
import { CHART_COLORS } from "@/lib/chart-config";
import { formatAge, formatMs } from "@/lib/sentinel-derive";
import type { SentinelStatus } from "@/lib/types";

interface LiveStateProps {
  status: SentinelStatus;
  signalHistory: number[];
  bgRefreshOk: number;
  bgRefreshFailed: number;
}

interface ModeBadgeProps {
  mode: SentinelStatus["mode"];
}

const SIGNAL_MAX = 10;
const SIGNAL_THRESHOLD = 5;

function ModeBadge({ mode }: ModeBadgeProps) {
  const { label, fg, bg } =
    mode === "steady"
      ? { label: "STEADY", fg: "text-success", bg: "bg-success/10" }
      : mode === "probing"
      ? { label: "PROBING", fg: "text-warning", bg: "bg-warning/10" }
      : { label: "OFFLINE", fg: "text-destructive", bg: "bg-destructive/10" };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${fg} ${bg}`}
      role="status"
      aria-label={`Sentinel mode: ${label}`}
    >
      {label}
    </span>
  );
}

function SignalGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(SIGNAL_MAX, score));
  const cx = 80;
  const cy = 80;
  const r = 60;
  // Half-circle: 180° (left=180, right=0). Score fills clockwise from
  // 180° down to (180 - 180*frac)°.
  const startRad = Math.PI;
  const endRad = Math.PI - (clamped / SIGNAL_MAX) * Math.PI;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const largeArc = clamped > SIGNAL_MAX / 2 ? 1 : 0;
  const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const fgPath =
    clamped <= 0
      ? ""
      : `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;

  // Threshold tick at score=5 → 90° (top of arc)
  const thresholdRad = Math.PI - (SIGNAL_THRESHOLD / SIGNAL_MAX) * Math.PI;
  const tickInner = r - 6;
  const tickOuter = r + 6;
  const tx1 = cx + tickInner * Math.cos(thresholdRad);
  const ty1 = cy + tickInner * Math.sin(thresholdRad);
  const tx2 = cx + tickOuter * Math.cos(thresholdRad);
  const ty2 = cy + tickOuter * Math.sin(thresholdRad);

  const color =
    clamped >= SIGNAL_THRESHOLD ? CHART_COLORS.warning : CHART_COLORS.success;

  return (
    <div
      className="relative w-[160px] h-[88px]"
      role="img"
      aria-label={`Signal score: ${clamped} of ${SIGNAL_MAX} (threshold ${SIGNAL_THRESHOLD})`}
    >
      <svg viewBox="0 0 160 88" width={160} height={88} role="img" aria-hidden="true">
        <title>{`Signal score: ${clamped} of ${SIGNAL_MAX}`}</title>
        <path
          d={bgPath}
          stroke="hsl(var(--basalt-chart-muted))"
          strokeOpacity={0.3}
          strokeWidth={10}
          fill="none"
          strokeLinecap="round"
        />
        {fgPath && (
          <path
            d={fgPath}
            stroke={color}
            strokeWidth={10}
            fill="none"
            strokeLinecap="round"
          />
        )}
        <line
          x1={tx1}
          y1={ty1}
          x2={tx2}
          y2={ty2}
          stroke="hsl(var(--basalt-chart-axis))"
          strokeWidth={1.5}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
        <span className="text-2xl font-semibold tabular-nums leading-none">
          {clamped}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
          signal / {SIGNAL_MAX}
        </span>
      </div>
    </div>
  );
}

function CooldownBar({ remainingMs }: { remainingMs: number }) {
  // Track the max remainingMs seen during the current cooldown epoch so
  // we can show a filling progress bar that shrinks as time elapses.
  // When remainingMs drops to 0, the next non-zero value starts a new
  // epoch — reset the max.
  const maxRef = useRef(0);
  useEffect(() => {
    if (remainingMs <= 0) {
      maxRef.current = 0;
    } else if (remainingMs > maxRef.current) {
      maxRef.current = remainingMs;
    }
  }, [remainingMs]);

  const pct =
    remainingMs > 0 && maxRef.current > 0
      ? Math.max(2, Math.round((remainingMs / maxRef.current) * 100))
      : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-meta text-muted-foreground w-16 shrink-0">
        Cooldown
      </span>
      <div
        className="flex-1 h-2 rounded-full bg-muted/40 overflow-hidden"
        role="progressbar"
        aria-label={`Cooldown remaining: ${formatMs(remainingMs)}`}
        aria-valuenow={remainingMs}
        aria-valuemin={0}
        aria-valuemax={Math.max(maxRef.current, 1)}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background:
              remainingMs > 0 ? CHART_COLORS.warning : "transparent",
          }}
        />
      </div>
      <span className="text-meta tabular-nums w-12 text-right">
        {formatMs(remainingMs)}
      </span>
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "warn" | "danger" | "default";
}) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "warn"
      ? "text-warning"
      : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className={`text-numeric font-medium tabular-nums ${toneClass}`}>
        {value}
      </span>
    </div>
  );
}

export const LiveState = memo(function LiveState({
  status,
  signalHistory,
  bgRefreshOk,
  bgRefreshFailed,
}: LiveStateProps) {
  return (
    <div className="flex flex-col gap-3 h-full justify-between">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <ModeBadge mode={status.mode} />
        <Sparkline data={signalHistory} />
      </div>

      <div className="flex justify-center flex-1 items-center min-h-0">
        <SignalGauge score={status.signalScore} />
      </div>

      <CooldownBar remainingMs={status.cooldownRemainingMs} />

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-1 shrink-0">
        <Cell
          label="Consecutive Fails"
          value={status.consecutiveFailures}
          tone={status.consecutiveFailures > 0 ? "warn" : "default"}
        />
        <Cell label="Last Success" value={formatAge(status.lastSuccessAt)} />
        <Cell label="Background OK" value={bgRefreshOk} />
        <Cell
          label="Background Fail"
          value={bgRefreshFailed}
          tone={bgRefreshFailed > 0 ? "warn" : "default"}
        />
      </div>
    </div>
  );
});
