# Session Tracking — Design Doc

## Overview

The Logs page currently shows aggregate stats (requests, error rate, latency, tokens) but cannot distinguish parallel client sessions. When multiple IDE windows hit the proxy simultaneously, requests interleave in the log stream with no way to tell how many parallel processes are active, which client each belongs to, or per-session health.

The proxy already receives strong session identification signals in every request — it just discards them:

| Signal | Source | Precision |
|--------|--------|-----------|
| `metadata.user_id` | Anthropic request body | Exact — Claude Code sends a unique UUID per session |
| `user` | OpenAI request body | Heuristic — generic optional field (`ChatCompletionsPayload.user?: string \| null`), no per-session uniqueness contract. Clients may set it to a fixed user ID, leave it empty, or omit entirely. Useful as a grouping hint but must not be treated as a reliable session boundary |
| `User-Agent` header | HTTP header | Client type — `claude-code/1.2.3`, `cursor/0.5`, etc. |

**Goal:** Extract these signals in the proxy, surface them in log events and DB, and add dashboard UI for at-a-glance parallel session monitoring.

---

## 1. Client Identity Parsing

### New file: `packages/proxy/src/util/client-identity.ts`

```typescript
export interface ClientIdentity {
  sessionId: string        // composite session key
  clientName: string       // "Claude Code", "Cursor", "Unknown", etc.
  clientVersion: string | null
}
```

#### `parseUserAgent(ua: string | undefined)`

Match known UA patterns, extract name + version:

| Pattern prefix | clientName |
|----------------|------------|
| `claude-code/` | Claude Code |
| `cursor/` | Cursor |
| `continue/` | Continue |
| `windsurf/` | Windsurf |
| `aider/` | Aider |
| `cline/` | Cline |
| `anthropic-python/` | Anthropic Python SDK |
| `anthropic-typescript/` | Anthropic TS SDK |
| `openai-python/` | OpenAI Python SDK |
| `openai-node/` | OpenAI Node SDK |

Fallback: first token before space, or `"Unknown"`.

#### `deriveClientIdentity(anthropicUserId, userAgent, accountName, openaiUser?)`

Session ID derivation priority:

1. **`anthropicUserId` present** (Anthropic `metadata.user_id`) → use directly (most precise — Claude Code sends unique per-session UUID)
2. **`openaiUser` present** (OpenAI `payload.user`) → use as heuristic hint, but combine with UA to reduce false merges: `"{openaiUser}::{clientName}"`
3. **Fallback** → `"{clientName}::{accountName}"` (cannot distinguish two windows of same client + same key, acceptable tradeoff)

---

## 2. Handler Changes — Extract and Emit

Three new fields added to `data` bag of `request_start` and `request_end` events:

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Composite session identifier |
| `clientName` | `string` | Human-readable client name |
| `clientVersion` | `string \| null` | Client version or null |

No change to `LogEvent` interface itself — these go into the existing `data?: Record<string, unknown>` bag.

### Modified files (4 handlers)

#### `routes/messages/handler.ts` (Anthropic format, 4 emitLog calls)

After L37 (`const accountName = ...`):

```typescript
const userAgent = c.req.header("user-agent")
const userId = anthropicPayload.metadata?.user_id
const identity = deriveClientIdentity(userId, userAgent, accountName)
```

Add `sessionId, clientName, clientVersion` to `data` in:
- L40 `request_start`
- L63 `request_end` (non-stream success)
- L132 `request_end` (stream finally)
- L158 `request_end` (catch error)

Not modified: L153 `upstream_error` (diagnostic event, not session-relevant).

#### `routes/chat-completions/handler.ts` (OpenAI format, 4 emitLog calls)

After L26 (`const accountName = ...`):

```typescript
const userAgent = c.req.header("user-agent")
const openaiUser = payload.user ?? undefined
const identity = deriveClientIdentity(undefined, userAgent, accountName, openaiUser)
```

Add to `data` in: L29 `request_start`, L65 `request_end`, L124 `request_end`, L150 `request_end`.

Not modified: L145 `upstream_error`.

#### `routes/embeddings/route.ts` (3 emitLog calls)

After L16 (`const accountName = ...`):

```typescript
const userAgent = c.req.header("user-agent")
const identity = deriveClientIdentity(undefined, userAgent, accountName)
```

Embeddings has no `user` / `user_id` field — always uses UA fallback.

Add to: L22 `request_start`, L31 `request_end`, L46 `request_end`.

#### `routes/models/route.ts` (3 emitLog calls)

Models is a GET with no body. Currently missing `accountName` in log events — add it too.

After L13 (`const requestId = ...`):

```typescript
const accountName = c.get("keyName") ?? "default"
const userAgent = c.req.header("user-agent")
const identity = deriveClientIdentity(undefined, userAgent, accountName)
```

Add `sessionId, clientName, clientVersion, accountName` to: L16 `request_start`, L39 `request_end`, L58 `request_end`.

---

## 3. DB Schema Extension

### Modified file: `packages/proxy/src/db/requests.ts`

Safe migration in `initDatabase()` (wrap each ALTER in try/catch for duplicate column):

```sql
ALTER TABLE requests ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN client_name TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN client_version TEXT;
CREATE INDEX IF NOT EXISTS idx_requests_session_id ON requests(session_id);
```

Update `RequestRecord` type, `INSERT_SQL`, and `insertRequest` binding to include three new columns.

### Modified file: `packages/proxy/src/db/request-sink.ts`

Extract from `event.data`:

```typescript
session_id:     (d.sessionId as string) ?? "",
client_name:    (d.clientName as string) ?? "",
client_version: (d.clientVersion as string) ?? null,
```

---

## 4. Dashboard — Session Tracking UI

### 4.1 Data Flow

```
useLogStream hook (events[])
        │
        ▼
  dedup + sort layer           ← dedup by (requestId, type), sort by ts
        │
        ▼
  useSessionTracker(events)     ← processes request_start + request_end
        │
        ├─ sessions: SessionInfo[]
        ├─ activeSessions: SessionInfo[]   (activeRequests.size > 0)
        ├─ activeCount: number
        └─ totalActiveRequests: number

  useConcurrencyTimeline(events) ← builds minute buckets of distinct active sessions
        │
        └─ ConcurrencyPoint[]
```

#### Reconnect replay dedup

`/ws/logs` pushes the ring buffer backfill on every new connection (`ws/logs.ts:34`). The SSE bridge reconnects with exponential backoff (`use-log-stream.ts:150`) and appends all received events (`use-log-stream.ts:124`). This means a single event can appear multiple times in `events[]` after reconnection, and chronological order is not guaranteed.

Both `useSessionTracker` and `useConcurrencyTimeline` must apply a dedup pass before processing:

```typescript
function dedupEvents(events: LogEvent[]): LogEvent[] {
  const seen = new Set<string>()
  const result: LogEvent[] = []
  for (const e of events) {
    if (!e.requestId) { result.push(e); continue }
    const key = `${e.requestId}:${e.type}`  // e.g. "01J5X...:request_start"
    if (seen.has(key)) continue
    seen.add(key)
    result.push(e)
  }
  return result.sort((a, b) => a.ts - b.ts)
}
```

Key: `requestId + type` — a given requestId has exactly one `request_start` and one `request_end`. Events without `requestId` (e.g. `system`) pass through unfiltered.

### 4.2 Core Types

```typescript
interface SessionInfo {
  sessionId: string
  clientName: string
  clientVersion: string | null
  accountName: string
  activeRequests: Set<string>   // currently in-flight requestIds
  totalRequests: number
  errorCount: number
  totalTokens: number
  lastActiveTs: number
  firstSeenTs: number
}

interface ConcurrencyPoint {
  minute: number    // timestamp bucketed to minute
  sessions: number  // distinct sessions active in that minute
}
```

### 4.3 `useSessionTracker(events)` Logic

1. Apply `dedupEvents(events)` to eliminate reconnect replay duplicates
2. Iterate deduped events chronologically:

- `request_start` → add `requestId` to session's `activeRequests` set (creates session if new)
- `request_end` → remove from `activeRequests`, increment `totalRequests`, accumulate `errorCount` and `totalTokens`
- Fall back to `"unknown"` session when `sessionId` missing (backward compat with old events)

### 4.4 `useConcurrencyTimeline(events)` Logic

1. Apply `dedupEvents(events)` (same dedup layer as session tracker)
2. Build request intervals: `requestId → { sessionId, startTs, endTs }`
3. For each interval, mark the session active in every minute bucket it spans
4. Count distinct sessions per bucket, return last 30 buckets

**Degradation when `request_start` is missing** (evicted from ring buffer before reconnect): The interval cannot be constructed for that requestId — the `request_end` alone has no start timestamp. These requests are silently omitted from the timeline chart. This is an intentional low-estimate: the concurrency chart may undercount during long-running requests that span a reconnection, but completed session stats from `useSessionTracker` remain correct (they only need `request_end` data).

### 4.5 UI Components

Added below existing charts in the 340px sidebar (`logs-stats.tsx`).

**Visibility gate:** The existing aggregate stats section uses `hasData = stats.total > 0` (i.e. at least one `request_end`). The session section must NOT share this gate — its purpose is to show in-progress activity before any request completes. Session section is visible when `sessionTracker.sessions.length > 0` (i.e. at least one `request_start` has been seen), independent of `hasData`.

```
┌─────────── 340px sidebar ───────────┐
│ [existing] 4× StatCard (2×2)        │
│ [existing] Requests/min  AreaChart  │  ← gated by hasData
│ [existing] Models        BarChart   │  ← gated by hasData
│ [existing] Latency       LineChart  │  ← gated by hasData
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
│ [new] Active Sessions   StatCard    │  ← gated by hasSessionData (independent)
│ [new] Parallel Sessions AreaChart   │  ← gated by hasSessionData
│ [new] Session List                  │  ← gated by hasSessionData
└─────────────────────────────────────┘
```

```typescript
const hasData = stats.total > 0;                          // existing
const hasSessionData = sessionTracker.sessions.length > 0; // new, independent gate
```

#### StatCard: Active Sessions

| Prop | Value |
|------|-------|
| icon | `Users` (lucide) |
| label | `"Active Sessions"` |
| value | `activeCount` |
| detail | `"N in-flight"` (when active) |
| accent | `>3` → warning, `>0` → success, `0` → default |

Full-width single card, visually separates session section from aggregate section.

#### Chart: Parallel Sessions / min

- `AreaChart` with `type="stepAfter"` — concurrency is discrete, not smooth
- Height: `CHART_HEIGHTS.compact` (140px)
- Color: `getChartColor(2)` (teal)
- X axis: `HH:MM`, Y axis: integer session count
- Last 30 minutes with data

#### Session List

- Container: `bg-secondary rounded-lg p-3`, max-h `200px` with `overflow-y-auto`
- Each row:
  - Green/gray dot (active vs idle)
  - Client name + version
  - Stats line: `N req · Xk tok · Y% err`
  - Active badge: `"N active"` when in-flight
  - Account badge (when not `"default"` or `"dev"`)
- Active sessions highlighted: `bg-success/5 border border-success/20`

### 4.6 Mobile Adaptation

In the mobile collapsible panel, add session section below existing charts. Collapsed summary expands to: `"N req · Xs avg · Yk tok · M sessions"`.

---

## 5. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Reconnect replay (ring buffer backfill) | `dedupEvents()` filters duplicates by `requestId:type` key and re-sorts by `ts`. Without this, counters inflate and timeline distorts |
| Old events without `sessionId` | Cluster into `"unknown"` session — harmless |
| `request_start` outside ring buffer (only `request_end` arrives) | Session tracker: session created from `request_end` data, completed stats correct, but `activeRequests` tracking misses the in-progress window. Concurrency timeline: request silently omitted (intentional low-estimate — no `startTs` available to construct interval) |
| Orphaned `request_start` (stream hangs, no `request_end`) | Session shows "1 active" indefinitely — correct behavior, indicates stuck request. Clears on log stream clear |
| Two windows same client + same key (no `user_id`) | Merge into one session via fallback `"{clientName}::{accountName}"` — acceptable tradeoff |
| OpenAI `user` field set to fixed value across sessions | Combined with clientName: `"{user}::{clientName}"` reduces false merge vs using `user` alone, but may still group multiple sessions if client sets identical `user` + same UA. Acceptable — it's a heuristic signal, not a session boundary |
| Performance (500 max events) | `dedupEvents` is O(n) with Set lookup. Same `useMemo` + iterate pattern as existing hooks; negligible overhead |

---

## 6. Type Sync

`RequestRecord` in `packages/dashboard/src/lib/types.ts:27` mirrors the proxy DB schema. Add:

```typescript
export interface RequestRecord {
  // ...existing fields...
  session_id: string;
  client_name: string;
  client_version: string | null;
}
```

---

## 7. Tests

### Proxy: `packages/proxy/src/__tests__/client-identity.test.ts`

| Test | Input | Expected |
|------|-------|----------|
| Parse Claude Code UA | `"claude-code/1.2.3"` | `{ name: "Claude Code", version: "1.2.3" }` |
| Parse Cursor UA | `"cursor/0.5.0 ..."` | `{ name: "Cursor", version: "0.5.0" }` |
| Parse undefined UA | `undefined` | `{ name: "Unknown", version: null }` |
| Parse unknown UA | `"my-custom-client/2.0"` | `{ name: "my-custom-client", version: null }` (first token) |
| userId takes priority | `deriveSessionId("uuid-123", "claude-code/1.0", "dev")` | `"uuid-123"` |
| OpenAI user heuristic | `deriveSessionId(undefined, "cursor/0.5", "dev", "user-42")` | `"user-42::Cursor"` |
| Fallback composite | `deriveSessionId(undefined, "claude-code/1.0", "dev")` | `"Claude Code::dev"` |
| All undefined | `deriveSessionId(undefined, undefined, "dev")` | `"Unknown::dev"` |

### Dashboard: `packages/dashboard/src/__tests__/session-hooks.test.ts`

Pure logic tests for `dedupEvents`, `useSessionTracker`, `useConcurrencyTimeline`:

| Test group | Cases |
|------------|-------|
| **dedupEvents** | Removes duplicate `request_start` with same requestId; removes duplicate `request_end` with same requestId; preserves events without requestId; re-sorts by ts after dedup |
| **useSessionTracker** | Counts distinct sessions from `request_start` events; tracks in-progress requests (start adds, end removes); accumulates totalRequests/errorCount/totalTokens from `request_end`; handles missing `request_start` (only `request_end` arrives); handles missing `request_end` (orphaned in-progress); multiple concurrent requests within same session; backward compat with events lacking `sessionId` |
| **useConcurrencyTimeline** | Single session produces 1 in each spanned minute bucket; two overlapping sessions produce 2 in overlap minute; skips requests with only `request_end` (no interval); handles empty events array; last 30 buckets limit |

---

## 8. Atomic Commits

| # | Message | Files |
|---|---------|-------|
| 1 | `feat: add client identity parsing utility` | `proxy/src/util/client-identity.ts` |
| 2 | `test: add client identity unit tests` | `proxy/src/__tests__/client-identity.test.ts` |
| 3 | `feat: extract session identity in request handlers` | `proxy/src/routes/messages/handler.ts`, `proxy/src/routes/chat-completions/handler.ts`, `proxy/src/routes/embeddings/route.ts`, `proxy/src/routes/models/route.ts` |
| 4 | `feat: add session tracking columns to DB` | `proxy/src/db/requests.ts`, `proxy/src/db/request-sink.ts` |
| 5 | `feat: sync RequestRecord type with new DB columns` | `dashboard/src/lib/types.ts` |
| 6 | `feat: add session tracking hooks to logs sidebar` | `dashboard/src/app/logs/logs-stats.tsx` |
| 7 | `test: add session hooks unit tests` | `dashboard/src/__tests__/session-hooks.test.ts` |

---

## 9. Verification

1. `bun run test` — client-identity + session-hooks unit tests pass, existing tests unbroken
2. Start proxy (`bun run dev`) → send requests from Claude Code / other client
3. WebSocket monitor: confirm `request_start`/`request_end` events contain `sessionId`, `clientName`, `clientVersion`
4. Dashboard `/logs` page: Active Sessions card appears on first `request_start` (before any `request_end`), concurrency chart updates, session list shows per-client details
5. Reconnect test: pause dashboard → send requests → resume → verify no inflated counts (dedup working)
6. Multi-window test: send requests from 2+ IDE windows simultaneously → confirmed as distinct sessions
7. SQLite: `SELECT session_id, client_name, count(*) FROM requests GROUP BY 1, 2` — verify data persisted
