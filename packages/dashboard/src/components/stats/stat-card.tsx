import { LayerCard } from "@nocoo/basalt";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

interface StatCardProps {
  icon: LucideIcon | ComponentType<{ className?: string }>;
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
  default: "text-basalt-foreground",
  danger: "text-basalt-destructive",
  warning: "text-basalt-warning",
  success: "text-basalt-chart-5",
} as const;

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
      <LayerCard padding="sm" className={cn("flex items-center gap-2.5", className ?? "")}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-basalt-background">
          <Icon className="size-3.5 text-basalt-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[10px] text-basalt-muted-foreground">{label}</p>
          <p className={cn("text-base leading-tight font-semibold tabular-nums", accentColors[accent])}>
            {value}
          </p>
          {detail && (
            <p className="truncate text-[10px] text-basalt-muted-foreground">{detail}</p>
          )}
        </div>
      </LayerCard>
    );
  }

  return (
    <LayerCard className={className ?? ""}>
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-basalt-widget bg-basalt-primary/10">
          <Icon className="h-4 w-4 text-basalt-primary" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-card-label">{label}</p>
          <div className="flex items-center gap-3">
            <p className={cn("text-xl font-semibold tracking-tight tabular-nums", accentColors[accent])}>
              {value}
            </p>
            {sparkline && <Sparkline data={sparkline} />}
          </div>
          {detail && (
            <p className="text-meta mt-0.5">{detail}</p>
          )}
        </div>
      </div>
    </LayerCard>
  );
}
