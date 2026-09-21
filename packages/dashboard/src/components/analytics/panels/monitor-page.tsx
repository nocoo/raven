import { Suspense } from "react";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { searchParamsToFilters } from "@/lib/analytics-filters";
import { loadMonitorData } from "@/lib/monitor-data";
import { keyLabel, type UsageDimension } from "@/lib/monitor";
import { AnalyticsCharts } from "@/app/analytics-charts";
import { EmptyMonitor, MonitorSummary } from "./monitor-panels";
import { UsageExplorer } from "./usage-explorer";

export interface MonitorPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function MonitorPage({ searchParams, dimension }: MonitorPageProps & { dimension?: UsageDimension }) {
  const params = await searchParams;
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) url.set(key, first);
  }
  const result = await loadMonitorData(searchParamsToFilters(url), dimension);
  const title = dimension === "model" ? "Models" : dimension === "key_id" ? "API Keys" : "Overview";
  const description = dimension === "model"
    ? "Compare model workload, token consumption and protocol paths. Select a model to see who calls it."
    : dimension === "key_id"
      ? "See when each key is used, which models it calls and how those calls are routed."
      : "Traffic, performance and native protocol adoption, with a path from each signal to its requests.";
  return <div className="space-y-4">
    <PageHeader title={title} description={description} filters={<Suspense><FilterBar models={result.ok ? result.data.models.map(entry => entry.key).filter(Boolean) : []} keys={result.ok ? result.data.keys.map(entry => ({ id: entry.key, label: keyLabel(entry) })) : []} /></Suspense>} />
    {result.ok ? <>
      {result.data.warnings.length > 0 && <div role="status" className="rounded-lg border border-basalt-warning/40 bg-basalt-warning/5 p-3 text-xs text-basalt-muted-foreground"><p className="font-medium">Some panels could not be loaded. Their empty state is not a zero count.</p>{result.data.warnings.map(warning => <p key={warning} className="mt-1">{warning}</p>)}</div>}
      <MonitorSummary summary={result.data.summary} percentiles={result.data.percentiles} filters={result.data.filters} />
      {result.data.summary.total_requests === 0 && <EmptyMonitor />}
      {dimension ? <UsageExplorer dimension={dimension} data={result.data} /> : <AnalyticsCharts data={result.data} />}
    </> : <FetchError title={`Failed to load ${title.toLowerCase()}`} message={result.error} />}
  </div>;
}
