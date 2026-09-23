"use client";

import { Suspense } from "react";
import { ContentIsland } from "@nocoo/basalt";
import { Dock } from "@nocoo/basalt/components/dock";
import { Fab } from "@nocoo/basalt/components/fab";
import { Terminal } from "lucide-react";
import { LogsContent } from "@/app/logs/logs-content";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLogDock } from "./log-dock-context";

export function LogsDock() {
  const { isOpen, requestIdFilter, openLogs, closeLogs, setRequestIdFilter } = useLogDock();
  const compact = useIsMobile(1280);

  return (
    <>
      <Fab open={isOpen} onClick={() => openLogs()} aria-label="Open live logs"><Terminal className="size-6" aria-hidden="true" /></Fab>
      <Dock
        mode={compact ? "overlay" : "push"}
        open={isOpen}
        width={compact ? "100%" : "clamp(480px, 52vw, 960px)"}
        aria-label="Live logs dock"
        dismissLabel="Close live logs dock"
        onDismiss={closeLogs}
        className="h-full [&>div]:bg-transparent [&>div]:shadow-none [&>div]:ring-0"
      >
        <div className={`flex h-full min-h-0 flex-col pr-2 pb-2 md:pr-3 md:pb-3 ${compact ? "pl-2 md:pl-3" : ""}`}>
          <ContentIsland className="logs-dock-surface flex flex-col overflow-hidden p-3 md:p-4 shadow-none ring-0">
            <Suspense fallback={<div className="p-4 text-xs text-basalt-muted-foreground">Loading logs...</div>}>
              <LogsContent
                onClose={closeLogs}
                requestIdFilter={requestIdFilter ?? undefined}
                onClearRequestIdFilter={() => setRequestIdFilter(null)}
              />
            </Suspense>
          </ContentIsland>
        </div>
      </Dock>
    </>
  );
}
