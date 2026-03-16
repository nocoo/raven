# Changelog

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
