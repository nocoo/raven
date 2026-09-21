import { filtersToSearchParams, rangeToInterval, type AnalyticsFilters } from "./analytics-filters";
import type { BreakdownEntry, ExtendedRequestRecord, ExtendedTimeseriesBucket, GroupedTimeseries, ProtocolCounts, ProtocolMode } from "./types";

export type UsageDimension = "model" | "key_id";
export type MonitorDimension = UsageDimension | "client" | "upstream";

export const PROTOCOL_MODES = ["native", "translated", "unknown"] as const;
export const PROTOCOL_META = {
  native: { label: "Native", color: "success", description: "Same client and upstream protocol. Payloads and SSE framing may still be normalized." },
  translated: { label: "Translated", color: "warning", description: "A protocol adapter is used, including Chat Completions to Responses." },
  unknown: { label: "Unknown", color: "muted", description: "The recorded route has insufficient evidence to classify." },
} as const;

export type FilterPatch = { [K in keyof AnalyticsFilters]?: AnalyticsFilters[K] | undefined };

export function monitorHref(path: string, filters: AnalyticsFilters, patch: FilterPatch = {}): string {
  const next = { ...filters };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(next, key);
    else Object.assign(next, { [key]: value });
  }
  const query = filtersToSearchParams(next).toString();
  return query ? `${path}?${query}` : path;
}

export function dimensionHref(dimension: MonitorDimension, key: string, filters: AnalyticsFilters): string {
  const path = dimension === "model" ? "/models" : dimension === "key_id" ? "/keys" : "/requests";
  return monitorHref(path, filters, { [dimension]: key || undefined, ...(dimension === "key_id" ? { account: undefined } : {}) });
}

export function keyLabel(entry: Pick<BreakdownEntry, "key" | "account_name">): string {
  return entry.account_name || entry.key.replace(/^legacy:/, "") || "Unattributed";
}

export function keyIdentity(key: string): string {
  return key.startsWith("legacy:") ? "Historical name · ID not recorded" : key;
}

export function nativeShare(counts: ProtocolCounts): number | null {
  const total = counts.native_count + counts.translated_count + counts.unknown_count;
  return total > 0 ? counts.native_count / total : null;
}

export function bucketHref(filters: AnalyticsFilters, bucket: number, intervalMs: number, window: { from: number; to: number }): string {
  return monitorHref("/requests", filters, {
    range: "custom",
    from: Math.max(bucket, window.from),
    to: Math.min(bucket + intervalMs - 1, window.to),
  });
}

export function formatMonitorTime(timestamp: number, precision: "minute" | "second" | "millisecond" = "minute"): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const length = precision === "millisecond" ? 23 : precision === "second" ? 19 : 16;
  return date.toISOString().slice(0, length).replace("T", " ");
}

export function formatAxisTime(timestamp: number, spanMs: number): string {
  const formatted = formatMonitorTime(timestamp);
  if (formatted === "—") return formatted;
  return spanMs > 86_400_000 ? formatted.slice(5, 10) : formatted.slice(11, 16);
}

export function intervalMilliseconds(interval: string): number {
  return ({ minute: 60_000, "5min": 300_000, hour: 3_600_000, day: 86_400_000 } as Record<string, number>)[interval] ?? 3_600_000;
}

export function monitorInterval(filters: AnalyticsFilters): string {
  if (filters.range !== "custom" || filters.from === undefined || filters.to === undefined) return rangeToInterval(filters.range);
  const duration = filters.to - filters.from;
  if (duration <= 3_600_000) return "minute";
  if (duration <= 21_600_000) return "5min";
  return duration <= 604_800_000 ? "hour" : "day";
}

export function fillActivity(data: GroupedTimeseries, from: number, to: number, intervalMs: number): GroupedTimeseries {
  const start = Math.floor(from / intervalMs) * intervalMs;
  if (!Number.isFinite(start) || !Number.isFinite(to) || intervalMs <= 0 || to < from) return { keys: data.keys, points: [] };
  const pointsByBucket = new Map(data.points.map(point => [point.bucket, point]));
  const points: GroupedTimeseries["points"] = [];
  const slots = Math.floor((to - start) / intervalMs) + 1;
  if (slots > 1500) return data;
  for (let i = 0; i < slots; i++) {
    const bucket = start + i * intervalMs;
    const point: GroupedTimeseries["points"][number] = { bucket };
    for (const key of data.keys) point[key] = pointsByBucket.get(bucket)?.[key] ?? 0;
    points.push(point);
  }
  return { keys: data.keys, points };
}

export function chartActivity(data: GroupedTimeseries, labels: Record<string, string>) {
  const series = data.keys.map((key, index) => ({ id: `series_${index}`, key, label: labels[key] ?? key }));
  const points = data.points.map(point => {
    const mapped: Record<string, number> = { bucket: point.bucket };
    for (const item of series) mapped[item.id] = point[item.key] ?? 0;
    return mapped;
  });
  return { series, points };
}

export function trafficSeries(data: ExtendedTimeseriesBucket[], window: { from: number; to: number }, intervalMs: number) {
  const existing = new Map(data.map(bucket => [bucket.bucket, bucket]));
  const activity = fillActivity({ keys: [], points: data.map(bucket => ({ bucket: bucket.bucket })) }, window.from, window.to, intervalMs);
  return activity.points.map(point => ({
    bucket: point.bucket,
    success_count: existing.get(point.bucket)?.success_count ?? 0,
    error_count: existing.get(point.bucket)?.error_count ?? 0,
    p95_latency_ms: existing.get(point.bucket)?.p95_latency_ms ?? null,
    avg_ttft_ms: existing.get(point.bucket)?.avg_ttft_ms ?? null,
    input_tokens: existing.get(point.bucket)?.input_tokens ?? 0,
    output_tokens: existing.get(point.bucket)?.output_tokens ?? 0,
    cache_read_tokens: existing.get(point.bucket)?.cache_read_tokens ?? 0,
    cache_write_tokens: existing.get(point.bucket)?.cache_write_tokens ?? 0,
  }));
}

export function protocolLabel(mode: ProtocolMode): string {
  return PROTOCOL_META[mode].label;
}

export function requestProtocolRoute(request: ExtendedRequestRecord): string {
  const names: Record<string, string> = { anthropic: "Messages", openai: "Chat Completions", responses: "Responses" };
  const client = names[request.client_format] ?? "Unknown";
  if (request.strategy === "copilot-chat-via-responses" || request.routing_path === "chat-via-responses") return `${client} → Responses`;
  const upstream = names[request.upstream_format];
  if (upstream) return `${client} → ${upstream}`;
  if (request.protocol_mode === "native") return `${client} → ${client}`;
  if (request.strategy === "copilot-translated") return `${client} → Chat Completions`;
  return `${client} → Unknown`;
}
