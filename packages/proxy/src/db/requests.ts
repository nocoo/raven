import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestRecord {
	id: string;
	timestamp: number;
	path: string;
	client_format: string;
	model: string;
	resolved_model: string | null;
	stream: number;
	input_tokens: number | null;
	output_tokens: number | null;
	latency_ms: number;
	ttft_ms: number | null;
	status: string;
	status_code: number;
	upstream_status: number | null;
	error_message: string | null;
	account_name: string;
	session_id: string;
	client_name: string;
	client_version: string | null;
	processing_ms: number | null;
	strategy: string;
	upstream: string;
	upstream_format: string;
	translated_model: string;
	copilot_model: string;
	routing_path: string;
	stop_reason: string;
	tool_call_count: number;
}

export interface OverviewResult {
  total_requests: number;
  total_tokens: number;
  error_count: number;
  avg_latency_ms: number;
}

export interface SummaryResult {
  total_requests: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  error_count: number;
  error_rate: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  avg_processing_ms: number | null;
  stream_count: number;
  sync_count: number;
}

export interface TimeseriesBucket {
  bucket: number; // unix ms start of bucket

  // Traffic
  count: number;
  success_count: number;
  error_count: number;
  stream_count: number;
  sync_count: number;

  // Tokens
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;

  // Latency
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;

  // TTFT
  avg_ttft_ms: number | null;
  p95_ttft_ms: number | null;

  // Processing
  avg_processing_ms: number | null;

  // Status codes
  status_codes: Record<string, number>;
}

export interface BreakdownEntry {
  key: string;
  count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  avg_ttft_ms: number | null;
  error_count: number;
  error_rate: number;
  first_seen: number;
  last_seen: number;
  // Extra fields for session breakdown
  client_name?: string;
  account_name?: string;
  client_version?: string | null;
}

export interface PercentilesResult {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export interface ModelStats {
  model: string;
  count: number;
  total_tokens: number;
  avg_latency_ms: number;
}

export interface QueryParams {
  model?: string | null;
  status?: string | null;
  format?: string | null;
  sort?: "timestamp" | "latency_ms" | "total_tokens" | "ttft_ms" | "processing_ms" | "input_tokens" | "output_tokens" | null | undefined;
  order?: "asc" | "desc" | null | undefined;
  cursor?: string | null | undefined;
  offset?: number | null | undefined;
  limit?: number | null | undefined;
  /** Additional WHERE conditions (from analytics filter parser) */
  extraWhere?: string | undefined;
  /** Positional bindings for extraWhere */
  extraBindings?: unknown[] | undefined;
}

export interface QueryResult {
  data: RequestRecord[];
  next_cursor?: string | null;
  has_more: boolean;
  total?: number | null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS requests (
  id              TEXT PRIMARY KEY,
  timestamp       INTEGER NOT NULL,
  path            TEXT NOT NULL,
  client_format   TEXT NOT NULL,
  model           TEXT NOT NULL,
  resolved_model  TEXT,
  stream          INTEGER NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER GENERATED ALWAYS AS (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) STORED,
  latency_ms      INTEGER NOT NULL,
  ttft_ms         INTEGER,
  status          TEXT NOT NULL,
  status_code     INTEGER NOT NULL,
  upstream_status INTEGER,
  error_message   TEXT,
  account_name    TEXT NOT NULL DEFAULT 'default'
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_latency ON requests(latency_ms);
CREATE INDEX IF NOT EXISTS idx_requests_total_tokens ON requests(total_tokens);
`;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export function initDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INDEXES);

  // Migration: add session tracking columns
  const safeAddColumn = (sql: string) => {
    try { db.exec(sql); } catch (e) {
      if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e;
    }
  };
  safeAddColumn("ALTER TABLE requests ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN client_name TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN client_version TEXT");
	safeAddColumn("ALTER TABLE requests ADD COLUMN processing_ms INTEGER");
	safeAddColumn("ALTER TABLE requests ADD COLUMN strategy TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN upstream TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN upstream_format TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN translated_model TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN copilot_model TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN routing_path TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN stop_reason TEXT NOT NULL DEFAULT ''");
	safeAddColumn("ALTER TABLE requests ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_session_id ON requests(session_id)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_strategy ON requests(strategy)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_name)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_name)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_path ON requests(path)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_requests_upstream ON requests(upstream)");
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

const INSERT_SQL = `
INSERT INTO requests (
  id, timestamp, path, client_format, model, resolved_model,
  stream, input_tokens, output_tokens, latency_ms, ttft_ms,
  status, status_code, upstream_status, error_message, account_name,
  session_id, client_name, client_version,
  processing_ms, strategy, upstream, upstream_format,
  translated_model, copilot_model, routing_path, stop_reason, tool_call_count
) VALUES (
  $id, $timestamp, $path, $client_format, $model, $resolved_model,
  $stream, $input_tokens, $output_tokens, $latency_ms, $ttft_ms,
  $status, $status_code, $upstream_status, $error_message, $account_name,
  $session_id, $client_name, $client_version,
  $processing_ms, $strategy, $upstream, $upstream_format,
  $translated_model, $copilot_model, $routing_path, $stop_reason, $tool_call_count
)`;

export function insertRequest(db: Database, record: RequestRecord): void {
	db.query(INSERT_SQL).run({
		$id: record.id,
		$timestamp: record.timestamp,
		$path: record.path,
		$client_format: record.client_format,
		$model: record.model,
		$resolved_model: record.resolved_model,
		$stream: record.stream,
		$input_tokens: record.input_tokens,
		$output_tokens: record.output_tokens,
		$latency_ms: record.latency_ms,
		$ttft_ms: record.ttft_ms,
		$status: record.status,
		$status_code: record.status_code,
		$upstream_status: record.upstream_status,
		$error_message: record.error_message,
		$account_name: record.account_name,
		$session_id: record.session_id,
		$client_name: record.client_name,
		$client_version: record.client_version,
		$processing_ms: record.processing_ms,
		$strategy: record.strategy,
		$upstream: record.upstream,
		$upstream_format: record.upstream_format,
		$translated_model: record.translated_model,
		$copilot_model: record.copilot_model,
		$routing_path: record.routing_path,
		$stop_reason: record.stop_reason,
		$tool_call_count: record.tool_call_count,
	});
}

// ---------------------------------------------------------------------------
// queryOverview
// ---------------------------------------------------------------------------

export function queryOverview(db: Database): OverviewResult {
  const row = db
    .query(
      `SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM requests`,
    )
    .get() as OverviewResult;
  return row;
}

// ---------------------------------------------------------------------------
// querySummary — filter-aware enhanced overview
// ---------------------------------------------------------------------------

export function querySummary(
  db: Database,
  whereClause: string,
  bindings: (string | number | null)[],
): SummaryResult {
  const sql = `SELECT
    COUNT(*) as total_requests,
    COALESCE(SUM(total_tokens), 0) as total_tokens,
    COALESCE(SUM(COALESCE(input_tokens, 0)), 0) as total_input_tokens,
    COALESCE(SUM(COALESCE(output_tokens, 0)), 0) as total_output_tokens,
    COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
    COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
    AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END) as avg_ttft_ms,
    AVG(CASE WHEN processing_ms IS NOT NULL THEN processing_ms END) as avg_processing_ms,
    COUNT(CASE WHEN stream = 1 THEN 1 END) as stream_count
  FROM requests ${whereClause}`;

  const row = db.query(sql).get(...bindings) as {
    total_requests: number;
    total_tokens: number;
    total_input_tokens: number;
    total_output_tokens: number;
    error_count: number;
    avg_latency_ms: number;
    avg_ttft_ms: number | null;
    avg_processing_ms: number | null;
    stream_count: number;
  };

  const totalRequests = row.total_requests;
  return {
    total_requests: totalRequests,
    total_tokens: row.total_tokens,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    error_count: row.error_count,
    error_rate: totalRequests > 0 ? row.error_count / totalRequests : 0,
    avg_latency_ms: row.avg_latency_ms,
    avg_ttft_ms: row.avg_ttft_ms,
    avg_processing_ms: row.avg_processing_ms,
    stream_count: row.stream_count,
    sync_count: totalRequests - row.stream_count,
  };
}

// ---------------------------------------------------------------------------
// queryBreakdown — universal group-by ranking
// ---------------------------------------------------------------------------

const VALID_BY_COLUMNS: Record<string, string> = {
  model: "model",
  resolved_model: "resolved_model",
  strategy: "strategy",
  upstream: "upstream",
  client_name: "client_name",
  client_version: "client_version",
  account_name: "account_name",
  path: "path",
  status: "status",
  status_code: "status_code",
  stop_reason: "stop_reason",
  stream: "stream",
  routing_path: "routing_path",
  session_id: "session_id",
};

export interface BreakdownParams {
  by: string;
  whereClause?: string | undefined;
  bindings?: (string | number | null)[] | undefined;
  sort?: string | undefined;
  order?: "asc" | "desc" | undefined;
  limit?: number | undefined;
}

export function queryBreakdown(
  db: Database,
  params: BreakdownParams,
): BreakdownEntry[] {
  const column = VALID_BY_COLUMNS[params.by];
  if (!column) return [];

  const limit = Math.min(params.limit ?? 20, 100);
  const sortField = params.sort ?? "count";
  const order = params.order === "asc" ? "ASC" : "DESC";

  // Validate sort field against known aggregate fields
  const validSorts = ["count", "total_tokens", "input_tokens", "output_tokens", "avg_latency_ms", "error_count", "error_rate", "last_seen", "first_seen"];
  const safeSort = validSorts.includes(sortField) ? sortField : "count";

  // Build WHERE clause
  const whereStr = params.whereClause || "";
  const filterBindings = params.bindings || [];

  // Convert positional bindings to named params
  const namedBindings: Record<string, string | number | null> = { $limit: limit };
  let adjustedWhere = whereStr;
  if (filterBindings.length > 0) {
    let idx = 0;
    adjustedWhere = whereStr.replace(/\?/g, () => {
      const key = `$_bd${idx}`;
      namedBindings[key] = filterBindings[idx]!;
      idx++;
      return key;
    });
  }

  // Session breakdown includes extra context columns
  const isSession = params.by === "session_id";
  const extraSelect = isSession
    ? `, MIN(client_name) as _client_name, MIN(account_name) as _account_name, MIN(client_version) as _client_version`
    : "";

  const sql = `SELECT
    CAST(${column} AS TEXT) as key,
    COUNT(*) as count,
    COALESCE(SUM(COALESCE(input_tokens, 0)), 0) as input_tokens,
    COALESCE(SUM(COALESCE(output_tokens, 0)), 0) as output_tokens,
    COALESCE(SUM(total_tokens), 0) as total_tokens,
    COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
    AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END) as avg_ttft_ms,
    COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
    MIN(timestamp) as first_seen,
    MAX(timestamp) as last_seen${extraSelect}
  FROM requests
  ${adjustedWhere}
  GROUP BY ${column}
  ORDER BY ${safeSort} ${order}
  LIMIT $limit`;

  const rows = db.query(sql).all(namedBindings) as Array<{
    key: string;
    count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    avg_latency_ms: number;
    avg_ttft_ms: number | null;
    error_count: number;
    first_seen: number;
    last_seen: number;
    _client_name?: string;
    _account_name?: string;
    _client_version?: string | null;
  }>;

  return rows.map((row) => {
    // Compute p95 latency for this group
    const latencies = db
      .query(
        `SELECT latency_ms FROM requests ${adjustedWhere}${adjustedWhere ? " AND" : "WHERE"} ${column} = $_grp ORDER BY latency_ms`,
      )
      .all({ ...namedBindings, $_grp: row.key }) as Array<{ latency_ms: number }>;

    const entry: BreakdownEntry = {
      key: row.key,
      count: row.count,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      avg_latency_ms: row.avg_latency_ms,
      p95_latency_ms: percentile(latencies.map((l) => l.latency_ms), 0.95),
      avg_ttft_ms: row.avg_ttft_ms,
      error_count: row.error_count,
      error_rate: row.count > 0 ? row.error_count / row.count : 0,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    };

    if (isSession) {
      entry.client_name = row._client_name ?? "";
      entry.account_name = row._account_name ?? "";
      entry.client_version = row._client_version ?? null;
    }

    return entry;
  });
}

// ---------------------------------------------------------------------------
// queryPercentiles
// ---------------------------------------------------------------------------

const VALID_PERCENTILE_METRICS: Record<string, string> = {
  latency_ms: "latency_ms",
  ttft_ms: "ttft_ms",
  processing_ms: "processing_ms",
  total_tokens: "total_tokens",
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
};

export function queryPercentiles(
  db: Database,
  metric: string,
  whereClause = "",
  bindings: (string | number | null)[] = [],
): PercentilesResult | null {
  const column = VALID_PERCENTILE_METRICS[metric];
  if (!column) return null;

  // Nullable metrics need IS NOT NULL filter
  const nullableMetrics = ["ttft_ms", "processing_ms"];
  const nullFilter = nullableMetrics.includes(metric)
    ? `${column} IS NOT NULL`
    : "";

  // Combine WHERE conditions
  const conditions: string[] = [];
  if (whereClause) {
    conditions.push(whereClause.replace(/^WHERE\s+/i, ""));
  }
  if (nullFilter) {
    conditions.push(nullFilter);
  }
  const fullWhere = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Convert positional bindings to named params
  const namedBindings: Record<string, string | number | null> = {};
  let adjustedWhere = fullWhere;
  if (bindings.length > 0) {
    let idx = 0;
    adjustedWhere = fullWhere.replace(/\?/g, () => {
      const key = `$_pc${idx}`;
      namedBindings[key] = bindings[idx]!;
      idx++;
      return key;
    });
  }

  const rows = db
    .query(`SELECT ${column} as val FROM requests ${adjustedWhere} ORDER BY ${column}`)
    .all(namedBindings) as Array<{ val: number }>;

  if (rows.length === 0) {
    return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
  }

  const vals = rows.map((r) => r.val);
  return {
    p50: percentile(vals, 0.50),
    p75: percentile(vals, 0.75),
    p90: percentile(vals, 0.90),
    p95: percentile(vals, 0.95),
    p99: percentile(vals, 0.99),
    min: vals[0]!,
    max: vals[vals.length - 1]!,
    count: vals.length,
  };
}

// ---------------------------------------------------------------------------
// queryTimeseries
// ---------------------------------------------------------------------------

function intervalToMs(interval: string): number {
  switch (interval) {
    case "minute":
      return 60_000;
    case "5min":
      return 300_000;
    case "hour":
      return 3600_000;
    case "day":
      return 86400_000;
    default:
      return 3600_000;
  }
}

function rangeToMs(range: string): number {
  const match = /^(\d+)(h|d|m)$/.exec(range);
  if (!match) return 86400_000; // default 24h
  const value = parseInt(match[1]!, 10);
  switch (match[2]) {
    case "h":
      return value * 3600_000;
    case "d":
      return value * 86400_000;
    case "m":
      return value * 60_000;
    default:
      return 86400_000;
  }
}

export function queryTimeseries(
  db: Database,
  interval: string,
  range: string,
  whereClause = "",
  bindings: (string | number | null)[] = [],
): TimeseriesBucket[] {
  const intMs = intervalToMs(interval);
  const rangeMs = rangeToMs(range);
  const since = Date.now() - rangeMs;

  // Combine range condition with extra filters
  const rangeCondition = `timestamp >= $since`;
  const extraConditions = whereClause ? whereClause.replace(/^WHERE\s+/i, "") : "";
  const fullWhere = extraConditions
    ? `WHERE ${rangeCondition} AND ${extraConditions}`
    : `WHERE ${rangeCondition}`;

  // Convert positional bindings to named params
  const namedBindings: Record<string, string | number | null> = {
    $interval: intMs,
    $since: since,
  };
  let adjustedWhere = fullWhere;
  if (bindings.length > 0) {
    let idx = 0;
    adjustedWhere = fullWhere.replace(/\?/g, () => {
      const key = `$_ts${idx}`;
      namedBindings[key] = bindings[idx]!;
      idx++;
      return key;
    });
  }

  // Main aggregate query
  const rows = db
    .query(
      `SELECT
        (timestamp / $interval) * $interval as bucket,
        COUNT(*) as count,
        COUNT(CASE WHEN status != 'error' THEN 1 END) as success_count,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COUNT(CASE WHEN stream = 1 THEN 1 END) as stream_count,
        COUNT(CASE WHEN stream = 0 THEN 1 END) as sync_count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) as input_tokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0) as output_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
        AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END) as avg_ttft_ms,
        AVG(CASE WHEN processing_ms IS NOT NULL THEN processing_ms END) as avg_processing_ms
      FROM requests
      ${adjustedWhere}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    )
    .all(namedBindings) as Array<{
      bucket: number;
      count: number;
      success_count: number;
      error_count: number;
      stream_count: number;
      sync_count: number;
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      avg_latency_ms: number;
      avg_ttft_ms: number | null;
      avg_processing_ms: number | null;
    }>;

  // Compute percentiles and status codes per bucket
  return rows.map((row) => {
    // Fetch latency values for this bucket for percentile calc
    const latencies = db
      .query(
        `SELECT latency_ms FROM requests ${adjustedWhere} AND (timestamp / $interval) * $interval = $bucket ORDER BY latency_ms`,
      )
      .all({ ...namedBindings, $bucket: row.bucket }) as Array<{ latency_ms: number }>;

    const ttfts = db
      .query(
        `SELECT ttft_ms FROM requests ${adjustedWhere} AND (timestamp / $interval) * $interval = $bucket AND ttft_ms IS NOT NULL ORDER BY ttft_ms`,
      )
      .all({ ...namedBindings, $bucket: row.bucket }) as Array<{ ttft_ms: number }>;

    // Status code distribution for this bucket
    const statusRows = db
      .query(
        `SELECT status_code, COUNT(*) as cnt FROM requests ${adjustedWhere} AND (timestamp / $interval) * $interval = $bucket GROUP BY status_code`,
      )
      .all({ ...namedBindings, $bucket: row.bucket }) as Array<{ status_code: number; cnt: number }>;

    const statusCodes: Record<string, number> = {};
    for (const sr of statusRows) {
      if (sr.status_code) statusCodes[String(sr.status_code)] = sr.cnt;
    }

    return {
      bucket: row.bucket,
      count: row.count,
      success_count: row.success_count,
      error_count: row.error_count,
      stream_count: row.stream_count,
      sync_count: row.sync_count,
      total_tokens: row.total_tokens,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      avg_latency_ms: row.avg_latency_ms,
      p95_latency_ms: percentile(latencies.map((l) => l.latency_ms), 0.95),
      p99_latency_ms: percentile(latencies.map((l) => l.latency_ms), 0.99),
      avg_ttft_ms: row.avg_ttft_ms,
      p95_ttft_ms: ttfts.length > 0 ? percentile(ttfts.map((t) => t.ttft_ms), 0.95) : null,
      avg_processing_ms: row.avg_processing_ms,
      status_codes: statusCodes,
    };
  });
}

/** Compute percentile from a sorted array of numbers. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// queryModels
// ---------------------------------------------------------------------------

export function queryModels(db: Database): ModelStats[] {
  return db
    .query(
      `SELECT
        model,
        COUNT(*) as count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM requests
      GROUP BY model
      ORDER BY count DESC`,
    )
    .all() as ModelStats[];
}

// ---------------------------------------------------------------------------
// queryRecent
// ---------------------------------------------------------------------------

export function queryRecent(
  db: Database,
  limit: number = 50,
): RequestRecord[] {
  return db
    .query(
      `SELECT * FROM requests ORDER BY timestamp DESC LIMIT $limit`,
    )
    .all({ $limit: Math.min(limit, 200) }) as RequestRecord[];
}

// ---------------------------------------------------------------------------
// queryRequests (with filtering, sorting, pagination)
// ---------------------------------------------------------------------------

export function queryRequests(
  db: Database,
  params: QueryParams = {
    model: null,
    status: null,
    format: null,
    sort: null,
    order: null,
    cursor: null,
    offset: null,
    limit: null,
  },
): QueryResult {
  const {
    model,
    status,
    format,
    sort,
    order,
    cursor,
    offset,
    limit: rawLimit,
    extraWhere,
    extraBindings,
  } = params;

  const limit = Math.min(rawLimit ?? 50, 200);
  const validSortColumns = ["timestamp", "latency_ms", "total_tokens", "ttft_ms", "processing_ms", "input_tokens", "output_tokens"];
  const validSort = (sort !== null && sort !== undefined && validSortColumns.includes(sort))
    ? sort
    : "timestamp";
  const validOrder = order === "asc" ? "ASC" : "DESC";

  // Build WHERE clause
  const conditions: string[] = [];
  const bindings: Record<string, string | number | null> = {};

  if (model) {
    conditions.push("model = $model");
    bindings.$model = model;
  }
  if (status) {
    conditions.push("status = $status");
    bindings.$status = status;
  }
  if (format) {
    conditions.push("client_format = $format");
    bindings.$format = format;
  }

  // Append extra conditions from analytics filter parser
  if (extraWhere) {
    conditions.push(extraWhere);
  }

  // Cursor-based pagination for timestamp sort
  if (sort === "timestamp" && cursor) {
    const cursorRow = db
      .query("SELECT timestamp FROM requests WHERE id = $cursor")
      .get({ $cursor: cursor }) as { timestamp: number } | null;

    if (cursorRow) {
      if (validOrder === "DESC") {
        conditions.push("(timestamp < $cursorTs OR (timestamp = $cursorTs AND id < $cursorId))");
      } else {
        conditions.push("(timestamp > $cursorTs OR (timestamp = $cursorTs AND id > $cursorId))");
      }
      bindings.$cursorTs = cursorRow.timestamp;
      bindings.$cursorId = cursor;
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Merge named bindings with positional extra bindings
  // SQLite doesn't mix $named and ? well in bun:sqlite, so we convert
  // extraBindings to named params with unique keys
  const extraNamedBindings: Record<string, string | number | null> = {};
  let adjustedWhereClause = whereClause;
  if (extraBindings && extraBindings.length > 0) {
    let idx = 0;
    adjustedWhereClause = whereClause.replace(/\?/g, () => {
      const key = `$_af${idx}`;
      extraNamedBindings[key] = extraBindings[idx] as string | number | null;
      idx++;
      return key;
    });
  }

  const allBindings: Record<string, string | number | null> = { ...bindings, ...extraNamedBindings };

  // For offset pagination, get total count
  let total: number | null = null;
  if (sort !== "timestamp") {
    const countRow = db
      .query(`SELECT COUNT(*) as count FROM requests ${adjustedWhereClause}`)
      .get(allBindings) as { count: number };
    total = countRow.count;
  }

  // Build ORDER BY
  const orderBy =
    sort === "timestamp"
      ? `ORDER BY timestamp ${validOrder}, id ${validOrder}`
      : `ORDER BY ${validSort} ${validOrder}`;

  // Build LIMIT/OFFSET
  const limitClause =
    sort === "timestamp"
      ? `LIMIT ${limit + 1}` // fetch one extra to detect has_more
      : `LIMIT ${limit + 1} OFFSET ${offset ?? 0}`;

  const query = `SELECT * FROM requests ${adjustedWhereClause} ${orderBy} ${limitClause}`;
  const rows = db.query(query).all(allBindings) as RequestRecord[];

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  const result: QueryResult = {
    data,
    has_more: hasMore,
    next_cursor: null,
    total: null,
  };

  // Cursor for next page
  if (sort === "timestamp" && hasMore && data.length > 0) {
    const last = data[data.length - 1]
    if (last) result.next_cursor = last.id;
  }

  // Total for offset pagination
  if (total !== null) {
    result.total = total;
  }

  return result;
}
