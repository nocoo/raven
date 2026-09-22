"use client";

import Link from "next/link";
import { ArrowRight, Activity, Clock3, KeyRound, Route, Zap } from "lucide-react";
import { Badge, Button, LayerCard } from "@nocoo/basalt";
import type { ReactNode } from "react";
import type { AnalyticsFilters } from "@/lib/analytics-filters";
import { cacheHitRate, CHART_COLORS, formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import { dimensionHref, keyIdentity, keyLabel, monitorHref, nativeShare, PROTOCOL_META, PROTOCOL_MODES, type MonitorDimension } from "@/lib/monitor";
import { LocalTime } from "@/components/local-time";
import type { BreakdownEntry, Percentiles, ProtocolCounts, SummaryStats } from "@/lib/types";

export function MonitorPanel({ title, description, action, children, className = "" }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <LayerCard padding="none" className={`min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-1 text-xs text-basalt-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </LayerCard>
  );
}

export function MonitorLink({ href, children }: { href: string; children: ReactNode }) {
  return <Button variant="ghost" size="sm" className="shrink-0 gap-1 text-xs" asChild><Link prefetch={false} href={href}>{children}<ArrowRight className="size-3.5" /></Link></Button>;
}

export function ProtocolBar({ counts }: { counts: ProtocolCounts }) {
  const total = counts.native_count + counts.translated_count + counts.unknown_count;
  return (
    <div role="img" className="flex h-1.5 w-full overflow-hidden rounded-full bg-basalt-muted" aria-label="Protocol distribution">
      {PROTOCOL_MODES.map(mode => <span key={mode} title={`${PROTOCOL_META[mode].label}: ${counts[`${mode}_count`]}`} style={{ width: `${total > 0 ? counts[`${mode}_count`] / total * 100 : 0}%`, background: CHART_COLORS[PROTOCOL_META[mode].color] }} />)}
    </div>
  );
}

export function MonitorSummary({ summary, percentiles, filters }: { summary: SummaryStats; percentiles: Percentiles | null; filters: AnalyticsFilters }) {
  const native = nativeShare(summary);
  const cache = cacheHitRate(summary.total_cache_read_tokens, summary.total_cache_write_tokens, summary.total_observed_input_tokens);
  const stats = [
    { label: "Traffic", icon: Activity, value: formatCompact(summary.total_requests), unit: "requests", detail: <><Link href={monitorHref("/requests", filters, { status: "error" })} className="hover:underline"><span className={summary.error_count > 0 ? "text-basalt-destructive" : ""}>{formatCompact(summary.error_count)} errors · {formatPercent(summary.error_rate)}</span></Link><span>{formatCompact(summary.stream_count)} streaming</span></> },
    { label: "Response time", icon: Clock3, value: summary.total_requests > 0 ? formatLatency(percentiles?.p95 ?? summary.avg_latency_ms) : "—", unit: percentiles ? "P95 latency" : "average latency", detail: <><span>Avg {summary.total_requests > 0 ? formatLatency(summary.avg_latency_ms) : "—"}</span><span>TTFT {summary.avg_ttft_ms == null ? "—" : formatLatency(summary.avg_ttft_ms)}</span></> },
    { label: "Token usage", icon: Zap, value: formatCompact(summary.total_tokens), unit: "uncached in + out", detail: <><span>{formatCompact(summary.total_input_tokens)} in · {formatCompact(summary.total_output_tokens)} out</span><span>Cache hit {cache == null ? "—" : formatPercent(cache)}</span></> },
    { label: "Native protocol", icon: Route, value: native == null ? "—" : formatPercent(native), unit: "of all requests", detail: <><Link className="hover:underline" href={monitorHref("/requests", filters, { protocol_mode: "translated" })}>{formatCompact(summary.translated_count)} translated</Link><Link className="hover:underline" href={monitorHref("/requests", filters, { protocol_mode: "unknown" })}>{formatCompact(summary.unknown_count)} unknown</Link></> },
  ];
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map(stat => (
    <LayerCard key={stat.label} padding="none" className="min-w-0 px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-basalt-muted-foreground"><stat.icon className="size-3.5" />{stat.label}</div>
      <div className="mt-2 flex flex-wrap items-baseline gap-2"><strong className="font-display text-2xl font-semibold tracking-tight tabular-nums">{stat.value}</strong><span className="text-xs text-basalt-muted-foreground">{stat.unit}</span></div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground">{stat.detail}</div>
    </LayerCard>
  ))}</div>;
}

export function ProtocolPanel({ data, summary, filters }: { data: BreakdownEntry[]; summary: SummaryStats; filters: AnalyticsFilters }) {
  return <MonitorPanel title="Protocol paths" description="Prefer the model’s supported native endpoint.">
    <ProtocolDistribution data={data} summary={summary} filters={filters} />
  </MonitorPanel>;
}

export function ProtocolDistribution({ data, summary, filters }: { data: BreakdownEntry[]; summary: SummaryStats; filters: AnalyticsFilters }) {
  return <>
    <ProtocolBar counts={summary} />
    <div className="mt-2 divide-y divide-basalt-border/50">
      {PROTOCOL_MODES.map(mode => {
        const row = data.find(entry => entry.key === mode);
        const count = summary[`${mode}_count`];
        return <Link prefetch={false} key={mode} href={monitorHref("/requests", filters, { protocol_mode: mode })} title={PROTOCOL_META[mode].description} className="group flex items-center justify-between gap-3 rounded-md py-3 hover:bg-basalt-accent/50">
          <div className="min-w-0"><div className="flex items-center gap-2 text-sm font-medium"><span className="size-2 rounded-full" style={{ background: CHART_COLORS[PROTOCOL_META[mode].color] }} />{PROTOCOL_META[mode].label}<ArrowRight className="size-3 text-basalt-muted-foreground" /></div><p className="mt-1 text-xs text-basalt-muted-foreground">{row ? `${formatCompact(row.error_count)} errors · P95 ${formatLatency(row.p95_latency_ms)}` : count > 0 ? "Details unavailable" : "No requests"}</p></div>
          <div className="text-right tabular-nums"><p className="text-sm font-semibold">{formatCompact(count)}</p><p className="mt-1 text-xs text-basalt-muted-foreground">{summary.total_requests ? formatPercent(count / summary.total_requests) : "—"}</p></div>
        </Link>;
      })}
    </div>
    <p className="border-t border-basalt-border/50 pt-2 text-xs leading-relaxed text-basalt-muted-foreground">Native means the same API protocol, with possible normalization. Chat → Responses counts as translation. Unknown records stay in the denominator.</p>
  </>;
}

export function RankPanel({ title, description, data, dimension, filters, limit = 5, selected, action }: { title: string; description: string; data: BreakdownEntry[]; dimension: MonitorDimension; filters: AnalyticsFilters; limit?: number; selected?: string | undefined; action?: ReactNode }) {
  const peak = Math.max(...data.map(entry => entry.count), 1);
  return <MonitorPanel title={title} description={description} action={action}>
    {data.length === 0 ? <p className="py-8 text-center text-xs text-basalt-muted-foreground">No activity in this scope</p> : <div className="max-h-[620px] space-y-1 overflow-y-auto">
      {data.slice(0, limit).map(entry => {
        const share = nativeShare(entry);
        const label = dimension === "key_id" ? keyLabel(entry) : entry.key || "Unattributed";
        const content = <>
          <div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-medium" title={label}>{label}</span><span className="shrink-0 text-sm font-semibold tabular-nums">{formatCompact(entry.count)}<span className="ml-1 text-xs font-normal text-basalt-muted-foreground">req</span></span></div>
          {dimension === "key_id" && <p className="mt-0.5 truncate font-mono text-xs text-basalt-muted-foreground" title={keyIdentity(entry.key)}>{keyIdentity(entry.key)}</p>}
          <div className="my-2 h-1 rounded-full bg-basalt-muted"><div className="h-full rounded-full bg-basalt-primary/65" style={{ width: `${entry.count / peak * 100}%` }} /></div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground tabular-nums"><span>{formatCompact(entry.total_tokens)} tokens</span><span>P95 {formatLatency(entry.p95_latency_ms)}</span><span className={entry.error_count > 0 ? "text-basalt-destructive" : ""}>{formatPercent(entry.error_rate)} errors</span><span>{share == null ? "—" : formatPercent(share)} native</span></div>
          {dimension === "key_id" && <p className="mt-1 text-xs text-basalt-muted-foreground">Last in range <LocalTime timestamp={entry.last_seen} /></p>}
        </>;
        const className = `block rounded-lg border px-3 py-2.5 ${selected === entry.key ? "border-basalt-primary/40 bg-basalt-primary/5" : "border-transparent"}`;
        return entry.key
          ? <Link prefetch={false} key={entry.key} href={dimensionHref(dimension, entry.key, filters)} aria-current={selected === entry.key ? "true" : undefined} className={`${className} transition-colors hover:bg-basalt-accent/50`}>{content}</Link>
          : <div key={entry.key} className={className}>{content}</div>;
      })}
    </div>}
    {data.length >= limit && <p className="mt-2 text-xs text-basalt-muted-foreground">Top {Math.min(limit, data.length)} by requests · totals include the full selection</p>}
  </MonitorPanel>;
}

export function InvestigationPanel({ summary, filters, clients, upstreams }: { summary: SummaryStats; filters: AnalyticsFilters; clients: BreakdownEntry[]; upstreams: BreakdownEntry[] }) {
  return <MonitorPanel title="Investigate" description="Narrow the current scope and open matching requests.">
    <div className="grid grid-cols-2 gap-2">
      <Button variant="outline" size="sm" asChild><Link prefetch={false} href={monitorHref("/requests", filters, { status: "error" })}>{formatCompact(summary.error_count)} errors <ArrowRight className="size-3" /></Link></Button>
      <Button variant="outline" size="sm" asChild><Link prefetch={false} href={monitorHref("/requests", filters, { min_latency: 10_000 })}>Latency ≥ 10s <ArrowRight className="size-3" /></Link></Button>
    </div>
    {[{ label: "Clients", dimension: "client" as const, entries: clients }, { label: "Upstreams", dimension: "upstream" as const, entries: upstreams }].map(group => <div key={group.label} className="mt-4"><p className="mb-2 text-xs font-medium text-basalt-muted-foreground">{group.label}</p><div className="flex flex-wrap gap-2">{group.entries.filter(entry => entry.key).slice(0, 6).map(entry => <Link prefetch={false} key={entry.key} href={dimensionHref(group.dimension, entry.key, filters)}><Badge variant="secondary" className="gap-2 py-1 text-xs hover:bg-basalt-accent">{entry.key}<span className="tabular-nums text-basalt-muted-foreground">{formatCompact(entry.count)}</span></Badge></Link>)}{group.entries.length === 0 && <span className="text-xs text-basalt-muted-foreground">No recorded activity</span>}</div></div>)}
  </MonitorPanel>;
}

export function EmptyMonitor() {
  return <LayerCard className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-start gap-3"><Activity className="mt-0.5 size-4 text-basalt-muted-foreground" /><div><h2 className="text-sm font-semibold">No requests in this selection</h2><p className="mt-1 text-xs text-basalt-muted-foreground">Choose a wider time range or clear filters. Requests will appear after a client uses Raven.</p></div></div><Button variant="outline" size="sm" asChild><Link href="/connect"><KeyRound className="size-3.5" />Connect a client</Link></Button></LayerCard>;
}
