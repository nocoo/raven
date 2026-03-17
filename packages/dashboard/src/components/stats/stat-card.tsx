import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  icon: LucideIcon | React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
  /** Compact variant for sidebars (smaller padding, border instead of bg) */
  variant?: "default" | "compact";
  /** Accent color for the value text */
  accent?: "default" | "danger" | "warning" | "success";
  /** Optional sparkline data points for mini trend visualization */
  sparkline?: number[];
  className?: string;
}

const accentColors = {
  default: "text-foreground",
  danger: "text-destructive",
  warning: "text-warning",
  success: "text-success",
} as const;

/** Lightweight SVG sparkline — no recharts overhead for a tiny inline chart. */
function Sparkline({ data }: { data: number[] }) {
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

  // Gradient fill area polygon: line points + bottom-right + bottom-left
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
      aria-hidden
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#sparkFill)" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  variant = "default",
  accent = "default",
  sparkline,
  className,
}: StatCardProps) {
  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-2.5 rounded-lg border bg-secondary p-2.5", className)}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] text-muted-foreground truncate">{label}</p>
          <p className={cn("text-base font-semibold leading-tight tabular-nums", accentColors[accent])}>
            {value}
          </p>
          {detail && (
            <p className="text-[10px] text-muted-foreground truncate">{detail}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("bg-secondary rounded-card p-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-widget bg-primary/10">
          <Icon className="h-4 w-4 text-primary" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <div className="flex items-center gap-3">
            <p className={cn("text-xl font-semibold tracking-tight", accentColors[accent])}>
              {value}
            </p>
            {sparkline && <Sparkline data={sparkline} />}
          </div>
          {detail && (
            <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}
