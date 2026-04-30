"use client";

import { Circle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCompact } from "@/lib/chart-config";
import type { SessionInfo } from "./types";

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
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        isActive
          ? "bg-success/5 border border-success/20"
          : "bg-muted/30",
      )}
    >
      <Circle
        className={cn(
          "size-2 shrink-0 fill-current",
          isActive ? "text-success" : "text-muted-foreground/30",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{session.clientName}</span>
          {session.clientVersion && (
            <span className="text-[10px] text-muted-foreground">
              v{session.clientVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          <span>{session.totalRequests} req</span>
          <span>{formatCompact(session.totalTokens)} tok</span>
          {errorRate > 0 && (
            <span className="text-destructive">
              {formatPercent(errorRate)} err
            </span>
          )}
          {isActive && (
            <span className="text-success font-medium">
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
    </div>
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
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Sessions
        <span className="ml-1 font-normal text-muted-foreground/60">
          ({sessions.length})
        </span>
      </h4>
      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
        {sessions.map((s) => (
          <SessionRow key={s.sessionId} session={s} />
        ))}
      </div>
    </div>
  );
}
