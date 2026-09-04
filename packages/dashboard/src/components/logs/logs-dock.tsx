"use client";

import { Suspense } from "react";
import { Dock } from "@nocoo/basalt/components/dock";
import { Fab } from "@nocoo/basalt/components/fab";
import { Terminal } from "lucide-react";
import { LogsContent } from "@/app/logs/logs-content";
import { useLogDock } from "./log-dock-context";

export function LogsDock() {
  const { isOpen, requestIdFilter, closeLogs, openLogs, setRequestIdFilter } = useLogDock();

  return (
    <>
      <Dock
        mode="overlay"
        open={isOpen}
        width="clamp(380px, 60vw, 1100px)"
        aria-label="Live logs dock"
        dismissLabel="Close live logs dock"
        onDismiss={closeLogs}
        className="h-full z-50"
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

      <Fab
        open={isOpen}
        placement="fixed"
        aria-label="Open live logs"
        onClick={() => openLogs()}
        className="right-6 bottom-6 z-40 bg-basalt-primary text-basalt-primary-foreground hover:bg-basalt-primary/90"
      >
        <Terminal className="size-6" />
      </Fab>
    </>
  );
}
