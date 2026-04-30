"use client";

import { cn } from "@/lib/utils";

interface LiveIndicatorProps {
  /** Whether data is currently sourced from live SSE. */
  isLive: boolean;
  /** Time range label to show in historical mode (e.g. "24h"). */
  rangeLabel?: string;
  /** Additional class names. */
  className?: string;
}

/**
 * Badge showing whether panels are rendering live SSE data or historical API data.
 * - Live: pulsing green dot + "LIVE" text
 * - Historical: muted "Historical" badge with optional range
 */
export function LiveIndicator({ isLive, rangeLabel, className }: LiveIndicatorProps) {
  if (isLive) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success",
          className,
        )}
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
        Live
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      Historical
      {rangeLabel && (
        <span className="text-muted-foreground/60">({rangeLabel})</span>
      )}
    </span>
  );
}
