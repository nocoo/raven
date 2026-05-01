import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// DashboardSegment — lightweight section divider for dashboard layout
// ---------------------------------------------------------------------------
//
// Quiet uppercase label + 1px hairline. No card container, no background:
// children render their own surfaces (typically L2 panels). This replaces
// the heavier `text-section` + L1 outer card pattern when grouping data
// panels on overview/monitor pages.
// ---------------------------------------------------------------------------

export interface DashboardSegmentProps {
  title: string;
  children: React.ReactNode;
  /** Optional action slot (e.g. period selector) on the right of the header */
  action?: React.ReactNode;
  className?: string;
}

export function DashboardSegment({
  title,
  action,
  children,
  className,
}: DashboardSegmentProps) {
  return (
    <section className={cn("space-y-3 md:space-y-4", className)}>
      <div className="flex items-center gap-3">
        <h2 className="shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <div className="h-px flex-1 bg-border" />
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
