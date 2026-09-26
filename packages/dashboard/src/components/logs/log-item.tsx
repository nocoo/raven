"use client";
import type { LogEvent } from "@/hooks/use-log-stream";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@nocoo/basalt";
import { ChevronRight } from "lucide-react";
import { logEntry } from "@/lib/log-entry";
import { formatCompact, formatLatency } from "@/lib/chart-config";
import { CopyButton } from "@/components/copy-button";
import { IPLookup } from "@/components/analytics/panels/ip-management";
import { LocalTime } from "@/components/local-time";
import { cn } from "@/lib/utils";

export function LogItem({ events }: { events: LogEvent[] }) {
  const entry = logEntry(events);
  const variant = entry.status === "success" ? "success" : entry.status === "error" ? "destructive" : entry.status === "denied" || entry.status === "warn" ? "warning" : "secondary";
  return <Dialog><DialogTrigger asChild>
    <Button variant="ghost" aria-label={`View log details: ${entry.model}`} className="h-auto w-full min-w-0 flex-col items-stretch gap-1 rounded-widget bg-basalt-secondary px-3 py-2 text-left font-normal">
      <span className="flex min-w-0 items-center gap-2">
        <time dateTime={new Date(entry.timestamp).toISOString()} className="shrink-0 font-mono text-xs tabular-nums text-basalt-muted-foreground">{new Date(entry.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</time>
        <Badge variant={variant} className="shrink-0 text-[11px]">{entry.status}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.model}>{entry.model}</span>
        {entry.latencyMs !== null && <span className="shrink-0 text-xs tabular-nums">{formatLatency(entry.latencyMs)}</span>}
        <ChevronRight className="size-3.5 shrink-0 text-basalt-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground">
        {!entry.system && <><Badge variant={entry.protocol.variant} className="text-[11px]" title={entry.protocol.title}>{entry.protocol.label}</Badge><span className="truncate font-mono" title={entry.clientIP}>{entry.clientIP || "Unknown IP"}</span></>}
        {entry.account && <span className="max-w-36 truncate" title={entry.account}>{entry.account}</span>}
        <span className="min-w-0 flex-1 truncate font-mono" title={entry.path}>{entry.path}</span>
        {entry.tokens !== null && <span className="shrink-0 tabular-nums">{formatCompact(entry.tokens)} tok</span>}
      </span>
      {entry.error && <span className={cn("truncate text-xs", entry.status === "cancelled" ? "text-basalt-muted-foreground" : "text-basalt-destructive")}>{entry.error}</span>}
    </Button>
  </DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><div className="flex items-center gap-2 pr-8"><DialogTitle className="min-w-0 flex-1 break-all">{entry.model}</DialogTitle><CopyButton value={JSON.stringify(events, null, 2)} /></div><DialogDescription><LocalTime timestamp={entry.timestamp} /> · {entry.requestId || "System event"}</DialogDescription></DialogHeader>
      {!entry.system && <IPLookup ip={entry.clientIP} />}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {Object.entries(entry.data).map(([key, value]) => <div key={key} className="contents"><dt className="text-basalt-muted-foreground">{key === "peerIP" ? "Peer IP" : key}</dt><dd className="min-w-0 whitespace-pre-wrap break-all font-mono">{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}
      </dl>
      <details><summary className="cursor-pointer text-sm">Raw events · {events.length}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-widget bg-basalt-secondary p-3 font-mono text-xs">{JSON.stringify(events, null, 2)}</pre></details>
    </DialogContent>
  </Dialog>;
}
