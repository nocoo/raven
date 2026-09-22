"use client";

import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UsageDetailSkeleton } from "@/components/layout/page-skeleton";
import type { AnalyticsFilters } from "@/lib/analytics-filters";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import { dimensionHref, formatMonitorTime, keyIdentity, keyLabel, monitorHref, nativeShare, type UsageDimension } from "@/lib/monitor";
import type { MonitorData } from "@/lib/monitor-data";
import type { BreakdownEntry } from "@/lib/types";
import { ActivityChart, TokenChart, TrafficChart } from "./monitor-charts";
import { InvestigationPanel, MonitorLink, MonitorPanel, ProtocolBar, ProtocolDistribution } from "./monitor-panels";
import { UsageDistribution } from "./usage-distribution";

function UsageBreakdown({ entries, dimension, filters, total }: { entries: BreakdownEntry[]; dimension: UsageDimension; filters: AnalyticsFilters; total: number }) {
  const isKey = dimension === "key_id";
  return <section className="min-w-0" aria-label={isKey ? "Calling keys" : "Models called"}>
    <div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="text-xs font-semibold">{isKey ? "Calling keys" : "Models called"}</h3><span className="text-xs text-basalt-muted-foreground">Requests · share of selection</span></div>
    <div className="max-h-72 overflow-y-auto divide-y divide-basalt-border/50">
      {entries.map(entry => {
        const label = isKey ? keyLabel(entry) : entry.key || "Unattributed";
        const native = nativeShare(entry);
        const content = <>
          <div className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-sm font-medium" title={label}>{label}</span><span className="shrink-0 text-xs tabular-nums">{formatCompact(entry.count)} <span className="text-basalt-muted-foreground">· {total > 0 ? formatPercent(entry.count / total) : "—"}</span></span></div>
          {isKey && <p className="mt-0.5 truncate font-mono text-xs text-basalt-muted-foreground" title={keyIdentity(entry.key)}>{keyIdentity(entry.key)}</p>}
          <div className="my-1.5"><ProtocolBar counts={entry} /></div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-basalt-muted-foreground"><span>{formatCompact(entry.total_tokens)} tokens</span><span>P95 {formatLatency(entry.p95_latency_ms)}</span><span className={entry.error_count ? "text-basalt-destructive" : ""}>{formatPercent(entry.error_rate)} errors</span><span>{native === null ? "—" : formatPercent(native)} native</span><ArrowRight className="ml-auto size-3" /></div>
        </>;
        return entry.key ? <Link prefetch={false} key={entry.key} href={dimensionHref(dimension, entry.key, filters)} className="block rounded-md px-1 py-2.5 hover:bg-basalt-accent/50">{content}</Link> : <div key={entry.key} className="px-1 py-2.5">{content}</div>;
      })}
      {entries.length === 0 && <p className="py-4 text-xs text-basalt-muted-foreground">No recorded distribution in this selection</p>}
    </div>
    {entries.length >= 50 && <p className="mt-2 text-xs text-basalt-muted-foreground">Top 50 by requests · shares include the full selection</p>}
  </section>;
}

export function UsageExplorer({ data, dimension }: { data: MonitorData; dimension: UsageDimension }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingTab, setPendingTab] = useState("all");
  const isKey = dimension === "key_id";
  const selected = data.filters[dimension];
  const nameGroup = isKey && !selected ? data.filters.account : undefined;
  const entries = isKey ? data.keys : data.models;
  const current = entries.find(entry => entry.key === selected);
  const available = entries.filter(entry => entry.key);
  const tab = pending ? pendingTab : selected ? `entry:${selected}` : nameGroup ? `account:${nameGroup}` : "all";
  const label = selected ? isKey ? keyLabel({ key: selected, account_name: current?.account_name ?? "" }) : selected : nameGroup ? `Name group: ${nameGroup}` : `All ${isKey ? "keys" : "models"}`;

  function select(value: string) {
    if (value === tab) return;
    const key = value === "all" ? undefined : value.slice("entry:".length);
    const href = monitorHref(isKey ? "/keys" : "/models", data.filters, { [dimension]: key, ...(isKey ? { account: undefined } : {}) });
    setPendingTab(value);
    startTransition(() => router.push(href, { scroll: false }));
  }

  return <>
    <div className="grid grid-cols-1 items-stretch gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
      <UsageDistribution entries={entries} total={data.distributionTotal} dimension={dimension} selected={selected} pending={pending} onSelect={key => select(`entry:${key}`)} />
      <MonitorPanel title={isKey ? "Key details" : "Model details"} description="Switch the selection to compare protocol paths and usage. Trends below follow this selection." action={pending ? <Button variant="ghost" size="sm" disabled className="shrink-0 gap-1 text-xs">Inspect requests<ArrowRight className="size-3.5" /></Button> : <MonitorLink href={monitorHref("/requests", data.filters)}>Inspect requests</MonitorLink>}>
        <Tabs value={tab} onValueChange={select} activationMode="manual">
          <TabsList aria-label={isKey ? "Select API key" : "Select model"} className="flex-nowrap overflow-x-auto pb-0.5" showIndicator={false}>
            <TabsTrigger value="all" disabled={pending} className="shrink-0 rounded-t-md text-xs data-[state=active]:bg-basalt-accent">All {isKey ? "keys" : "models"}</TabsTrigger>
            {nameGroup && <TabsTrigger value={`account:${nameGroup}`} disabled={pending} className="shrink-0 rounded-t-md text-xs data-[state=active]:bg-basalt-accent">Name group: {nameGroup}</TabsTrigger>}
            {available.map(entry => <TabsTrigger key={entry.key} value={`entry:${entry.key}`} disabled={pending} aria-label={isKey ? `${keyLabel(entry)} ${keyIdentity(entry.key)}` : entry.key} title={isKey ? `${keyLabel(entry)} · ${keyIdentity(entry.key)}` : entry.key} className="shrink-0 gap-2 rounded-t-md text-xs data-[state=active]:bg-basalt-accent"><span className="max-w-44 truncate">{isKey ? keyLabel(entry) : entry.key}</span>{isKey && <span className="font-mono text-basalt-muted-foreground">{entry.key.startsWith("legacy:") ? "historical" : entry.key.slice(-8)}</span>}</TabsTrigger>)}
            {selected && !current && <TabsTrigger value={`entry:${selected}`} disabled={pending} className="shrink-0 rounded-t-md text-xs data-[state=active]:bg-basalt-accent">{selected}</TabsTrigger>}
          </TabsList>
          <TabsContent value={tab} className="data-[state=active]:animate-none" aria-busy={pending}>
            {pending ? <UsageDetailSkeleton /> : <>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-basalt-border/50 pb-3">
                <div className="min-w-0"><h3 className="break-all text-sm font-semibold">{label}</h3>{isKey && selected && <p className="mt-1 break-all font-mono text-xs text-basalt-muted-foreground">{keyIdentity(selected)}</p>}{isKey && (nameGroup || selected?.startsWith("legacy:")) && <Badge variant="warning" className="mt-1 text-xs">Historical name group · may contain multiple keys</Badge>}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-basalt-muted-foreground"><span><strong className="text-basalt-foreground">{formatCompact(data.summary.total_requests)}</strong> requests</span><span>{formatCompact(data.summary.total_tokens)} tokens</span><span>P95 {data.percentiles ? formatLatency(data.percentiles.p95) : "—"}</span></div>
                {current && <p className="basis-full text-xs text-basalt-muted-foreground">First in range {formatMonitorTime(current.first_seen)} · Last {formatMonitorTime(current.last_seen)} UTC</p>}
              </div>
              <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <UsageBreakdown entries={isKey ? data.models : data.keys} dimension={isKey ? "model" : "key_id"} filters={data.filters} total={data.summary.total_requests} />
                <section className="min-w-0" aria-label="Protocol paths"><h3 className="mb-3 text-xs font-semibold">Protocol paths</h3><ProtocolDistribution data={data.protocols} summary={data.summary} filters={data.filters} /></section>
              </div>
            </>}
          </TabsContent>
        </Tabs>
        {entries.length >= 50 && <p className="mt-2 text-xs text-basalt-muted-foreground">Top 50 identities by requests · current selection remains available</p>}
      </MonitorPanel>
    </div>
    <ActivityChart data={data} dimension={dimension} />
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2"><TokenChart data={data} /><InvestigationPanel summary={data.summary} filters={data.filters} clients={data.clients} upstreams={data.upstreams} /></div>
    {selected && <TrafficChart data={data} />}
  </>;
}
