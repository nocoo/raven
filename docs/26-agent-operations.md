# 26 · 代理分层、日志与运维约定

Daily commands, test targets and 6DQ status live in the root [AGENTS.md](../AGENTS.md). Legacy E2E tests against the daily database do not qualify as isolated 6DQ evidence; live upstream diagnostics require explicit task authorization.

The reusable [live Proxy acceptance matrix](29-live-proxy-acceptance.md) covers
default-rule Chat/Messages/Responses calls for Gemini, Grok, GPT and `auto`.
`bun run test:live` only lists cases; `--preflight` checks the existing key, rule
and model cache; `--execute` requires live-test authorization and sends each case
once with private persisted evidence. The runner stops on failure and supports
explicit case selection for separately authorized reruns.

## 分层与本机数据


Bun workspace monorepo: `packages/proxy` (Hono, port 7024) + `packages/dashboard` (Next.js 16, port 7023).

### Proxy layering (see `docs/20-architecture-refactor.md` for the full contract)

Seven layers, top → bottom. Each layer imports only from the layers below (enforced by `dependency-cruiser.config.cjs`):

1. **`routes/`** — HTTP entry points (Hono handlers). Owns request parsing, logging start, and composition dispatch. Must not import `strategies/` or `upstream/` directly.
2. **`composition/`** — the **sole bridge** between `routes/`, `strategies/`, and `upstream/`. `dispatch()` resolves the authenticated key's rule, captures one routing decision, injects the chosen client and usage observer, and drives the Runner.
3. **`core/`** — abstract `Strategy`/`Runner`/router contracts + `RequestContext`. Concretion-free: never imports `strategies/` or `upstream/`.
4. **`strategies/`** — seven established factories plus `makeProtocolConverted(deps)`, implementing the `Strategy` interface (`prepare` / `dispatch` / `adaptJson` / `initStreamState` / `adaptChunk` / optional `finalizeStream` / `adaptStreamError` / `describeEndLog`). Per-strategy files (`strategies/*.ts`) read no `infra/state` — deps are injected. `strategies/support/` holds cross-strategy helpers (server-tool `decorate()`, effort-fallback, capability gates).
5. **`protocols/`** — pure translation zone (Anthropic ↔ OpenAI, SSE adapters, preprocess). No state, no logging, no Hono streaming.
6. **`upstream/`** — upstream HTTP clients (Copilot native, Copilot OpenAI, custom providers) registered via `composition/upstream-registry.ts`.
7. **`infra/` + `lib/` + `util/`** — state, auth, rate-limit, logging primitives, IDs.

**Registered strategies** (all registered in `composition/strategy-registry.ts`):
- `copilot-openai-direct` — `/v1/chat/completions` to Copilot
- `copilot-chat-via-responses` — `/v1/chat/completions` → Copilot `/responses` (responses-only models)
- `copilot-translated` — `/v1/messages` Anthropic → Copilot OpenAI
- `copilot-native` — `/v1/messages` to Copilot native endpoint (claude-* models)
- `copilot-responses` — `/v1/responses` to Copilot
- `custom-openai` — user-configured OpenAI-compatible providers
- `custom-anthropic` — user-configured Anthropic providers
- `protocol-converted` — Messages → Responses, Chat → Messages, custom Chat → Responses, Responses → Chat/Messages and custom native Responses. Pure adapters own conversion; the injected client owns HTTP.

**Server-tool interception** (Tavily `web_search`) runs via `strategies/support/server-tools.ts::decorate()`, which wraps `withServerToolInterception` + `request_end` log + JSON/SSE replay. Both translated and native paths share it.

Copilot native Messages normalizes enabled thinking to adaptive thinking when
the cached model supports it. For the exact model `claude-opus-5.5`, a request
with `thinking.type: disabled` also becomes adaptive thinking: Copilot rejects
disabled thinking for this model. The default effort is `low`; an explicit
`output_config.effort` is retained when supported. This enables low-effort
thinking rather than disabling it. Other models keep disabled thinking unchanged,
and omitted or already-adaptive thinking is not rewritten. This normalization
does not retry requests or rename models.

## Key-bound routing and accounting

[R3](28-key-bound-routing.md) is the current routing contract. Every database key
has a required rule foreign key; environment client credentials use the protected
Copilot rule. The transactional migration preserves existing key identities and
secrets, enables conversion for the Copilot rule, and initializes its `auto` model
to `gpt-5.6-sol`. New rules default to conversion off.

Admission selects a UTC period or the visible default chain, then the first
candidate with available quota. Only known exhaustion advances the chain; an
eligible disabled/missing target, unhealthy enabled quota, protocol mismatch or
upstream failure ends the request. Copilot is a protected upstream, with no
implicit fallback. Explicit incoming model IDs follow the selected upstream and
remain unchanged for custom providers; `auto` uses the configured candidate ID.

Composition captures the provider configuration, model, admission time, quota
window and multiplier once. The same capture and a monotonically increasing
attempt ordinal span server-tool rounds and existing same-provider retries.
`composition/usage-observer.ts` observes the actual HTTP response before protocol
translation. Chat clients explicitly request streaming usage. The observer handles
JSON errors even when a stream was requested, and recognizes semantic SSE completion before reader
cancellation. Missing token buckets remain distinguishable from explicit zero.

SQLite settles weighted usage atomically and deduplicates request/attempt IDs.
Failed writes retain their original capture in process and emit a correlated
operational error without replacing the generation result. Before reading each
reached upstream's quota, composition retries its pending writes once. Quota OFF
still attempts recovery but does not block admission on the accounting latch.
This is approximate accounting; the in-process latch is not a durable outbox.

Custom catalogs refresh only through explicit POST actions. Copilot restores its
durable catalog at startup and refreshes independently on an hourly timer. Key
authentication, model/Connect reads and configuration saves never fetch catalogs.
Discovery accepts `data[].id` and `models[].slug`, retaining raw IDs and metadata.
Malformed catalogs fail as a whole and preserve the last successful snapshot.
`/v1/models` returns exact-ID-deduplicated cached/manual models plus `auto`, using
Copilot metadata when IDs collide. Explicit diagnostics make at most one native
generation attempt and consume the same upstream quota.

Requests persist `routing.resolved_model` for the admitted/sent model, alongside
the rule, upstream, quota and skipped exhausted candidates. The existing flat
`resolvedModel` continues to describe the upstream's echoed model; `model` keeps
the incoming client value. These fields can legitimately differ.

## Runtime baseline

Use the Node.js 26 release pinned in [.node-version](../.node-version) and Bun
1.3.11 or newer. The pinned reusable CI action reads this file for all three jobs.
Proxy and scripts run on Bun; Dashboard and its jsdom/V8 tests run on Node.

As of 2026-09-22, the [official schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
places Node 24 in Active LTS and schedules Node 26 LTS for 2026-10-28. Node 26
remains in the Current phase. Raven's CI already defaulted to 26.8.1; the explicit
pin aligns it with the fully verified local 26.9.0 runtime. Installed Next 16.3.5, Vitest
5.0.1, jsdom 30.1.0 and Vite 8.3.0 all support Node 26. Full package suites,
coverage gates, production builds and isolated browser acceptance passed on this
baseline. The [release index](https://nodejs.org/dist/index.json) lists 26.10.0
as the latest Current release; this project pins the version actually verified.

## Isolated Routing browser acceptance

Use the runtime baseline above. Install Chromium using the repository's existing
Playwright dependency, then run from the root after building the production
Dashboard:

```sh
GOOGLE_CLIENT_ID='' GOOGLE_CLIENT_SECRET='' NEXTAUTH_SECRET='' NEXT_TELEMETRY_DISABLED=1 \
  RAVEN_PROXY_URL='http://127.0.0.1:1' RAVEN_INTERNAL_KEY='fixture-internal' \
  RAVEN_API_KEY='fixture-client' bun run build
bun run scripts/verify-routing-ui.ts
```

The runner creates a private per-run directory, real SQLite, synthetic keys, a
local HTTP fixture upstream, an isolated Proxy and a production Next server on
random loopback ports. The isolated Proxy also serves the shared Logs WebSocket
handler with a synthetic internal key, exercising the real BFF SSE bridge.
It exercises real BFF/HTTP requests, schedule edits,
drag/keyboard reordering, Connect bindings, catalog/test actions, conflict
feedback and responsive layouts. Checkpoints also cover initial/switched
tab indicators, configuration-header alignment, draft navigation, unexpected or
empty diagnostic replies, redacted JSON/HTML discovery errors, retention choices,
and live-log protocol badges and card surfaces. The Next
server runs in UTC while Chrome uses Asia/Shanghai to expose hydration mismatches.
External model/browser requests are blocked.
Runtime state and owned processes are removed; screenshots, logs and `report.json`
remain in the printed temporary artifact directory. This verifies the Routing
workflows, not every application endpoint or the repository-wide L2/L3/D1 target.

Configuration drafts appear in the page directory before their first save.
Save/Discard apply to the whole configuration. Upstreams use separate cards for
connection, catalog, manual IDs, testing and quota; advanced connection settings
start collapsed. Success and failure feedback appears below its operation within
the same card. Rule saves retain the transient toast. Diagnostic/error banners
retain copyable response evidence. Timetables,
quota reset previews, request timestamps and analytics labels display browser-local
time; stored timestamps and routing calculations remain UTC. Server-rendered
timestamps, including Connect key dates and account assignment dates, wait for
hydration before displaying local time.

## Request history retention

Settings → General offers 7, 14, 30, 60 or 90 days of request history (default 30).
The `history_retention_days` setting accepts only those values. Each Proxy process
checks hourly from startup, reading the current setting on each cycle; changing
the setting does not trigger immediate deletion. A day is exactly 24 hours, and
only rows strictly older than the cutoff are deleted. Monitor statistics therefore
cover retained history, not lifetime totals.

On the first startup with this feature, a transactional, one-time migration
removes request rows older than 90 days and records completion in settings. This
also applies to existing 3.0 installations. The selected/default policy first runs
one hour later. A failed cleanup is logged and retried next hour without disabling
the proxy; an invalid stored policy prevents scheduled deletion rather than
silently selecting a shorter retention period.

Deletion is permanent without a separate backup. Keys, providers, routing rules,
settings and quota accounting are not deleted. SQLite reuses freed pages; this
does not impose a byte-size cap or immediately shrink the database file, and no
blocking VACUUM is scheduled.

## Data Directory Structure

Runtime data is stored in platform-standard user directories, not in the source tree:

**macOS:**
- Config: `~/Library/Application Support/raven/`
  - `github_token` (0600 permissions)
- Data: `~/Library/Application Support/raven/`
  - `raven.db` (SQLite database)

**Linux:**
- Config: `~/.config/raven/`
  - `github_token` (0600 permissions)
- Data: `~/.local/share/raven/`
  - `raven.db` (SQLite database)

**Environment overrides:**
- `RAVEN_CONFIG_DIR` — override config directory
- `RAVEN_DATA_DIR` — override data directory
- `RAVEN_TOKEN_PATH` — override token file path
- `RAVEN_DB_PATH` — override database path

**Migration:** Legacy `./data/` files are automatically migrated to new locations on first run.


## 实时日志


The proxy has a built-in structured logging system with real-time WebSocket streaming. No third-party logging library — fully custom, based on `EventEmitter` + ring buffer.

### Observing live logs

Connect to the WebSocket endpoint while the proxy is running:

```bash
# listen to all levels (debug/info/warn/error)
bun -e '
const ws = new WebSocket("ws://localhost:7024/ws/logs?level=debug");
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  const ts = new Date(ev.ts).toISOString().slice(11, 23);
  console.log(`[${ts}] ${ev.level.toUpperCase().padEnd(5)} ${ev.type.padEnd(15)} ${ev.msg}${ev.requestId ? ` (${ev.requestId.slice(0,8)})` : ""}`);
};'
```

If `RAVEN_API_KEY` is set or DB has API keys, append `&token=<key>` to the query string.

### Key concepts

- **Log levels**: `debug | info | warn | error`. Default level is `info` (configurable via `RAVEN_LOG_LEVEL` env var). Level gating happens before JSON serialization (zero cost for filtered-out events).
- **Event types**: `system`, `request_start`, `request_end`, `sse_chunk`, `upstream_error`. Each request carries a ULID `requestId` linking start → chunks → end.
- **Ring buffer**: Last 200 events cached in memory. New WebSocket connections receive backfill automatically.
- **Client commands**: Send JSON to the WebSocket to adjust filtering on the fly:
  - `{ "type": "set_level", "level": "debug" }` — change minimum level
  - `{ "type": "set_filter", "requestId": "..." }` — isolate a single request
  - `{ "type": "set_filter" }` — clear request filter
- **Three sinks**: terminal (JSON lines → stdout), WebSocket (real-time push), DB (`request_end` → SQLite).
- **Request outcomes**: `success`, `error` and `cancelled` are semantic outcomes.
  A delivered protocol terminator, including the full translated footer, ends the
  request without waiting for transport EOF. Chat usage trailers are consumed
  before `[DONE]`. Cancellation before complete delivery is neutral and still
  stops upstream work. Known upstream errors and independent timeouts remain errors.
- **HTTP status**: started SSE retains `statusCode: 200` and the established
  `upstreamStatus: 200`, including interrupted/error streams. Pre-header client
  cancellation uses 499; independent timeouts use 504. Generic internal failures
  use 500 in both response and log. Filter semantic failures by `status: error`,
  rather than assuming all failures have an HTTP 5xx code. Total request counts
  include cancelled requests; success/error counts include only their own status.
  Historical records are not reclassified.
- **Dashboard path**: proxy WebSocket → dashboard SSE bridge (`/api/logs/stream`) → `useLogStream` hook → `/logs` page UI.


## 有意执行的真实上游诊断

`bun run test:e2e` 会复用或启动真实 Proxy，使用其配置/数据库并访问 Copilot；它不是本地隔离测试。不得在 CI/hooks 自动执行。单独授权的诊断也必须首次上游失败就终止，不重试、不做循环或负载测试，每个用例只发一次请求；真实 token 不进入 fixtures。`RAVEN_API_KEY` 是调用端身份，`RAVEN_INTERNAL_KEY` 是管理身份，不可混淆。不要用自动化测试创建真实数据库临时 key。

网络部署沿用 docs/14-vps-deployment.md：Dashboard 必须配置 Google OAuth，不可公开 Local 模式；启用 IP 白名单并保持 API/管理接口访问控制。本产品仍定位个人本机研究，不是多用户托管服务。
