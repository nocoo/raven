/**
 * Analytics filter state management and URL sync.
 *
 * Provides a shared filter contract between the dashboard and proxy API,
 * with serialization to/from URL search params for deep-linkable state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeRange = "15m" | "1h" | "6h" | "24h" | "7d" | "30d" | "custom";

export interface AnalyticsFilters {
  // Time
  range: TimeRange;
  from?: number; // epoch ms (for custom)
  to?: number;

  // Dimensions (all optional)
  model?: string;
  resolved_model?: string;
  strategy?: string;
  upstream?: string;
  account?: string;
  client?: string;
  client_version?: string;
  session?: string;
  path?: string;
  status?: string;
  status_code?: number;
  stream?: boolean;
  has_error?: boolean;
  min_latency?: number;
  max_latency?: number;
  stop_reason?: string;
  routing_path?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_FILTERS: AnalyticsFilters = {
  range: "24h",
};

// ---------------------------------------------------------------------------
// URL Serialization
// ---------------------------------------------------------------------------

/** Serialize filters to URLSearchParams (omitting defaults and undefined). */
export function filtersToSearchParams(filters: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.range !== "24h") params.set("range", filters.range);
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  if (filters.model) params.set("model", filters.model);
  if (filters.resolved_model) params.set("resolved_model", filters.resolved_model);
  if (filters.strategy) params.set("strategy", filters.strategy);
  if (filters.upstream) params.set("upstream", filters.upstream);
  if (filters.account) params.set("account", filters.account);
  if (filters.client) params.set("client", filters.client);
  if (filters.client_version) params.set("client_version", filters.client_version);
  if (filters.session) params.set("session", filters.session);
  if (filters.path) params.set("path", filters.path);
  if (filters.status) params.set("status", filters.status);
  if (filters.status_code !== undefined) params.set("status_code", String(filters.status_code));
  if (filters.stream !== undefined) params.set("stream", String(filters.stream));
  if (filters.has_error !== undefined) params.set("has_error", String(filters.has_error));
  if (filters.min_latency !== undefined) params.set("min_latency", String(filters.min_latency));
  if (filters.max_latency !== undefined) params.set("max_latency", String(filters.max_latency));
  if (filters.stop_reason) params.set("stop_reason", filters.stop_reason);
  if (filters.routing_path) params.set("routing_path", filters.routing_path);

  return params;
}

/** Deserialize filters from URLSearchParams. */
export function searchParamsToFilters(params: URLSearchParams): AnalyticsFilters {
  const filters: AnalyticsFilters = {
    range: (params.get("range") as TimeRange) || "24h",
  };

  const from = params.get("from");
  if (from) filters.from = Number(from);

  const to = params.get("to");
  if (to) filters.to = Number(to);

  const model = params.get("model");
  if (model) filters.model = model;

  const resolvedModel = params.get("resolved_model");
  if (resolvedModel) filters.resolved_model = resolvedModel;

  const strategy = params.get("strategy");
  if (strategy) filters.strategy = strategy;

  const upstream = params.get("upstream");
  if (upstream) filters.upstream = upstream;

  const account = params.get("account");
  if (account) filters.account = account;

  const client = params.get("client");
  if (client) filters.client = client;

  const clientVersion = params.get("client_version");
  if (clientVersion) filters.client_version = clientVersion;

  const session = params.get("session");
  if (session) filters.session = session;

  const path = params.get("path");
  if (path) filters.path = path;

  const status = params.get("status");
  if (status) filters.status = status;

  const statusCode = params.get("status_code");
  if (statusCode) filters.status_code = Number(statusCode);

  const stream = params.get("stream");
  if (stream === "true") filters.stream = true;
  else if (stream === "false") filters.stream = false;

  const hasError = params.get("has_error");
  if (hasError === "true") filters.has_error = true;

  const minLatency = params.get("min_latency");
  if (minLatency) filters.min_latency = Number(minLatency);

  const maxLatency = params.get("max_latency");
  if (maxLatency) filters.max_latency = Number(maxLatency);

  const stopReason = params.get("stop_reason");
  if (stopReason) filters.stop_reason = stopReason;

  const routingPath = params.get("routing_path");
  if (routingPath) filters.routing_path = routingPath;

  return filters;
}

// ---------------------------------------------------------------------------
// API Query String Builder
// ---------------------------------------------------------------------------

/** Convert range preset to from/to epoch ms. */
export function rangeToEpoch(range: TimeRange): { from: number; to: number } | null {
  if (range === "custom") return null;

  const now = Date.now();
  const offsets: Record<string, number> = {
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "6h": 6 * 60 * 60_000,
    "24h": 24 * 60 * 60_000,
    "7d": 7 * 24 * 60 * 60_000,
    "30d": 30 * 24 * 60 * 60_000,
  };

  const offset = offsets[range];
  if (!offset) return null;

  return { from: now - offset, to: now };
}

/** Auto-select timeseries interval based on range. */
export function rangeToInterval(range: TimeRange): string {
  switch (range) {
    case "15m":
    case "1h":
      return "minute";
    case "6h":
      return "5min";
    case "24h":
    case "7d":
      return "hour";
    case "30d":
      return "day";
    default:
      return "hour";
  }
}

/** Build API query string from filters (for proxy fetch calls). */
export function filtersToApiQuery(filters: AnalyticsFilters): string {
  const params = new URLSearchParams();

  // Time range → from/to
  if (filters.range === "custom") {
    if (filters.from) params.set("from", String(filters.from));
    if (filters.to) params.set("to", String(filters.to));
  } else {
    const epoch = rangeToEpoch(filters.range);
    if (epoch) {
      params.set("from", String(epoch.from));
      params.set("to", String(epoch.to));
    }
  }

  // Dimension filters
  if (filters.model) params.set("model", filters.model);
  if (filters.resolved_model) params.set("resolved_model", filters.resolved_model);
  if (filters.strategy) params.set("strategy", filters.strategy);
  if (filters.upstream) params.set("upstream", filters.upstream);
  if (filters.account) params.set("account", filters.account);
  if (filters.client) params.set("client", filters.client);
  if (filters.client_version) params.set("client_version", filters.client_version);
  if (filters.session) params.set("session", filters.session);
  if (filters.path) params.set("path", filters.path);
  if (filters.status) params.set("status", filters.status);
  if (filters.status_code !== undefined) params.set("status_code", String(filters.status_code));
  if (filters.stream !== undefined) params.set("stream", String(filters.stream));
  if (filters.has_error !== undefined) params.set("has_error", String(filters.has_error));
  if (filters.min_latency !== undefined) params.set("min_latency", String(filters.min_latency));
  if (filters.max_latency !== undefined) params.set("max_latency", String(filters.max_latency));
  if (filters.stop_reason) params.set("stop_reason", filters.stop_reason);
  if (filters.routing_path) params.set("routing_path", filters.routing_path);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// Utility: count active filters (excluding time range)
// ---------------------------------------------------------------------------

export function countActiveFilters(filters: AnalyticsFilters): number {
  let count = 0;
  if (filters.model) count++;
  if (filters.resolved_model) count++;
  if (filters.strategy) count++;
  if (filters.upstream) count++;
  if (filters.account) count++;
  if (filters.client) count++;
  if (filters.client_version) count++;
  if (filters.session) count++;
  if (filters.path) count++;
  if (filters.status) count++;
  if (filters.status_code !== undefined) count++;
  if (filters.stream !== undefined) count++;
  if (filters.has_error !== undefined) count++;
  if (filters.min_latency !== undefined) count++;
  if (filters.max_latency !== undefined) count++;
  if (filters.stop_reason) count++;
  if (filters.routing_path) count++;
  return count;
}

/** Get human-readable label for a filter key. */
export function filterLabel(key: string): string {
  const labels: Record<string, string> = {
    model: "Model",
    resolved_model: "Resolved Model",
    strategy: "Strategy",
    upstream: "Upstream",
    account: "Account",
    client: "Client",
    client_version: "Version",
    session: "Session",
    path: "Path",
    status: "Status",
    status_code: "Status Code",
    stream: "Stream",
    has_error: "Has Error",
    min_latency: "Min Latency",
    max_latency: "Max Latency",
    stop_reason: "Stop Reason",
    routing_path: "Routing",
  };
  return labels[key] ?? key;
}
