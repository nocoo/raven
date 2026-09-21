import type { MonitorData } from "@/lib/monitor-data";
import type { BreakdownEntry, ExtendedRequestRecord, ExtendedTimeseriesBucket, SummaryStats } from "@/lib/types";

export function summary(overrides: Partial<SummaryStats> = {}): SummaryStats {
  return { total_requests: 10, total_tokens: 1000, total_input_tokens: 800, total_output_tokens: 200, total_cache_read_tokens: 300, total_cache_write_tokens: 100, total_observed_input_tokens: 800, error_count: 2, error_rate: 0.2, avg_latency_ms: 400, avg_ttft_ms: 120, avg_processing_ms: 20, stream_count: 8, sync_count: 2, native_count: 6, translated_count: 3, unknown_count: 1, ...overrides };
}

export function entry(key: string, overrides: Partial<BreakdownEntry> = {}): BreakdownEntry {
  return { key, count: 10, input_tokens: 800, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 100, observed_input_tokens: 800, total_tokens: 1000, avg_latency_ms: 400, p95_latency_ms: 900, avg_ttft_ms: 120, error_count: 2, error_rate: 0.2, first_seen: 60_000, last_seen: 180_000, native_count: 6, translated_count: 3, unknown_count: 1, ...overrides };
}

export function bucket(overrides: Partial<ExtendedTimeseriesBucket> = {}): ExtendedTimeseriesBucket {
  return { bucket: 60_000, count: 10, success_count: 8, error_count: 2, stream_count: 8, sync_count: 2, total_tokens: 1000, input_tokens: 800, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 100, observed_input_tokens: 800, avg_latency_ms: 400, p95_latency_ms: 900, p99_latency_ms: 1200, avg_ttft_ms: 120, p95_ttft_ms: 200, avg_processing_ms: 20, status_codes: { "200": 8, "429": 2 }, ...overrides };
}

export function request(overrides: Partial<ExtendedRequestRecord> = {}): ExtendedRequestRecord {
  return { id: "request-1", timestamp: 60_000, path: "/v1/messages", client_format: "anthropic", model: "claude.opus-4.6", resolved_model: null, stream: 1, input_tokens: 80, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 10, latency_ms: 400, ttft_ms: 120, status: "success", status_code: 200, upstream_status: 200, error_message: null, account_name: "Editor", session_id: "session-1", client_name: "Claude Code", client_version: "1.0", api_key_id: "key-1", key_id: "key-1", protocol_mode: "native", server_tools_used: 0, processing_ms: 20, strategy: "copilot-native", upstream: "copilot", upstream_format: "", translated_model: "", copilot_model: "claude-opus-4.6", routing_path: "native", stop_reason: "end_turn", tool_call_count: 0, ...overrides };
}

export function monitorData(overrides: Partial<MonitorData> = {}): MonitorData {
  return { filters: { range: "custom", from: 60_000, to: 239_999 }, window: { from: 60_000, to: 239_999 }, intervalMs: 60_000, summary: summary(), timeseries: [bucket()], percentiles: { p50: 400, p75: 700, p90: 850, p95: 900, p99: 1200, min: 50, max: 1200, count: 10 }, models: [entry("claude.opus-4.6")], keys: [entry("key-1", { account_name: "Editor" })], protocols: [entry("native", { count: 6 }), entry("translated", { count: 3 }), entry("unknown", { count: 1 })], clients: [entry("Claude Code")], upstreams: [entry("copilot")], activity: { keys: ["key-1"], points: [{ bucket: 60_000, "key-1": 10 }] }, warnings: [], ...overrides };
}
