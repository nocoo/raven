import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
  className?: string;
}

export function StatCard({ icon: Icon, label, value, detail, className }: StatCardProps) {
  return (
    <div className={cn("bg-secondary rounded-card p-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-widget bg-primary/10">
          <Icon className="h-4 w-4 text-primary" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tracking-tight">{value}</p>
          {detail && (
            <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
          )}
        </div>
      </div>
    </div>
  );
}
