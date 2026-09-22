import type { ReactNode } from "react";
import { LayerCard } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

function LoadingPage({ title, filters = false, children }: { title: string; filters?: boolean; children: ReactNode }) {
  return <section role="status" aria-label={`Loading ${title}`} aria-busy="true" className="space-y-4">
    <div aria-hidden="true" className="space-y-4">
      <div className="space-y-2"><PageHeader title={title} /><Skeleton className="h-4 w-full max-w-lg" /></div>
      {filters && <div className="flex flex-wrap gap-2">{["time", "protocol", "key", "model", "status", "mode"].map(key => <Skeleton key={key} className="h-8 w-32" />)}</div>}
      {children}
    </div>
  </section>;
}

function SummarySkeleton() {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {["traffic", "latency", "tokens", "native"].map(key => <LayerCard key={key} padding="none" className="space-y-3 px-4 py-3">
      <Skeleton className="h-3 w-24" /><Skeleton className="h-7 w-28" />
      <div className="flex justify-between gap-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-20" /></div>
    </LayerCard>)}
  </div>;
}

function PanelSkeleton({ children }: { children: ReactNode }) {
  return <LayerCard padding="none" className="min-w-0 space-y-4 p-4"><div className="space-y-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-3/4" /></div>{children}</LayerCard>;
}

function RowsSkeleton({ count = 4 }: { count?: number }) {
  return <div className="space-y-4">{ROWS.slice(0, count).map(key => <div key={key} className="space-y-2 py-1">
    <div className="flex justify-between gap-3"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-4 w-12" /></div>
    <Skeleton className="h-1 w-full" /><div className="flex justify-between gap-3"><Skeleton className="h-3 w-1/4" /><Skeleton className="h-3 w-1/4" /><Skeleton className="h-3 w-1/4" /></div>
  </div>)}</div>;
}

function ChartSkeleton() {
  return <PanelSkeleton><Skeleton className="h-56 w-full" /><Skeleton className="h-3 w-3/4" /></PanelSkeleton>;
}

function TableSkeleton() {
  return <LayerCard padding="none" className="divide-y divide-basalt-border/50 overflow-hidden">
    {ROWS.map(key => <div key={key} className="grid grid-cols-4 items-center gap-4 p-4"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-3/4" /></div>)}
  </LayerCard>;
}

function FormSkeleton() {
  return <PanelSkeleton><div className="grid gap-4 sm:grid-cols-2">{ROWS.slice(0, 4).map(key => <div key={key} className="space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-9 w-full" /></div>)}</div><Skeleton className="h-8 w-24" /></PanelSkeleton>;
}

export function OverviewLoading() {
  return <LoadingPage title="Overview" filters><SummarySkeleton /><div className="grid gap-3 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]"><ChartSkeleton /><PanelSkeleton><RowsSkeleton count={3} /></PanelSkeleton></div><div className="grid gap-3 lg:grid-cols-2"><PanelSkeleton><RowsSkeleton /></PanelSkeleton><PanelSkeleton><RowsSkeleton /></PanelSkeleton></div></LoadingPage>;
}

export function UsageStatsSkeleton({ selected = false }: { selected?: boolean }) {
  return <div role="status" aria-label="Loading usage statistics" aria-busy="true">
    <div className="space-y-4" aria-hidden="true">
      <SummarySkeleton />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <PanelSkeleton><Skeleton className="mx-auto size-44 rounded-full" /><div className="space-y-3">{ROWS.slice(0, 5).map(key => <Skeleton key={key} className="h-5 w-full" />)}</div></PanelSkeleton>
        <PanelSkeleton><div className="flex justify-between gap-3"><Skeleton className="h-4 w-36" /><Skeleton className="h-4 w-48" /></div><Skeleton className="h-3 w-2/3" /><div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"><RowsSkeleton /><RowsSkeleton count={3} /></div></PanelSkeleton>
      </div>
      <ChartSkeleton />
      <div className="grid gap-3 xl:grid-cols-2"><ChartSkeleton /><PanelSkeleton><RowsSkeleton count={3} /></PanelSkeleton></div>
      {selected && <ChartSkeleton />}
    </div>
  </div>;
}

function UsageLoading({ title }: { title: string }) {
  return <LoadingPage title={title} filters><div className="flex gap-3 overflow-hidden">{ROWS.slice(0, 3).map(key => <Skeleton key={key} className="h-9 w-32 shrink-0" />)}</div><UsageStatsSkeleton /></LoadingPage>;
}

export function ModelsLoading() { return <UsageLoading title="Models" />; }
export function KeysLoading() { return <UsageLoading title="API Keys" />; }

export function RequestsLoading() {
  return <LoadingPage title="Requests" filters><div className="flex flex-wrap gap-3">{ROWS.slice(0, 4).map(key => <Skeleton key={key} className="h-5 w-32" />)}</div><TableSkeleton /></LoadingPage>;
}

export function CopilotModelsLoading() {
  return <LoadingPage title="Copilot Models"><SummarySkeleton /><Skeleton className="h-9 w-full max-w-md" /><TableSkeleton /></LoadingPage>;
}

export function CopilotAccountLoading() {
  return <LoadingPage title="Copilot Account"><LayerCard className="flex items-center gap-4"><Skeleton className="size-14 shrink-0 rounded-full" /><div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-3 w-28" /></div></LayerCard><SummarySkeleton /><div className="grid gap-3 md:grid-cols-2"><ChartSkeleton /><ChartSkeleton /></div></LoadingPage>;
}

export function SettingsLoading() {
  return <LoadingPage title="Settings"><FormSkeleton /><FormSkeleton /></LoadingPage>;
}

export function ProxyLoading() {
  return <LoadingPage title="Proxy"><FormSkeleton /></LoadingPage>;
}

export function ServerToolsLoading() {
  return <LoadingPage title="Server Tools"><FormSkeleton /><PanelSkeleton><RowsSkeleton count={2} /></PanelSkeleton></LoadingPage>;
}

export function UpstreamsLoading() {
  return <LoadingPage title="Upstreams"><Skeleton className="h-8 w-32" /><TableSkeleton /></LoadingPage>;
}

export function ConnectLoading() {
  return <LoadingPage title="Connect"><div className="grid gap-3 md:grid-cols-2"><PanelSkeleton><Skeleton className="h-40 w-full" /></PanelSkeleton><PanelSkeleton><Skeleton className="h-40 w-full" /></PanelSkeleton></div><TableSkeleton /></LoadingPage>;
}

export function LoginLoading() {
  return <div className="flex min-h-screen items-center justify-center p-4"><div className="w-full max-w-sm"><LoadingPage title="Sign in"><Skeleton className="h-12 w-full" /></LoadingPage></div></div>;
}
