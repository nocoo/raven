"use client";


import { cn } from "@/lib/utils";
import { formatCompact } from "@/lib/chart-config";
import type { SessionInfo } from "./types";
import { Circle } from "lucide-react";
import { Badge, LayerCard } from "@nocoo/basalt";

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function SessionRow({ session }: { session: SessionInfo }) {
  const isActive = session.activeRequests.size > 0;
  const errorRate =
    session.totalRequests > 0
      ? session.errorCount / session.totalRequests
      : 0;

  return (
    <LayerCard.Well
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        isActive && "bg-basalt-chart-5/5 border border-basalt-chart-5/20",
      )}
    >
      <Circle
        className={cn(
          "size-2 shrink-0 fill-current",
          isActive ? "text-basalt-chart-5" : "text-basalt-muted-foreground/30",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{session.clientName}</span>
          {session.clientVersion && (
            <span className="text-[10px] text-basalt-muted-foreground">
              v{session.clientVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-basalt-muted-foreground tabular-nums">
          <span>{session.totalRequests} req</span>
          <span>{formatCompact(session.totalTokens)} tok</span>
          {errorRate > 0 && (
            <span className="text-basalt-destructive">
              {formatPercent(errorRate)} err
            </span>
          )}
          {isActive && (
            <span className="text-basalt-chart-5 font-medium">
              {session.activeRequests.size} active
            </span>
          )}
        </div>
      </div>
      {session.accountName !== "default" &&
        session.accountName !== "dev" && (
          <Badge
            variant="outline"
            className="px-1 py-0 text-[9px] shrink-0"
          >
            {session.accountName}
          </Badge>
        )}
    </LayerCard.Well>
  );
}

interface SessionListProps {
  sessions: SessionInfo[];
}

/**
 * Scrollable list of active/recent sessions with status indicators.
 * Works with both live SSE session tracking and historical session data.
 */
export function SessionList({ sessions }: SessionListProps) {
  if (sessions.length === 0) return null;
  return (
    <LayerCard padding="sm">
      <h4 className="text-xs font-medium text-basalt-muted-foreground mb-2">
        Sessions
        <span className="ml-1 font-normal text-basalt-muted-foreground/60">
          ({sessions.length})
        </span>
      </h4>
      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
        {sessions.map((s) => (
          <SessionRow key={s.sessionId} session={s} />
        ))}
      </div>
    </LayerCard>
  );
}
