# 26 · 代理分层、日志与运维约定

日常命令、测试目标与六维质量状态见根 CLAUDE.md。旧手册的生产数据库 E2E 不再是 6DQ 的合格测试方案；真实上游诊断必须另行获得明确任务授权。

## 分层与本机数据


Bun workspace monorepo: `packages/proxy` (Hono, port 7024) + `packages/dashboard` (Next.js 16, port 7023).

### Proxy layering (see `docs/20-architecture-refactor.md` for the full contract)

Seven layers, top → bottom. Each layer imports only from the layers below (enforced by `dependency-cruiser.config.cjs`):

1. **`routes/`** — HTTP entry points (Hono handlers). Owns request parsing, logging start, and composition dispatch. Must not import `strategies/` or `upstream/` directly.
2. **`composition/`** — the **sole bridge** between `routes/`, `strategies/`, and `upstream/`. `dispatch()` picks a strategy factory, builds it with state-derived deps, and drives the Runner.
3. **`core/`** — abstract `Strategy`/`Runner`/router contracts + `RequestContext`. Concretion-free: never imports `strategies/` or `upstream/`.
4. **`strategies/`** — seven `makeXxx(deps)` factories implementing the 7-method `Strategy` interface (`prepare` / `dispatch` / `adaptJson` / `initStreamState` / `adaptChunk` / `adaptStreamError` / `describeEndLog`). Per-strategy files (`strategies/*.ts`) read no `infra/state` — deps are injected. `strategies/support/` holds cross-strategy helpers (server-tool `decorate()`, effort-fallback, capability gates).
5. **`protocols/`** — pure translation zone (Anthropic ↔ OpenAI, SSE adapters, preprocess). No state, no logging, no Hono streaming.
6. **`upstream/`** — upstream HTTP clients (Copilot native, Copilot OpenAI, custom providers) registered via `composition/upstream-registry.ts`.
7. **`infra/` + `lib/` + `util/`** — state, auth, rate-limit, logging primitives, IDs.

**Seven strategies** (all registered in `composition/strategy-registry.ts`):
- `copilot-openai-direct` — `/v1/chat/completions` to Copilot
- `copilot-chat-via-responses` — `/v1/chat/completions` → Copilot `/responses` (responses-only models)
- `copilot-translated` — `/v1/messages` Anthropic → Copilot OpenAI
- `copilot-native` — `/v1/messages` to Copilot native endpoint (claude-* models)
- `copilot-responses` — `/v1/responses` to Copilot
- `custom-openai` — user-configured OpenAI-compatible providers
- `custom-anthropic` — user-configured Anthropic providers

**Server-tool interception** (Tavily `web_search`) runs via `strategies/support/server-tools.ts::decorate()`, which wraps `withServerToolInterception` + `request_end` log + JSON/SSE replay. Both translated and native paths share it.

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
- **Dashboard path**: proxy WebSocket → dashboard SSE bridge (`/api/logs/stream`) → `useLogStream` hook → `/logs` page UI.


## 有意执行的真实上游诊断

`bun run test:e2e` 会复用或启动真实 Proxy，使用其配置/数据库并访问 Copilot；它不是本地隔离测试。不得在 CI/hooks 自动执行。单独授权的诊断也必须首次上游失败就终止，不重试、不做循环或负载测试，每个用例只发一次请求；真实 token 不进入 fixtures。`RAVEN_API_KEY` 是调用端身份，`RAVEN_INTERNAL_KEY` 是管理身份，不可混淆。不要用自动化测试创建真实数据库临时 key。

网络部署沿用 docs/14-vps-deployment.md：Dashboard 必须配置 Google OAuth，不可公开 Local 模式；启用 IP 白名单并保持 API/管理接口访问控制。本产品仍定位个人本机研究，不是多用户托管服务。
