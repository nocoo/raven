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
  className?: string;
}

const accentColors = {
  default: "text-foreground",
  danger: "text-destructive",
  warning: "text-warning",
  success: "text-success",
} as const;

export function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  variant = "default",
  accent = "default",
  className,
}: StatCardProps) {
  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-2.5 rounded-lg border bg-card p-2.5", className)}>
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
          <p className={cn("text-xl font-semibold tracking-tight", accentColors[accent])}>
            {value}
          </p>
          {detail && (
            <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}
