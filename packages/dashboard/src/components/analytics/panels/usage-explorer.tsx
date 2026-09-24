"use client";

import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UsageStatsSkeleton } from "@/components/layout/page-skeleton";
import type { AnalyticsFilters } from "@/lib/analytics-filters";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import { dimensionHref, keyIdentity, keyLabel, monitorHref, type UsageDimension } from "@/lib/monitor";
import { LocalTime } from "@/components/local-time";
import { IdentityHint } from "@/components/identity-hint";
import type { MonitorData } from "@/lib/monitor-data";
import type { BreakdownEntry } from "@/lib/types";
import { ActivityChart, TokenChart, TrafficChart } from "./monitor-charts";
import { EmptyMonitor, InvestigationPanel, MonitorLink, MonitorPanel, MonitorSummary, ProtocolBar, ProtocolDistribution, UsageMetrics } from "./monitor-panels";
import { UsageDistribution } from "./usage-distribution";

function UsageBreakdown({ entries, dimension, filters, total }: { entries: BreakdownEntry[]; dimension: UsageDimension; filters: AnalyticsFilters; total: number }) {
  const isKey = dimension === "key_id";
  return <section className="min-w-0" aria-label={isKey ? "Calling keys" : "Models called"}>
    <div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="text-xs font-semibold">{isKey ? "Calling keys" : "Models called"}</h3><span className="text-xs text-basalt-muted-foreground">Requests · share of selection</span></div>
    <div className="max-h-72 overflow-y-auto divide-y divide-basalt-border/50">
      {entries.map(entry => {
        const label = isKey ? keyLabel(entry) : entry.key || "Unattributed";
        const content = <>
          <div className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-sm font-medium" title={label}>{label}</span><span className="shrink-0 text-xs tabular-nums">{formatCompact(entry.count)} <span className="text-basalt-muted-foreground">· {total > 0 ? formatPercent(entry.count / total) : "—"}</span></span></div>
          <div className="my-1.5"><ProtocolBar counts={entry} /></div>
          <UsageMetrics entry={entry} />
        </>;
        const row = entry.key ? <Link prefetch={false} key={entry.key} href={dimensionHref(dimension, entry.key, filters)} className="block rounded-md px-3 py-2 hover:bg-basalt-accent/50">{content}</Link> : <div key={entry.key} className="px-3 py-2">{content}</div>;
        return isKey && entry.key ? <IdentityHint key={entry.key} identity={keyIdentity(entry.key)}>{row}</IdentityHint> : row;
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

  return <Tabs value={tab} onValueChange={select} activationMode="manual" className="min-w-0">
    <div className="overflow-x-auto pb-0.5">
    <TabsList aria-label={isKey ? "Select API key" : "Select model"} className="w-max min-w-full flex-nowrap">
      <TabsTrigger value="all" disabled={pending} className="shrink-0">All {isKey ? "keys" : "models"}</TabsTrigger>
      {nameGroup && <TabsTrigger value={`account:${nameGroup}`} disabled={pending} className="shrink-0">Name group: {nameGroup}</TabsTrigger>}
      {available.map(entry => <TabsTrigger key={entry.key} value={`entry:${entry.key}`} disabled={pending} title={isKey ? keyIdentity(entry.key) : entry.key} aria-label={isKey ? `${keyLabel(entry)} ${keyIdentity(entry.key)}` : entry.key} className="shrink-0"><span className="max-w-44 truncate">{isKey ? keyLabel(entry) : entry.key}</span></TabsTrigger>)}
      {selected && !current && <TabsTrigger value={`entry:${selected}`} disabled={pending} className="shrink-0">{selected}</TabsTrigger>}
    </TabsList>
    </div>
    {entries.length >= 50 && <p className="mt-2 text-xs text-basalt-muted-foreground">Top 50 identities by requests · current selection remains available</p>}
    <TabsContent value={tab} className="space-y-4 data-[state=active]:animate-none" aria-busy={pending}>
      {pending ? <UsageStatsSkeleton selected={pendingTab !== "all"} /> : <>
        <MonitorSummary summary={data.summary} percentiles={data.percentiles} filters={data.filters} />
        {data.summary.total_requests === 0 && <EmptyMonitor />}
        <div className="grid grid-cols-1 items-stretch gap-3 @min-[60rem]/page:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
          <UsageDistribution entries={entries} total={data.distributionTotal} dimension={dimension} selected={selected} />
          <MonitorPanel title={isKey ? "Key details" : "Model details"} description="Usage and protocol paths." action={<MonitorLink href={monitorHref("/requests", data.filters)}>Inspect requests</MonitorLink>}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-basalt-border/50 pb-3">
              <div className="min-w-0"><h3 className="break-all text-sm font-semibold">{isKey && selected ? <IdentityHint identity={keyIdentity(selected)}><Button variant="ghost" size="sm" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-sm font-semibold">{label}</Button></IdentityHint> : label}</h3>{isKey && (nameGroup || selected?.startsWith("legacy:")) && <Badge variant="warning" className="mt-1 text-xs">Historical name group · may contain multiple keys</Badge>}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-basalt-muted-foreground"><span><strong className="text-basalt-foreground">{formatCompact(data.summary.total_requests)}</strong> requests</span><span>{formatCompact(data.summary.total_tokens)} tokens</span><span>P95 {data.percentiles ? formatLatency(data.percentiles.p95) : "—"}</span></div>
              {current && <p className="text-xs text-basalt-muted-foreground">First in range <LocalTime timestamp={current.first_seen} /> · Last <LocalTime timestamp={current.last_seen} /></p>}
            </div>
            <div className="grid min-w-0 gap-4 @min-[34rem]/panel:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <UsageBreakdown entries={isKey ? data.models : data.keys} dimension={isKey ? "model" : "key_id"} filters={data.filters} total={data.summary.total_requests} />
              <section className="min-w-0" aria-label="Protocol paths"><h3 className="mb-3 text-xs font-semibold">Protocol paths</h3><ProtocolDistribution data={data.protocols} summary={data.summary} filters={data.filters} /></section>
            </div>
          </MonitorPanel>
        </div>
        <ActivityChart data={data} dimension={dimension} />
        <div className="grid grid-cols-1 gap-3 @min-[60rem]/page:grid-cols-2"><TokenChart data={data} /><InvestigationPanel summary={data.summary} filters={data.filters} clients={data.clients} upstreams={data.upstreams} /></div>
        {selected && <TrafficChart data={data} />}
      </>}
    </TabsContent>
  </Tabs>;
}
