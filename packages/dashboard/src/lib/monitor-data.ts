import { filtersToApiQuery, type AnalyticsFilters } from "./analytics-filters";
import { intervalMilliseconds, monitorInterval, type UsageDimension } from "./monitor";
import { safeFetch, type FetchResult } from "./proxy";
import type { BreakdownEntry, ExtendedTimeseriesBucket, GroupedTimeseries, Percentiles, SummaryStats } from "./types";

export interface MonitorData {
  filters: AnalyticsFilters;
  window: { from: number; to: number };
  intervalMs: number;
  summary: SummaryStats;
  distributionTotal: number | null;
  timeseries: ExtendedTimeseriesBucket[];
  percentiles: Percentiles | null;
  models: BreakdownEntry[];
  keys: BreakdownEntry[];
  protocols: BreakdownEntry[];
  clients: BreakdownEntry[];
  upstreams: BreakdownEntry[];
  activity: GroupedTimeseries;
  ips: BreakdownEntry[];
  ipActivity: GroupedTimeseries;
  warnings: string[];
}

export async function loadMonitorData(filters: AnalyticsFilters, dimension?: UsageDimension): Promise<FetchResult<MonitorData>> {
  const params = new URLSearchParams(filtersToApiQuery(filters));
  const interval = monitorInterval(filters);
  const path = (endpoint: string, extra: Record<string, string> = {}, omit?: string) => {
    const query = new URLSearchParams(params);
    if (omit) query.delete(omit);
    if (omit === "key_id") query.delete("account");
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return `/api/stats/${endpoint}?${query}`;
  };
  const breakdown = (by: string, omit?: string) => safeFetch<BreakdownEntry[]>(path("breakdown", { by, limit: "50", sort: "count", order: "desc" }, omit));
  const [summary, timeseries, percentiles, models, keys, protocols, clients, upstreams, activity, distribution, ips, ipActivity] = await Promise.all([
    safeFetch<SummaryStats>(path("summary")),
    safeFetch<ExtendedTimeseriesBucket[]>(path("timeseries", { interval })),
    safeFetch<Percentiles>(path("percentiles", { metric: "latency_ms" })),
    breakdown("model", dimension === "model" ? "model" : undefined),
    breakdown("key_id", dimension === "key_id" ? "key_id" : undefined),
    breakdown("protocol_mode"),
    breakdown("client_name"),
    breakdown("upstream"),
    dimension
      ? safeFetch<GroupedTimeseries>(path("timeseries-group", { by: dimension, interval, limit: "6" }))
      : Promise.resolve({ ok: true as const, data: { keys: [], points: [] } }),
    dimension && (filters[dimension] || (dimension === "key_id" && filters.account))
      ? safeFetch<SummaryStats>(path("summary", {}, dimension))
      : Promise.resolve(null),
    dimension === "key_id" ? breakdown("client_ip") : Promise.resolve({ ok: true as const, data: [] }),
    dimension === "key_id" ? safeFetch<GroupedTimeseries>(path("timeseries-group", { by: "client_ip", interval, limit: "5" })) : Promise.resolve({ ok: true as const, data: { keys: [], points: [] } }),
  ]);
  if (!summary.ok) return summary;
  const warnings: string[] = [];
  function value<T>(result: FetchResult<T>, empty: T, panel: string): T {
    if (result.ok) return result.data;
    warnings.push(`${panel}: ${result.error}`);
    return empty;
  }
  return { ok: true, data: {
    filters,
    window: { from: Number(params.get("from") ?? 0), to: Number(params.get("to") ?? Date.now()) },
    intervalMs: intervalMilliseconds(interval),
    summary: summary.data,
    distributionTotal: distribution ? value<SummaryStats | null>(distribution, null, "Distribution total")?.total_requests ?? null : summary.data.total_requests,
    timeseries: value(timeseries, [], "Traffic"),
    percentiles: value<Percentiles | null>(percentiles, null, "Latency percentiles"),
    models: value(models, [], "Models"),
    keys: value(keys, [], "API keys"),
    protocols: value(protocols, [], "Protocol paths"),
    clients: value(clients, [], "Clients"),
    upstreams: value(upstreams, [], "Upstreams"),
    activity: value(activity, { keys: [], points: [] }, "Activity"),
    ips: value(ips, [], "IP distribution"),
    ipActivity: value(ipActivity, { keys: [], points: [] }, "IP activity"),
    warnings,
  } };
}
