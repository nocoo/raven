"use client";

import { Suspense } from "react";
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
        className="h-full"
      >
        <div className="flex h-full flex-col overflow-hidden p-4">
          <Suspense fallback={<div className="p-4 text-xs text-basalt-muted-foreground">Loading logs...</div>}>
            <LogsContent
              onClose={closeLogs}
              requestIdFilter={requestIdFilter ?? undefined}
              onClearRequestIdFilter={() => setRequestIdFilter(null)}
            />
          </Suspense>
        </div>
      </Dock>
    </>
  );
}
