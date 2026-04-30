# 21 — Dashboard Analytics & Visualization Enhancement

> Turn the current "overview + log viewer" into a professional analytics dashboard with
> categorized visualizations, universal filtering, and historical depth.

## Status: Draft

## Context

The current dashboard has two disjointed analytics paths:

| Layer | Source | Strengths | Weaknesses |
|-------|--------|-----------|------------|
| **Historical** (Overview, Models, Requests) | SQLite `requests` table via `/api/stats/*` | Persistent, survives restart | Few filters, no percentiles, no error rate timeseries, missing fields |
| **Live** (Logs page) | SSE ring buffer → `useLogStream` | Rich (processingMs, strategy, sessions, TTFT charts) | Ephemeral, lost on page reload/reconnect |

### Fields emitted in `request_end` but NOT persisted

| Field | Persist? | Rationale |
|-------|----------|-----------|
| `processingMs` | ✅ Yes | Core streaming perf metric, needed for historical charts |
| `strategy` | ✅ Yes | Routing analytics, provider comparison |
| `upstream` | ✅ Yes | Custom provider health tracking |
| `upstreamFormat` | ✅ Yes | Format distribution, debugging |
| `translatedModel` | ✅ Yes | Model routing drilldown (A→O mapping) |
| `copilotModel` | ✅ Yes | Native dispatch tracking |
| `routingPath` | ✅ Yes | `native` vs `translated` distribution |
| `stopReason` | ✅ Yes | Response termination analysis |
| `toolCallCount` | ✅ Yes | Tool usage analytics |
| `toolCallNames` | ❌ No | Variable-length string array; sensitive (reveals tool names). Live/debug only. |

### Current filter support (`GET /requests`)

Only: `model`, `status`, `format`, `sort`, `order`, `cursor/offset`, `limit`.

Missing: time range, path, stream, account, client, session, status_code, resolved_model, strategy, upstream.

### Current stats endpoints

- `/stats/overview` — 4 aggregates (no filters)
- `/stats/timeseries` — bucketed count/tokens/latency (interval+range only, no filters, no error_rate)
- `/stats/models` — per-model count/tokens/latency (no filters)
- `/stats/recent` — alias for last N requests

---

## Design Goals

1. **Categorized visualization** — users find charts by concern (Traffic, Performance, Reliability, Usage, Models, Clients, Providers) not by page name.
2. **Universal filter bar** — time range + dimension filters apply across all panels on a page.
3. **Historical + Live parity** — same panel components render from both historical API and live SSE source.
4. **Progressive enhancement** — UI shell works with current API on day 1; deeper stats unlock as backend endpoints ship.
5. **Professional data density** — percentiles, distributions, heatmaps, sparklines, drill-down tables.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│               Dashboard (Next.js 16)                 │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Analytics Shell (layout + filter state)      │   │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐ │   │
│  │  │FilterBar│ │TimeRange │ │ URL sync       │ │   │
│  │  └─────────┘ └──────────┘ └───────────────┘ │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌─────────────┐ ┌─────────────┐ ┌────────────┐   │
│  │  Overview   │ │   Models    │ │  Requests   │   │
│  │  (Traffic + │ │  (Explorer  │ │  (Filtered  │   │
│  │  Perf +     │ │  + Compare) │ │  table +    │   │
│  │  Reliab.)   │ │             │ │  detail)    │   │
│  └─────────────┘ └─────────────┘ └────────────┘   │
│  ┌─────────────┐ ┌─────────────┐                   │
│  │  Live       │ │  Clients &  │                   │
│  │  (SSE with  │ │  Sessions   │                   │
│  │  panels)    │ │             │                   │
│  └─────────────┘ └─────────────┘                   │
└─────────────────────────────────────────────────────┘
         │                    │
         │  BFF API routes    │
         ▼                    ▼
┌─────────────────────────────────────────────────────┐
│                Proxy (Hono / SQLite)                  │
│                                                      │
│  /stats/summary     (filter-aware overview + pctls)  │
│  /stats/timeseries  (full bucket metrics + filters)  │
│  /stats/breakdown   (universal group-by ranking)     │
│  /stats/percentiles (per-metric pctl distribution)   │
│  /requests          (extended filters)               │
│  /ws/logs           (existing live stream)           │
└─────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1 — Backend: Extend DB & API (proxy)

#### 1.1 DB Migration: Add missing columns

**File:** `packages/proxy/src/db/requests.ts`

Add columns to `requests` table:

```sql
-- Timing
ALTER TABLE requests ADD COLUMN processing_ms INTEGER;

-- Routing
ALTER TABLE requests ADD COLUMN strategy TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN upstream TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN upstream_format TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN translated_model TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN copilot_model TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN routing_path TEXT NOT NULL DEFAULT '';

-- Response metadata
ALTER TABLE requests ADD COLUMN stop_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0;
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_requests_strategy ON requests(strategy);
CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_name);
CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_name);
CREATE INDEX IF NOT EXISTS idx_requests_path ON requests(path);
CREATE INDEX IF NOT EXISTS idx_requests_upstream ON requests(upstream);
```

**NOT persisted:** `toolCallNames` — variable-length, potentially sensitive (reveals tool names). Available in live SSE events only.

#### 1.2 Update request-sink AND strategy emit layer

**A. Promote `stopReason` / `toolCallCount` to unconditional end-log fields.**

Currently several strategies (`copilot-translated`, `custom-openai`, `copilot-openai-direct`) only emit `stopReason`, `toolCallCount`, and `toolCallNames` inside `debugExtras` (gated by `tool_call_debug`). For historical analytics to work, the first two must be emitted unconditionally in every strategy's `describeEndLog`:

- `stopReason` → always include in `request_end.data` (safe, single string like `"stop"` / `"tool_use"`)
- `toolCallCount` → always include (integer, no sensitivity concern)
- `toolCallNames` → keep in `debugExtras` only (variable-length, reveals tool names)

**Files to modify:** Each strategy's `describeEndLog` method:
- `packages/proxy/src/strategies/copilot-translated.ts`
- `packages/proxy/src/strategies/custom-openai.ts`
- `packages/proxy/src/strategies/copilot-openai-direct.ts`
- Any other strategy that tracks stop reason / tool calls

**B. Update request-sink to persist new fields.**

**File:** `packages/proxy/src/db/request-sink.ts`

Map additional `event.data` fields:
- `d.processingMs` → `processing_ms`
- `d.strategy` → `strategy`
- `d.upstream` → `upstream`
- `d.upstreamFormat` → `upstream_format`
- `d.translatedModel` → `translated_model`
- `d.copilotModel` → `copilot_model`
- `d.routingPath` → `routing_path`
- `d.stopReason` → `stop_reason`
- `d.toolCallCount` → `tool_call_count`

#### 1.3 Shared analytics filter parser + SQL WHERE builder

**New file:** `packages/proxy/src/db/analytics-filters.ts`

Single source of truth for filter parsing and SQL generation. All stats/requests endpoints reuse this.

```ts
/** Supported filter params — parsed from query string */
interface AnalyticsFilterParams {
  from?: number;            // timestamp >= (epoch ms)
  to?: number;              // timestamp <=
  model?: string;           // exact match
  resolved_model?: string;
  strategy?: string;
  upstream?: string;
  account?: string;         // account_name =
  client?: string;          // client_name =
  client_version?: string;  // client_version =
  session?: string;         // session_id =
  path?: string;            // path LIKE '%value%'
  status?: string;          // exact match
  status_code?: number;
  stream?: boolean;         // 0 or 1
  has_error?: boolean;      // status = 'error' shortcut
  min_latency?: number;     // latency_ms >=
  max_latency?: number;     // latency_ms <=
  stop_reason?: string;
  routing_path?: string;
}

/** Parse query params from Hono context → typed filter object */
function parseAnalyticsFilters(c: Context): AnalyticsFilterParams;

/** Build WHERE clause + bindings from filters (safe parameterized SQL) */
function buildWhereClause(filters: AnalyticsFilterParams): {
  where: string;       // e.g. "WHERE timestamp >= ? AND model = ? ..."
  bindings: unknown[];
};
```

Column name mapping, boolean parsing, time range validation — all centralized here. Unit tests cover every filter combination.

#### 1.4 Extend `/requests` filter support

**File:** `packages/proxy/src/routes/requests.ts`

Import and use `parseAnalyticsFilters` + `buildWhereClause` from 1.3. All filter params from the shared parser are supported.

New sort columns: `ttft_ms`, `processing_ms`, `input_tokens`, `output_tokens`.

#### 1.5 Filter-aware `/stats/summary` (replaces `/stats/overview`)

**File:** `packages/proxy/src/routes/stats.ts`

```
GET /stats/summary?from=...&to=...&model=...&...
```

Uses shared filter parser. Returns comprehensive overview:

```ts
interface SummaryStats {
  total_requests: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  error_count: number;
  error_rate: number;          // error_count / total_requests
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  avg_processing_ms: number | null;
  stream_count: number;
  sync_count: number;          // total_requests - stream_count
}
```

Backward compat: keep `/stats/overview` as alias that calls summary with no filters.

#### 1.6 Extend `/stats/timeseries` with full bucket metrics

```
GET /stats/timeseries?interval=hour&range=24h&model=...&...
```

Uses shared filter parser. Supported intervals: `minute`, `5min` (new), `hour`, `day`.

Extended bucket response:

```ts
interface TimeseriesBucket {
  bucket: number;              // epoch ms

  // Traffic
  count: number;
  success_count: number;       // NEW — status != 'error'
  error_count: number;         // NEW
  stream_count: number;        // NEW — stream = 1
  sync_count: number;          // NEW — stream = 0

  // Tokens
  total_tokens: number;
  input_tokens: number;        // NEW
  output_tokens: number;       // NEW

  // Latency
  avg_latency_ms: number;
  p95_latency_ms: number;      // NEW
  p99_latency_ms: number;      // NEW

  // TTFT
  avg_ttft_ms: number | null;  // NEW
  p95_ttft_ms: number | null;  // NEW

  // Processing
  avg_processing_ms: number | null;  // NEW

  // Status codes — top codes in this bucket
  status_codes: Record<string, number>;  // NEW e.g. {"200": 45, "429": 3, "500": 1}
}
```

**Implementation notes:**
- `success_count` / `error_count` / `stream_count` / `sync_count`: use `SUM(CASE WHEN ...)` in SQL.
- `input_tokens` / `output_tokens`: `SUM(COALESCE(input_tokens, 0))`.
- `p95/p99`: For each bucket, fetch all latency values and compute in JS (bucket sizes are small — typically <1000 rows per bucket). Alternative: use SQLite `ntile()` if bucket sizes are large.
- `status_codes`: `GROUP BY bucket, status_code` as a subquery, then aggregate into a map in JS.

#### 1.7 Enhanced `/stats/breakdown` — universal ranking endpoint

```
GET /stats/breakdown?by=model&from=...&to=...&sort=count&order=desc&limit=20
```

**Supported `by` values:** `model`, `resolved_model`, `strategy`, `upstream`, `client_name`, `client_version`, `account_name`, `path`, `status`, `status_code`, `stop_reason`, `stream`, `routing_path`, `session_id`.

Uses shared filter parser. Returns enriched ranking entries:

```ts
interface BreakdownEntry {
  key: string;
  count: number;

  // Tokens (split)
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;

  // Performance
  avg_latency_ms: number;
  p95_latency_ms: number;     // approximated via ntile or exact for small groups
  avg_ttft_ms: number | null;

  // Reliability
  error_count: number;
  error_rate: number;          // error_count / count

  // Recency
  last_seen: number;           // MAX(timestamp), epoch ms
  first_seen: number;          // MIN(timestamp), epoch ms
}
```

**Sort params:** `sort` (any numeric field above, default `count`), `order` (`asc`/`desc`, default `desc`), `limit` (default 20, max 100).

**Session ranking (by=session_id):** Returns session-level aggregates including `first_seen`/`last_seen` (enabling duration calculation), `count` (request count), tokens, errors. This provides the entry point for the Sessions page — no separate endpoint needed.

When `by=session_id`, the response includes additional context fields (a session typically belongs to one client/account, so these are deterministic):

```ts
interface SessionBreakdownEntry extends BreakdownEntry {
  // Inherited first_seen/last_seen → duration = last_seen - first_seen
  client_name: string;    // from the session's requests (MODE or first row)
  account_name: string;   // from the session's requests
  client_version: string | null;
}
```

Implementation: use `MIN(client_name)` / `MIN(account_name)` / `MIN(client_version)` in the GROUP BY query — valid because a single session_id always maps to one client/account.

**Client ranking detail:** When `by=client_name`, the `key` is the client name. Version breakdown: use `by=client_version&client=X` to get per-version stats for a specific client.

#### 1.8 New endpoint: `/stats/percentiles`

```
GET /stats/percentiles?metric=latency_ms&from=...&to=...&model=...
```

Uses shared filter parser.

**Supported metrics:** `latency_ms`, `ttft_ms`, `processing_ms`, `total_tokens`, `input_tokens`, `output_tokens`.

**Response:**

```ts
interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}
```

**Implementation:** Fetch all matching values with `SELECT {metric} FROM requests WHERE ... AND {metric} IS NOT NULL ORDER BY {metric}`, then compute percentiles in JS. For ranges exceeding 50k rows, use SQLite `ntile(100)` approximation and select from the appropriate tile.

---

### Phase 2 — Frontend: Analytics Shell & Universal Filters

#### 2.1 Analytics filter state management

**New files:**
- `packages/dashboard/src/lib/analytics-filters.ts` — filter types + URL serialization
- `packages/dashboard/src/components/analytics/filter-bar.tsx` — FilterBar component
- `packages/dashboard/src/components/analytics/time-range-picker.tsx` — TimeRangePicker
- `packages/dashboard/src/components/analytics/filter-chip.tsx` — removable filter chips

**Filter state shape:**

```ts
interface AnalyticsFilters {
  // Time
  range: '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';
  from?: number;   // epoch ms (for custom)
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
```

Sync to URL search params. Shared across all pages via layout context.

#### 2.2 Interval auto-selection

Based on time range:
- 15m → 1-minute buckets
- 1h → 1-minute buckets
- 6h → 5-minute buckets
- 24h → 1-hour buckets
- 7d → 1-hour buckets
- 30d → 1-day buckets

#### 2.3 Shared analytics layout

Wrap `/`, `/models`, `/requests` in a layout component that renders FilterBar at the top. Filter state propagates to child pages.

---

### Phase 3 — Frontend: Enhanced Overview

#### 3.1 Upgraded stat cards row

| Card | Data Source | Sparkline |
|------|-------------|-----------|
| Total Requests | summary.total_requests | timeseries.count |
| Error Rate | summary.error_rate | timeseries.error_count / timeseries.count |
| Avg Latency | summary.avg_latency_ms | timeseries.avg_latency_ms |
| P95 Latency | percentiles.p95 (latency_ms) | timeseries.p95_latency_ms |
| Avg TTFT | summary.avg_ttft_ms | timeseries.avg_ttft_ms |
| Total Tokens | summary.total_tokens | timeseries.total_tokens |

All cards are filter-aware — they reflect the current filter context.

#### 3.2 Enhanced timeseries charts

Replace the current 3-chart grid with categorized panels. **Every chart field is backed by the API contract in 1.6.**

**Traffic panel:**
- Request volume: stacked area — `success_count` (primary) + `error_count` (danger) per bucket
- Stream vs Sync: stacked area — `stream_count` + `sync_count` per bucket

**Performance panel:**
- Latency: multi-line — `avg_latency_ms` + `p95_latency_ms` + `p99_latency_ms` per bucket
- TTFT: multi-line — `avg_ttft_ms` + `p95_ttft_ms` per bucket
- Processing: area — `avg_processing_ms` per bucket

**Reliability panel:**
- Error rate %: area — `error_count / count * 100` per bucket, danger color when > 5%
- Status code distribution: stacked bar — `status_codes` record per bucket, one color per code

**Usage panel:**
- Token burn: stacked area — `input_tokens` + `output_tokens` per bucket
- Top models by tokens: horizontal bar from `/stats/breakdown?by=model&sort=total_tokens`

#### 3.3 Quick breakdowns row

Below charts, show top-5 horizontal bars for:
- Top Models (by count) — from `/stats/breakdown?by=model&limit=5`
- Top Clients (by count) — from `/stats/breakdown?by=client_name&limit=5`
- Top Strategies (by count) — from `/stats/breakdown?by=strategy&limit=5`

Each bar clickable → applies the dimension as a filter.

---

### Phase 4 — Frontend: Model Explorer

#### 4.1 Model ranking table

Replace current simple table with sortable columns. **All columns backed by breakdown response fields.**

| Column | Breakdown field |
|--------|----------------|
| Model | `key` |
| Requests | `count` |
| Input Tokens | `input_tokens` |
| Output Tokens | `output_tokens` |
| Total Tokens | `total_tokens` |
| Avg Latency | `avg_latency_ms` |
| P95 Latency | `p95_latency_ms` |
| Avg TTFT | `avg_ttft_ms` |
| Error Rate | `error_rate` |
| Last Seen | `last_seen` (formatted as relative time) |

Sort by any column. Respects global filters.
Data from: `/stats/breakdown?by=model&sort={column}&order={dir}&limit=50` + all active filters.

#### 4.2 Model comparison

Select 2-3 models → side-by-side comparison panel:
- Latency distribution: fetch `/stats/percentiles?metric=latency_ms&model=X` for each
- Token usage: grouped bar from each model's `input_tokens` / `output_tokens`
- Error rate comparison: bar chart of `error_rate`
- Timeseries overlay: `/stats/timeseries?model=X` for each, overlaid same chart

#### 4.3 Model detail drill-down

Click a model → navigate to `/models/[name]` or open drawer showing:
- Timeseries for that model only (from `/stats/timeseries?model=X`)
- Percentile stats (from `/stats/percentiles?metric=latency_ms&model=X`)
- Resolved model mapping (from `/stats/breakdown?by=resolved_model&model=X`)
- Related requests table (pre-filtered via `/requests?model=X`)

---

### Phase 5 — Frontend: Enhanced Request Table

#### 5.1 Column configuration

Default columns: Time, Model, Status, Latency, TTFT, Tokens, Stream, Path.

Toggleable columns: Strategy, Upstream, Account, Client, Session, Status Code, Processing Time, Stop Reason, Tool Calls, Routing Path, Translated Model, Error.

#### 5.2 Request detail drawer

Click a row → slide-out panel showing:
- Full request metadata (all DB fields including new ones)
- Timing breakdown waterfall (TTFT → Processing → Total Latency)
- Error message (if any)
- Copy request ID
- Link to live log (if still in buffer, by requestId)

#### 5.3 Bulk analytics

Above the table, show:
- Count badge: "Showing 50 of 1,234 matching requests"
- Aggregate stats for current filter: summary card row (avg latency, error rate, total tokens) from `/stats/summary?{current_filters}`

#### 5.4 Error aggregation view

Tab or toggle to group errors by `error_message` (truncated). Show count, last occurrence, affected models.

Implementation: client-side aggregation from the fetched request page, or a dedicated `/stats/breakdown?by=error_message` if needed (requires adding `error_message` as a supported `by` value — only for non-null error rows).

---

### Phase 6 — Frontend: Clients & Sessions

#### 6.1 Clients page (`/clients`)

New page showing:
- Client ranking table: columns map to breakdown fields (`key` → Name, `count`, `total_tokens`, `error_rate`, `last_seen`)
- Data from: `/stats/breakdown?by=client_name&sort=count&order=desc`
- Click a client → apply `client=X` filter, show filtered request table

#### 6.2 Sessions page (`/sessions`)

New page showing:
- Session ranking table: Session ID, Client, Account, Request Count, Duration, Tokens, Error Rate, Last Active
- Data from: `/stats/breakdown?by=session_id&sort=last_seen&order=desc&limit=50`
  - Duration = `last_seen - first_seen`
  - Client/Account: returned as formal `client_name` / `account_name` / `client_version` fields in `SessionBreakdownEntry` (see 1.7)
- Click a session → navigate to `/sessions/[id]` showing request timeline via `/requests?session=X&sort=timestamp&order=asc`

#### 6.3 Account breakdown

Visible as a breakdown panel or sub-page:
- Account ranking: Name, Requests, Tokens, Error Rate
- Data from: `/stats/breakdown?by=account_name`

---

### Phase 7 — Frontend: Live ↔ Historical Panel Unification

#### 7.1 Extract reusable analytics panels

Refactor `logs-stats.tsx` (~1094 lines) into composable panel components:

- `<RpmChart data={MinuteBucket[]} />` — works with live or historical source
- `<ModelDistribution data={BreakdownEntry[]} />` — pie/bar, any source
- `<TimingChart data={TimingPoint[]} />` — latency/ttft/processing lines
- `<ConcurrencyChart data={ConcurrencyBucket[]} />` — parallel sessions area
- `<SessionList data={SessionInfo[]} />` — active session cards

#### 7.2 Dual-source data hook

```ts
function useAnalyticsData<T>(config: {
  historicalFetcher: (filters: AnalyticsFilters) => Promise<T>;
  liveTransformer: (events: LogEvent[]) => T;
  mode: 'historical' | 'live' | 'auto';
}): { data: T; isLive: boolean; isLoading: boolean }
```

When `mode=auto`: use live if range is ≤15m and SSE connected, else historical.

#### 7.3 Live indicator

Show a pulsing dot + "LIVE" badge when panels are rendering from SSE. Show "Historical" badge with data range when from API.

---

### Phase 8 — Frontend: Provider & Strategy Analytics

#### 8.1 Strategy breakdown panel

On overview or dedicated `/strategies` page:
- Strategy distribution pie (copilot-native, copilot-translated, custom-openai, etc.)
- Per-strategy: avg latency, error rate, token usage, p95 latency
- Data from: `/stats/breakdown?by=strategy`

#### 8.2 Upstream provider health

For custom providers:
- Provider ranking: Name, Requests, Avg Latency, Error Rate, Upstream Status Distribution
- Data from: `/stats/breakdown?by=upstream`
- Upstream status distribution: `/stats/breakdown?by=status_code&upstream=X`

#### 8.3 Routing path distribution

- native vs translated pie/bar
- Data from: `/stats/breakdown?by=routing_path`

---

## Navigation Structure

```
Dashboard
├── Overview          (Phase 3 — Traffic + Perf + Reliability + Usage)
├── Models            (Phase 4 — Explorer + Compare + Drilldown)
├── Requests          (Phase 5 — Filtered table + Detail drawer)
├── Clients           (Phase 6 — Client & Session analytics)
├── Live              (Phase 7 — Real-time SSE panels, unified components)
├── Providers         (Phase 8 — Strategy + Upstream health)
├── Connect           (existing — API keys)
└── Settings          (existing)
```

---

## File Impact Summary

### Proxy (packages/proxy)

| File | Change |
|------|--------|
| `src/db/requests.ts` | Add 9 columns, migration, updated insert/query |
| `src/db/request-sink.ts` | Persist 9 new fields from event.data |
| `src/db/analytics-filters.ts` | **New** — shared filter parser + WHERE builder |
| `src/routes/stats.ts` | Rewrite: summary, timeseries, breakdown, percentiles (all filter-aware) |
| `src/routes/requests.ts` | Use shared filter parser, add sort columns |

### Dashboard (packages/dashboard)

| Category | New/Modified Files |
|----------|-------------------|
| Analytics Shell | `src/lib/analytics-filters.ts`, `src/components/analytics/filter-bar.tsx`, `time-range-picker.tsx`, `filter-chip.tsx` |
| Layout | `src/app/layout.tsx` or analytics layout wrapper |
| Overview | `src/app/page.tsx`, `src/app/overview-charts.tsx` → full rewrite |
| Models | `src/app/models/models-content.tsx` → enhance, `src/app/models/[name]/page.tsx` (new) |
| Requests | `src/app/requests/requests-content.tsx` → enhance, add detail drawer |
| Clients | `src/app/clients/page.tsx` (new), `clients-content.tsx` (new) |
| Sessions | `src/app/sessions/page.tsx` (new), `src/app/sessions/[id]/page.tsx` (new) |
| Providers | `src/app/providers/page.tsx` (new) |
| Live | `src/app/logs/logs-stats.tsx` → extract panels |
| Shared Charts | `src/components/analytics/panels/` (new directory with reusable panels) |
| Types | `src/lib/types.ts` — add new response types |

### Shared Types (to add to `types.ts`)

```ts
// Summary (replaces OverviewStats)
interface SummaryStats {
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

// Extended timeseries bucket
interface TimeseriesBucket {
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
  p95_latency_ms: number;
  p99_latency_ms: number;
  avg_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  avg_processing_ms: number | null;
  status_codes: Record<string, number>;
}

// Universal breakdown entry
interface BreakdownEntry {
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
}

// Percentiles
interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

// Shared filter contract (dashboard ↔ proxy)
interface AnalyticsFilters {
  range: string;
  from?: number;
  to?: number;
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
```

---

## Atomic Commit Plan

| # | Scope | Commit message prefix | Depends on |
|---|-------|----------------------|------------|
| 1 | Proxy | `feat(proxy): add analytics columns to requests table` | — |
| 2 | Proxy | `feat(proxy): persist extended fields in request-sink` | 1 |
| 3 | Proxy | `feat(proxy): add shared analytics filter parser and WHERE builder` | 1 |
| 4 | Proxy | `feat(proxy): extend /requests with full filter support` | 3 |
| 5 | Proxy | `feat(proxy): add filter-aware /stats/summary endpoint` | 3 |
| 6 | Proxy | `feat(proxy): extend /stats/timeseries with full bucket metrics and filters` | 3 |
| 7 | Proxy | `feat(proxy): add /stats/breakdown universal ranking endpoint` | 3 |
| 8 | Proxy | `feat(proxy): add /stats/percentiles endpoint` | 3 |
| 9 | Dashboard | `feat(dashboard): add analytics filter state and URL sync` | — |
| 10 | Dashboard | `feat(dashboard): add FilterBar and TimeRangePicker components` | 9 |
| 11 | Dashboard | `feat(dashboard): upgrade overview with categorized analytics panels` | 5, 6, 7, 8, 10 |
| 12 | Dashboard | `feat(dashboard): add model explorer with ranking, comparison, and drilldown` | 7, 8, 10 |
| 13 | Dashboard | `feat(dashboard): enhance request table with column config, detail drawer, error aggregation` | 4, 10 |
| 14 | Dashboard | `feat(dashboard): add clients and sessions pages` | 7, 10 |
| 15 | Dashboard | `feat(dashboard): extract reusable analytics panels from logs-stats` | 10 |
| 16 | Dashboard | `feat(dashboard): add dual-source data hook (live ↔ historical)` | 15 |
| 17 | Dashboard | `feat(dashboard): add provider and strategy analytics page` | 7, 10 |

**Parallelism:**
- Proxy commits 1-2 (DB) are sequential. Commits 3-8 (filter helper + endpoints) depend on 1 but are internally parallel.
- Dashboard commits 9-10 (shell) are independent of proxy and can be developed in parallel.
- Dashboard commits 11-17 depend on their respective backend endpoints + the filter shell (9-10).

---

## Testing Strategy

- **Proxy:** Unit tests for `analytics-filters.ts` (parser, WHERE builder, edge cases). Unit tests for each query function + filter combination. Integration tests for new endpoints via existing L2 framework.
- **Dashboard:** Component tests for new panels (Vitest + testing-library). E2E tests for filter interaction (Playwright).
- **Coverage:** Maintain ≥95% for new proxy code; ≥90% for dashboard components.

---

## Resolved Design Questions

1. **SQLite percentile accuracy** — Use exact JS computation for ≤50k rows (`SELECT metric FROM ... ORDER BY metric`), switch to `ntile(100)` approximation above that threshold.
2. **Timeseries 5-minute interval** — Add `5min` as a supported interval in the backend (SQL `ROUND(timestamp / 300000) * 300000`). Frontend auto-selects based on range.
3. **Navigation restructure** — Keep flat sidebar for now. Group into Analytics / Config once the page count grows beyond current plan.
4. **`toolCallNames` not persisted** — Variable-length string array with potentially sensitive data. Available in live SSE events only. If needed historically, add as a separate opt-in migration later.
5. **Session listing** — Use `/stats/breakdown?by=session_id` with `first_seen`/`last_seen` in the response, avoiding a separate sessions endpoint.
