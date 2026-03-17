# Changelog

## v1.1.0 (2026-03-17)

Session tracking, pretty terminal logs, and dashboard analytics polish.

### Proxy — features

- **Pretty terminal logs** — replaced raw JSON lines with colorized one-liner summaries (model, status, duration, TTFT, tokens), respects `NO_COLOR`
- **TTFT and processing time** — request handlers now capture time-to-first-token and processing duration in `request_end` events
- **Session tracking** — extract session identity (sessionId, clientName, clientVersion) from request headers via client identity parser, stored in new DB columns

### Dashboard — features

- **Session tracking UI** — logs sidebar shows live session info (client name, version, session ID) with stats panel
- **Sparkline trends** — StatCard now supports inline sparkline charts for trend visualization
- **Clickable timeline** — timeline nodes open phase detail on click
- **Model aggregation** — charts group low-traffic models into "Others" bucket for cleaner visualization

### Dashboard — UI improvements

- **Logs sidebar redesign** — restructured into 3 sections with timing breakdown (latency, TTFT, processing)
- **Skeleton loaders** — replaced empty loading states with skeleton placeholders for charts
- **Faster animations** — sped up all UI animations and transitions
- **Select component** — replaced native selects with shadcn Select across the app
- **Font consistency** — applied DM Sans font-display to all page headings

### Dashboard — refactoring

- **Design tokens** — extracted floating island radius, timeline colors, chart heights, and settings source badge styles into semantic design tokens
- **StatCard unification** — merged duplicate StatCard variants into single shared component
- **Chart utilities** — extracted `formatBucketTime` to shared `chart-config.ts`

### Bug fixes

- **Dedup request_end events** — fixed duplicate `request_end` events in stats hooks and concurrency timeline
- **Empty model filter** — filtered out empty model names from Select options

### Tests

- **451 proxy tests** (was 428) — added client identity unit tests, session tracking pure function tests, terminal-format tests

### Docs

- **Session tracking design doc** — added `docs/07-session-tracking.md`

## v1.0.0 (2026-03-16)

First stable release — version settings system, multi-platform local detection, dashboard polish, and brand unification to lowercase raven.

### Proxy — features

- **Settings persistence** — new `settings` SQLite table with key-value CRUD for version overrides
- **Local version detection** — auto-detect VS Code and Copilot Chat versions from local installations (VS Code, Cursor, Insiders, VSCodium) across macOS, Linux, and Windows
- **Dynamic Copilot version** — replaced hardcoded `COPILOT_VERSION = "0.26.7"` with `state.copilotChatVersion`, resolved at startup via priority chain: DB override → local detection → AUR fetch → fallback
- **Settings API** — `GET/PUT/DELETE /api/settings` with semver validation, effective value + source tracking, and live state update
- **Version source tracking** — state tracks whether each version came from override, local, aur, or fallback

### Dashboard — features

- **Settings page** — view effective versions with source badges (Override / Local / AUR / Fallback), input override values, save and reset controls with inline error feedback
- **Per-page tab titles** — Next.js metadata template `"%s — raven"` with unique titles per page (e.g. "Logs — raven", "Copilot Models — raven")
- **Copilot models table** — unified column widths across vendor tables via `table-fixed` layout with percentage-based columns

### Dashboard — UI improvements

- **Logs page** — redesigned with left-right split layout, card-based request cards with timeline visualization, real-time session stats panel, reverse chronological order, scroll-to-top FAB, copy button
- **Home page** — merged Overview and Requests into single page with stat cards + charts + embedded request log

### Bug fixes

- **Semver validation** — settings API rejects non-semver values with 400 to prevent corrupting upstream request headers
- **Error feedback** — settings save/reset shows inline error message on proxy 4xx/5xx or network failure
- **Copilot models table** — fixed duplicate React keys
- **TypeScript** — resolved strict type errors in settings-content component

### Brand & docs

- **Brand unification** — standardized to lowercase `raven` across metadata titles, sidebar, docs
- **README rewrite** — updated per project standards: lowercase brand, 404 test count, full docs index, new features documented
- **docs/README.md** — added entries for docs 02–06

## v0.3.0 (2026-03-16)

Major infrastructure release — complete proxy rewrite, real-time logging system, API key management, and dashboard test suite from zero to 145 tests with 5 bug fixes.

### Proxy — rewrite

- **Full proxy rewrite** — rebuilt from copilot-api reference into clean Hono architecture with DI, request sinks, and structured routes
- **Structured logging** — `LogEmitter` event bus with ring buffer, WebSocket `/ws/logs` endpoint with auth and backfill, terminal JSON sink, and DB sink for request persistence
- **Request instrumentation** — all routes emit structured log events (`request_start`, `request_end`, `sse_chunk`, `upstream_error`) with ULID `requestId` linking
- **SSE improvements** — unified SSE module replacing fetch-event-stream, keepalive heartbeat to prevent idle timeout disconnects, error events forwarded to client on upstream failure
- **Token refresh** — rewritten as retry chain with exponential backoff (capped at MAX_BACKOFF_MS), injected timer factory for testability

### Proxy — bug fixes

- **Copilot token refresh** — added exponential backoff to prevent hammering upstream on transient failures
- **Upstream stream failure** — now sends error events to client instead of silently dropping
- **ALLOWED_EMAILS trap** — prevented silent rejection of all logins when env var is malformed
- **Backward pagination** — enabled cursor-based backward navigation in timestamp sort mode
- **Model deduplication** — deduplicate model IDs in connection-info response
- **Route mount paths** — corrected to match copilot-api conventions
- **useLogStream** — fixed stale paused closure and duplicate reconnect on both "disconnected" and "error" events

### Dashboard — features

- **Real-time log viewer** — `/logs` page with live SSE stream, level filtering, pause/resume, request ID isolation
- **SSE bridge route** — `/api/logs/stream` bridges upstream WebSocket to SSE for browser consumption
- **Connect page** — API key management dashboard with create/revoke/delete flows, connection info, code examples
- **API key management routes** — full CRUD: GET/POST `/api/keys`, DELETE `/api/keys/[id]`, POST `/api/keys/[id]/revoke`
- **Multi-key auth middleware** — replaced single-key auth with DB-backed multi-key system
- **Key-based attribution** — requests tagged with the API key used for authentication
- **Sidebar redesign** — collapsible nav groups for better organization

### Dashboard — bug fixes

- **handleAction error handling** — API key revoke/delete now catches fetch failures and shows error feedback (was unhandled)
- **Error message format** — CreateKeyDialog now handles both `{ error: "string" }` and `{ error: { message: "string" } }` response formats
- **handleRefresh error handling** — AccountContent and CopilotModelsContent now catch fetch failures and show error feedback (was silently swallowed in `finally`)
- **Clipboard writeText** — CopyButton (shared and inline) now handles `navigator.clipboard.writeText` rejection gracefully

### Tests

- **Proxy** — 403 unit tests (was 184), pushed all source files to 95%+ line coverage; added tests for GitHub services, poll-access-token, token.ts lifecycle, keepalive, paths, connection-info, and VSCode version
- **Dashboard** — 145 tests across 11 files (was 0); covers lib/proxy, all BFF routes, SSE bridge, useLogStream hook, 3 component interaction suites, proxy auth enforcement, and NextAuth config/signIn callback
- **Test infrastructure** — Vitest with node default environment, jsdom opt-in for component tests, vi.resetModules + vi.stubEnv pattern for env-dependent modules

## v0.2.2 (2026-03-15)

Copilot API parity — closed functional gaps against the copilot-api reference project so the proxy works end-to-end with Claude Code, Cursor, and Continue.

### Proxy — bug fixes

- **tool_choice "none"** — was silently mapped to "auto", causing models to invoke tools when they shouldn't
- **Empty choices crash** — Copilot returns `choices: []` for `tool_choice: "none"` with tools; `translateResponse` now handles this gracefully
- **content_filter finish_reason** — now maps to `end_turn` instead of `null`
- **Streaming usage incomplete** — `message_delta` now includes `input_tokens` and `cache_read_input_tokens`, not just `output_tokens`

### Proxy — new features

- **Vision header** — auto-detects `image_url` content parts and sets `copilot-vision-request: true` header for screenshot analysis
- **X-Initiator header** — detects agent conversations (assistant/tool roles) and sets `x-initiator: agent` for correct rate-limit tier
- **max_tokens auto-fill** — defaults to 16384 when clients omit `max_tokens` on the OpenAI route
- **`/v1/messages/count_tokens`** — character-based token estimation with Claude correction factor (×1.15), tool overhead (+346), MCP detection; zero new dependencies
- **`/v1/embeddings`** — forwards to Copilot embeddings API
- **No-prefix routes** — `/chat/completions` and `/embeddings` aliases for backward compatibility
- **Dynamic model list** — `/v1/models` now fetches from upstream Copilot API with caching, instead of a hardcoded list

### Tests

- 184 unit tests passing (was 182)
- 9 E2E tests across 4 orthogonal layers: protocol conformance, streaming translation, feature parity, regression guard

### Dashboard

- **Recharts hydration fix** — resolved SSR/CSR mismatch

## v0.2.1 (2026-03-15)

Copilot upstream visibility — fetch real model list and subscription info from GitHub APIs, display in two new dashboard pages.

### Proxy

- **Copilot models endpoint** — `GET /api/copilot/models` fetches available models from `api.githubcopilot.com/models`, cached in memory with `?refresh=true` support
- **Copilot user endpoint** — `GET /api/copilot/user` fetches subscription/entitlement info from `api.github.com/copilot_internal/user`, same caching strategy
- **CopilotClient.fetchModels()** — new method on the client interface for upstream model discovery

### Dashboard

- **Copilot Models page** — table grouped by vendor (Anthropic, Azure OpenAI, Google, OpenAI), sorted by max prompt tokens descending, inline copy-to-clipboard on model IDs
- **Copilot Account page** — subscription overview cards, SVG circular progress rings for quota (percentage center label, ∞ icon for unlimited), feature toggles list, endpoints table, catch-all for unknown API fields with JSON pretty-print
- **Sidebar** — added Copilot Models and Account navigation items

## v0.2.0 (2026-03-15)

First feature-complete release — proxy + dashboard MVP.

### Proxy

- **GitHub Copilot auth** — Device flow login with token persistence, dual-layer token manager (GitHub OAuth + Copilot JWT) with auto-refresh
- **Anthropic ↔ OpenAI translation** — Full request/response translation between Anthropic and OpenAI formats, streaming state machine for SSE
- **API endpoints** — `POST /v1/messages` (Anthropic), `POST /v1/chat/completions` (OpenAI), `GET /v1/models`
- **Request logging** — SQLite-backed request log with stats queries (overview, timeseries, models, recent)
- **Stats & query API** — `GET /api/stats/*` and `GET /api/requests` with filtering, sorting, cursor/offset pagination
- **Security** — API key auth middleware with timing-safe comparison

### Dashboard

- **Design system** — Basalt design system with Raven slate-blue theme, 3-tier luminance, 24-color chart palette
- **Layout** — Collapsible sidebar, floating island content area, dark mode with FOUC prevention, mobile responsive
- **Overview page** — Stat cards (requests, tokens, latency, error rate) + area/bar/line charts
- **Request log page** — Sortable table with model/status/format filters, cursor and offset pagination
- **Model stats page** — Pie chart (request distribution), bar chart (token consumption), detail table
- **Error handling** — Explicit error state UI instead of silent zero-data fallback
- **Dynamic filters** — Model filter list fetched from proxy at runtime
- **Server components** — AppShell refactored to minimize client boundary hydration cost

### Infrastructure

- Bun workspace monorepo (`packages/proxy` + `packages/dashboard`)
- Husky pre-commit (tests) and pre-push (tests + perf + lint + typecheck) hooks
- ESLint strict + Prettier
- 187 proxy tests passing
