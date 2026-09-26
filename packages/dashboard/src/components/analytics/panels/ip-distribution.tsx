"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@nocoo/basalt";
import { AreaChart } from "@nocoo/basalt/charts/area";
import { CHART_COLORS } from "@nocoo/basalt/charts/palette";
import { ChartTooltipContent } from "@nocoo/basalt/charts/tooltip";
import { ipActivitySeries } from "@/lib/ip-management";
import { LocalTime } from "@/components/local-time";
import type { MonitorData } from "@/lib/monitor-data";
import type { BreakdownEntry } from "@/lib/types";
import { formatAxisTime, monitorHref } from "@/lib/monitor";
import { formatCompact, formatPercent } from "@/lib/chart-config";
import { MonitorPanel } from "./monitor-panels";
import { IPLookup, IPPolicyDialog } from "./ip-management";

export function IPDistribution({ data }: { data: MonitorData }) {
  const [selected, setSelected] = useState<BreakdownEntry | null>(null);
  const keyId = data.filters.key_id;
  const editable = keyId && keyId !== "env:default" && !keyId.startsWith("legacy:");
  const activity = ipActivitySeries(data.ipActivity, data.window, data.intervalMs);
  return <MonitorPanel title="Source IPs" description="Request distribution and activity in the selected time range. Includes denied attempts." action={<div className="flex flex-wrap gap-2">{editable && <IPPolicyDialog keyId={keyId} />}<IPPolicyDialog /></div>}>
    <div className="grid gap-4 @min-[45rem]/panel:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="min-w-0"><div className="mb-2 flex justify-between text-xs text-basalt-muted-foreground"><span>IP / last seen</span><span>Requests · share</span></div>
        <div className="max-h-64 overflow-y-auto space-y-1">{data.ips.map(entry => <Button key={entry.key} variant="ghost" onClick={() => setSelected(entry)} className="h-auto w-full flex-col items-stretch gap-1 px-2 py-2 text-left">
          <span className="flex justify-between gap-3"><code className="min-w-0 truncate text-xs">{entry.key || "Unknown / historical"}</code><span className="shrink-0 text-xs tabular-nums">{formatCompact(entry.count)} · {formatPercent(entry.count / Math.max(1, data.summary.total_requests))}</span></span>
          <span className="h-1 overflow-hidden rounded-full bg-basalt-muted"><span className="block h-full rounded-full bg-basalt-primary" style={{ width: `${entry.count / Math.max(1, data.summary.total_requests) * 100}%` }} /></span>
          <span className="text-xs font-normal text-basalt-muted-foreground"><LocalTime timestamp={entry.last_seen} /></span>
        </Button>)}</div>
        {!data.ips.length && <p className="py-8 text-center text-sm text-basalt-muted-foreground">No requests in this time range</p>}
        {data.ips.length >= 50 && <p className="mt-2 text-xs text-basalt-muted-foreground">Top 50 IPs · shares use all requests</p>}
      </div>
      <div className="min-w-0"><AreaChart data={activity.points} series={activity.series.map((item, index) => ({ key: item.key, label: item.label || "Unknown / historical", color: CHART_COLORS[index % CHART_COLORS.length]! }))} stacked showAxes showLegend className="h-64 w-full" ariaLabel="Source IP requests over time" xValueFormatter={value => formatAxisTime(Number(value), data.window.to - data.window.from)} valueFormatter={formatCompact} customTooltip={props => <ChartTooltipContent {...props} label={props.label === undefined ? "" : new Date(Number(props.label)).toLocaleString()} formatter={formatCompact} />} summary={<span className="sr-only">Top five source IPs over time; remaining IPs are grouped as Others. Select an IP in the distribution to inspect its requests.</span>} /></div>
    </div>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent><DialogHeader><DialogTitle>Source IP details</DialogTitle><DialogDescription>Activity within the current filters and time range.</DialogDescription></DialogHeader>
      {selected && <div className="space-y-4"><IPLookup key={selected.key} ip={selected.key} /><div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-basalt-muted-foreground">Requests</p>{selected.count}</div><div><p className="text-xs text-basalt-muted-foreground">Tokens</p>{formatCompact(selected.total_tokens)}</div><div><p className="text-xs text-basalt-muted-foreground">First seen</p><LocalTime timestamp={selected.first_seen} /></div><div><p className="text-xs text-basalt-muted-foreground">Last seen</p><LocalTime timestamp={selected.last_seen} /></div></div><div className="flex flex-wrap gap-2">{selected.key && <Button asChild><Link href={monitorHref("/requests", data.filters, { client_ip: selected.key })}>Inspect requests</Link></Button>}{editable && <IPPolicyDialog keyId={keyId} />}</div></div>}
    </DialogContent></Dialog>
  </MonitorPanel>;
}
