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

export interface TimeseriesBucket {
  bucket: number; // unix ms start of bucket
  count: number;
  total_tokens: number;
  avg_latency_ms: number;
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
  sort?: "timestamp" | "latency_ms" | "total_tokens" | null;
  order?: "asc" | "desc" | null;
  cursor?: string | null;
  offset?: number | null;
  limit?: number | null;
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
// queryTimeseries
// ---------------------------------------------------------------------------

function intervalToMs(interval: string): number {
  switch (interval) {
    case "minute":
      return 60_000;
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
): TimeseriesBucket[] {
  const intMs = intervalToMs(interval);
  const rangeMs = rangeToMs(range);
  const since = Date.now() - rangeMs;

  const rows = db
    .query(
      `SELECT
        (timestamp / $interval) * $interval as bucket,
        COUNT(*) as count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM requests
      WHERE timestamp >= $since
      GROUP BY bucket
      ORDER BY bucket ASC`,
    )
    .all({ $interval: intMs, $since: since }) as TimeseriesBucket[];

  return rows;
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
  } = params;

  const limit = Math.min(rawLimit ?? 50, 200);
  const validSort = (sort !== null && sort !== undefined && ["timestamp", "latency_ms", "total_tokens"].includes(sort))
    ? (sort as "timestamp" | "latency_ms" | "total_tokens")
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

  // For offset pagination, get total count
  let total: number | null = null;
  if (sort !== "timestamp") {
    const countRow = db
      .query(`SELECT COUNT(*) as count FROM requests ${whereClause}`)
      .get(bindings) as { count: number };
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

  const query = `SELECT * FROM requests ${whereClause} ${orderBy} ${limitClause}`;
  const rows = db.query(query).all(bindings) as RequestRecord[];

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
