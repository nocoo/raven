# 03 — Proxy Rewrite: Big-Bang Replace with copilot-api

## Background

Raven proxy has high error rates from hand-written SSE parsing, stream lifecycle bugs, and translation layer issues. The open-source [copilot-api](https://github.com/ericc-ch/copilot-api) (MIT, v0.7.0) solves the same problem with better stability: `streamSSE()` abort handling, `forwardError()` unified errors, rate limiting, and robust stream translation.

**copilot-api version note:** v0.7.0 is the latest release (published 2025-10-05, 5+ months old). Local repo at `copilot-api/` matches `origin/master` exactly at commit `0ea08fe`. The project appears low-activity — monitor `api-config.ts` and `token.ts` for upstream auth/header changes that could break Copilot integration.

## Strategy

**Big-bang replace, then glue, then iterate.**

1. Move `packages/proxy` → `proxy-legacy/` (out of workspace, reference only)
2. Copy copilot-api source into `packages/proxy` as the new core
3. Strip CLI/UX deps, write `createApp()` factory with DI, wire to Bun.serve on :7033
4. Glue Raven features back **including logging** -- `db/`, `middleware.ts`, dashboard API routes, `count-tokens`, `logEmitter.emitLog()` event instrumentation
5. Get MVP running (proxy forwards requests, dashboard loads **with live data**)
6. Iterate: add tests, refactor

**Assumption:** Logging refactoring is already done — the codebase has a full event-bus architecture (see "Logging Architecture" section below). Phase 2 logging work is limited to emitting the right `LogEvent`s from the new handlers; the persistence and streaming infrastructure is in place.

---

## Core Design: App Factory with Partial DI

copilot-api uses a module-level singleton `server` in `server.ts` and a global mutable `state`. Raven needs to attach runtime objects (`db`, `apiKey`, `githubToken`) that don't exist at import time.

**Solution:** Replace copilot-api's bare `export const server = new Hono()` with a `createApp(deps)` factory. This factory handles Raven-specific wiring (db, auth, dashboard routes). copilot-api's core routes still read from the global `state` singleton internally — we do NOT attempt to inject `state` into those handlers.

**Honesty about DI scope:**

| Layer | DI? | How deps flow |
|-------|-----|---------------|
| `createApp(deps)` -- Raven wiring | ✅ Real DI | `client`, `getJwt`, `db`, `apiKey`, `githubToken` passed explicitly |
| Raven routes (stats, requests, copilot-info) | ✅ Real DI | Receive `db` / deps via factory params |
| Logging (emit side) | ✅ Module singleton | Handlers import `logEmitter` directly -- no DI needed, no DB coupling |
| Logging (persist side) | ✅ Bootstrap wiring | `startRequestSink(db)` subscribes listener at boot -- routes are unaware |
| copilot-api routes (chat, messages, models) | ❌ Global singleton | `import { state } from "~/lib/state"` -- unchanged |
| copilot-api services | ❌ Global singleton | Same -- read `state.copilotToken` etc. directly |

This means: **you cannot pass a mock `state` into `createApp()` and expect copilot-api routes to use it.** Testing copilot-api routes requires mutating the global `state` object. This is acceptable for MVP — copilot-api itself has zero tests and was designed around this singleton. Full DI refactoring is Phase 5 backlog.

```typescript
// packages/proxy/src/app.ts

import type { Database } from "bun:sqlite"
import type { CopilotClient } from "./copilot/client"

export interface AppDeps {
  client: CopilotClient           // Copilot API client (token-aware fetch)
  getJwt: () => string            // returns current Copilot JWT (auto-refreshed)
  db: Database                    // SQLite for dashboard queries
  apiKey?: string                 // RAVEN_API_KEY (undefined = dev mode)
  githubToken: string             // needed by copilot-info /user endpoint
  port?: number                   // for connection-info display
}

export function createApp(deps: AppDeps): Hono {
  const { client, getJwt, db, apiKey, githubToken, port } = deps
  const app = new Hono()

  // --- Middleware ---
  app.use("*", requestContext())
  const auth = multiKeyAuth({ db, envApiKey: apiKey })
  app.use("/v1/*", auth)
  app.use("/api/*", auth)

  // --- Health ---
  app.get("/health", (c) => c.json({ status: "ok" }))

  // --- Core proxy routes ---
  // NOTE: Handlers emit LogEvents via logEmitter.emitLog() internally.
  // DB persistence is handled by the request-sink listener (see bootstrap).
  // No db wiring needed in route layer.
  app.route("/v1", createModelsRoute({ client, getJwt }))
  app.route("/v1", countTokensRoute)
  app.route("/v1", createMessagesRoute({ client, copilotJwt: getJwt }))
  app.route("/v1", createChatRoute({ client, copilotJwt: getJwt }))

  // --- Dashboard API ---
  app.route("/api", createStatsRoute(db))
  app.route("/api", createRequestsRoute(db))
  app.route("/api", createCopilotInfoRoute({ client, getJwt, githubToken }))
  app.route("/api", createKeysRoute(db))
  app.route("/api", createConnectionInfoRoute({ client, getJwt, port: port ?? 7033 }))

  return app
}
```

**`index.ts` (bootstrap) creates runtime objects, wires the log pipeline, then passes deps into the factory. The request-sink is started as a LogEmitter listener -- routes never touch the database directly:**

```typescript
// packages/proxy/src/index.ts

import { Database } from "bun:sqlite"
import { loadConfig } from "./config"
import { logger, setLogLevel } from "./util/logger"
import { createApp } from "./app"
import { createCopilotClient } from "./copilot/client"
import { authenticate } from "./copilot/auth"
import { fetchCopilotToken, TokenManager } from "./copilot/token"
import { initDatabase } from "./db/requests"
import { startRequestSink } from "./db/request-sink"
import { initApiKeys } from "./db/keys"
import { wsHandler } from "./ws/logs"

const config = loadConfig()
setLogLevel(config.logLevel)

// --- Database + sinks ---
const db = new Database("data/raven.db")
initDatabase(db)
initApiKeys(db)
startRequestSink(db)    // subscribes to logEmitter, persists request_end events
logger.info("Database ready (WAL mode)")

// --- GitHub OAuth (loads from disk or runs device flow) ---
const githubToken = await authenticate(config.tokenPath)

// --- Copilot JWT (initial fetch + auto-refresh) ---
const tokenManager = new TokenManager()
const initialToken = await fetchCopilotToken(githubToken)
tokenManager.setCopilotToken(initialToken)
tokenManager.startAutoRefresh(githubToken)

// --- Build app ---
const app = createApp({
  client: createCopilotClient(),
  getJwt: () => tokenManager.getToken()!,
  db,
  apiKey: config.apiKey || undefined,
  githubToken,
  port: config.port,
})

// --- Start (Bun.serve with WS support) ---
export default {
  port: config.port,
  fetch(req, server) {
    // WebSocket upgrade for /ws/logs (real-time log streaming)
    if (new URL(req.url).pathname === "/ws/logs") {
      // ... auth check + server.upgrade() ...
      return
    }
    return app.fetch(req, server)
  },
  websocket: wsHandler,
}
```

### Logging Architecture (implemented)

The logging system uses a **fan-out event bus** pattern. All log events flow through a central `LogEmitter` (Node.js `EventEmitter` + ring buffer). Multiple sinks subscribe independently:

```
  Producers                    Event Bus               Sinks (listeners)
  ---                          ---                     ---
  logger.info()  --+
  logger.error() --+
  route handlers --+-->  logEmitter.emitLog()  -->  1. Terminal (logger.ts) -> stdout JSON lines
                   |         |                       2. WebSocket (ws/logs.ts) -> dashboard live stream
                   |         +- ring buffer (200)    3. DB sink (request-sink.ts) -> SQLite
                   |            for WS backfill
```

**Key files:**

| File | Role |
|------|------|
| `util/log-event.ts` | Type definitions: `LogLevel`, `LogEventType`, `LogEvent` |
| `util/log-emitter.ts` | Central event bus (`LogEmitter` class) with ring buffer |
| `util/logger.ts` | Terminal sink (stdout JSON lines) + `logger.debug/info/warn/error()` convenience API |
| `ws/logs.ts` | WebSocket sink -- real-time log streaming to dashboard (per-connection level/filter) |
| `db/request-sink.ts` | DB sink -- persists `request_end` events to SQLite via `startRequestSink(db)` |

**Event types:**

| Type | Emitted by | Persisted? |
|------|-----------|------------|
| `system` | `logger.*()` convenience API | No |
| `request_start` | Route handlers (inline) | No |
| `request_end` | Route handlers (inline) | Yes -- DB sink extracts fields to `RequestRecord` |
| `sse_chunk` | Route handlers (debug only) | No |
| `upstream_error` | Route handlers | No |

**Design properties:**

- Dispatch is **synchronous** -- listeners must be lightweight (level check before serialization)
- Level filtering is **per-sink**: terminal respects `RAVEN_LOG_LEVEL`, WS respects per-connection `?level=` param (adjustable at runtime via `set_level` command)
- DB sink filters by **event type** (`request_end` only), not level
- Route handlers emit `LogEvent`s via `logEmitter.emitLog()` directly -- they never import or call the DB layer
- `requestId` (ULID-like from `util/id.ts`) correlates all events for one request and doubles as the SQLite primary key

**What this means for the rewrite:** Handlers only need to `import { logEmitter } from "~/util/log-emitter"` and call `logEmitter.emitLog({...})` at the right exit points. The `startRequestSink(db)` call in bootstrap handles all persistence automatically. No `setDb()` setters, no `logRequest()` calls, no DB imports in route files.

### Data/Token Path Reconciliation

copilot-api hardcodes `~/.local/share/copilot-api/github_token` in `lib/paths.ts`. Raven uses `RAVEN_TOKEN_PATH` (default: `data/github_token`, relative to project root).

**Two incompatible storage locations.** Options:

| Option | Pros | Cons |
|--------|------|------|
| **A. Patch `lib/paths.ts` to read from env** | Raven's config.tokenPath works, data stays local | Must modify copied file |
| **B. Accept copilot-api's home dir** | Zero changes to copied code | Breaks Raven's `data/` convention, tokens outside project |
| **C. Symlink** | Both work | Fragile, platform-specific |

**Decision: Option A** — patch `lib/paths.ts` to support `RAVEN_TOKEN_PATH` override:

```typescript
// lib/paths.ts — patched
import { loadConfig } from "../raven/config"

const config = loadConfig()
const APP_DIR = resolve(config.tokenPath, "..")     // "data/"
const GITHUB_TOKEN_PATH = config.tokenPath          // "data/github_token"

export const PATHS = { APP_DIR, GITHUB_TOKEN_PATH }

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}
```

This keeps Raven's `data/` directory as the single source of truth for both `github_token` and `raven.db`. The `ensurePaths()` call in bootstrap creates the `data/` dir if needed.

**`ensurePaths()` must run before `setupGitHubToken()`.** `setupGitHubToken()` calls `fs.readFile(PATHS.GITHUB_TOKEN_PATH)` immediately (token.ts:13) — if `data/` doesn't exist or the token file is absent, it throws ENOENT before even reaching the device-code auth flow. `ensurePaths()` does two things that nothing else covers: `mkdir(data/, { recursive: true })` and creating an empty `github_token` file with `0o600` perms. `new Database(..., { create: true })` only creates the `.db` file — it does NOT create the parent directory, and it certainly doesn't create the token file.

---

## Phase 1 — The Swap

### 1.1 `chore: move packages/proxy to proxy-legacy outside workspace`

```bash
mv packages/proxy proxy-legacy
```

Root `package.json` has `"workspaces": ["packages/*"]`. Moving to repo root (not under `packages/`) means:
- bun workspace **automatically stops seeing it** — no glob match
- `bun run --filter '*'` / `lint` / `typecheck` **won't scan it**
- Still in the repo for `git log`, diffing, reference
- `.gitignore` it if desired, or keep tracked as reference

**Do NOT** leave it under `packages/` — the `packages/*` glob will pick it up.

### 1.2 `feat: scaffold new packages/proxy from copilot-api`

Copy copilot-api `src/` into `packages/proxy/src/`. New directory layout (reflects actual refactored structure):

```
packages/proxy/
├── package.json                ← NEW (based on copilot-api, trimmed)
├── tsconfig.json               ← NEW (add ~/paths, bun types)
│
├── src/
│   ├── index.ts                ← Raven bootstrap (wires sinks, auth, starts server)
│   ├── app.ts                  ← createApp factory with DI
│   ├── config.ts               ← RAVEN_* env vars (logLevel, apiKey, tokenPath, port)
│   ├── middleware.ts            ← API key auth (multiKeyAuth) + requestContext
│   │
│   ├── copilot/                ← Auth + client (Raven-owned, replaces copilot-api lib/)
│   │   ├── auth.ts             ← GitHub device flow + token persistence
│   │   ├── client.ts           ← CopilotClient (token-aware fetch)
│   │   ├── headers.ts          ← Copilot API headers (editor version, etc.)
│   │   ├── info.ts             ← Copilot account info service
│   │   ├── token.ts            ← TokenManager (auto-refresh JWT)
│   │   └── vscode.ts           ← VS Code version caching
│   │
│   ├── routes/                 ← HTTP route handlers (flat files, not nested dirs)
│   │   ├── chat.ts             ← /v1/chat/completions — emits LogEvents via logEmitter
│   │   ├── messages.ts         ← /v1/messages — emits LogEvents via logEmitter
│   │   ├── models.ts           ← /v1/models
│   │   ├── embeddings.ts       ← /v1/embeddings
│   │   ├── count-tokens.ts     ← /v1/messages/count_tokens
│   │   ├── stats.ts            ← /api/stats/* (dashboard)
│   │   ├── requests.ts         ← /api/requests (dashboard)
│   │   ├── copilot-info.ts     ← /api/copilot/* (dashboard)
│   │   ├── keys.ts             ← /api/keys (API key management)
│   │   └── connection-info.ts  ← /api/connection-info
│   │
│   ├── translate/              ← Stream format translation (OpenAI ↔ Anthropic)
│   │   ├── anthropic-to-openai.ts
│   │   ├── openai-to-anthropic.ts
│   │   ├── stream.ts
│   │   └── types.ts
│   │
│   ├── db/                     ← SQLite persistence
│   │   ├── requests.ts         ← Schema + queries (RequestRecord)
│   │   ├── request-sink.ts     ← LogEmitter listener — persists request_end events
│   │   └── keys.ts             ← API key storage + hashing
│   │
│   ├── util/                   ← Logging infrastructure + helpers
│   │   ├── log-event.ts        ← LogLevel, LogEventType, LogEvent types
│   │   ├── log-emitter.ts      ← Central event bus (EventEmitter + ring buffer)
│   │   ├── logger.ts           ← Terminal sink (stdout JSON lines) + convenience API
│   │   ├── id.ts               ← ULID-like request ID generation
│   │   ├── keepalive.ts        ← SSE keepalive helper
│   │   ├── params.ts           ← Request parameter extraction
│   │   └── sse.ts              ← SSE utilities
│   │
│   └── ws/
│       └── logs.ts             ← WebSocket sink — real-time log streaming to dashboard
│
├── test/                       ← tests
└── data/                       ← runtime data dir
    └── (raven.db, github_token)
```

### 1.3 `chore: create new package.json with trimmed deps`

```jsonc
{
  "name": "@raven/proxy",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "test:e2e": "bun test test/e2e/",
    "test:perf": "bun test test/perf/"
  },
  "dependencies": {
    "hono": "^4.9.9",
    "fetch-event-stream": "^0.1.5",
    "gpt-tokenizer": "^3.0.1"
  }
}
```

**Dropped 7 deps:** `citty`, `consola`, `clipboardy`, `srvx`, `tiny-invariant`, `undici`, `proxy-from-env`

**Net: 3 runtime deps** (`hono`, `fetch-event-stream`, `gpt-tokenizer`) + `bun:sqlite` built-in.

### 1.4 `refactor: strip consola from all copilot-api files`

Mechanical find-and-replace across 14 files. Replace with Raven's `logger.*` convenience API (which emits `system` type events through `LogEmitter`) or `logEmitter.emitLog()` for typed events:

| Pattern | Replacement |
|---------|-------------|
| `import { consola } from "consola"` | `import { logger } from "~/util/logger"` |
| `consola.debug(...)` | `logger.debug(...)` or remove |
| `consola.info(...)` | `logger.info(...)` |
| `consola.warn(...)` | `logger.warn(...)` |
| `consola.error(...)` | `logger.error(...)` |
| `consola.start(...)` | `logger.info(...)` |
| `consola.success(...)` | `logger.info(...)` |

In route handlers specifically, replace `consola.*` with direct `logEmitter.emitLog()` calls using typed events (`request_start`, `request_end`, etc.) -- see Phase 2.3/2.4.

### 1.5 `refactor: strip approval, proxy, shell modules`

- Do NOT copy `lib/approval.ts`, `lib/proxy.ts`, `lib/shell.ts`
- Remove `awaitApproval()` calls and `manualApprove` checks from `chat-completions/handler.ts` and `messages/handler.ts`
- Remove all `import ... from "~/lib/approval"` lines

### 1.6 `refactor: replace tiny-invariant with inline checks`

Only used in original `start.ts` (which we replaced with our own `index.ts`), so likely already gone. If any remain in copied files:

```typescript
// Before: invariant(state.models, "Models not loaded")
// After:  if (!state.models) throw new Error("Models not loaded")
```

---

## Phase 2 — Glue Raven Features (including logging)

**Logging is MVP-critical.** Without `logEmitter.emitLog()` calls in the new handlers, the DB sink has nothing to persist and `/api/stats/*` and `/api/requests` return empty data -- that's a behavior regression the dashboard would immediately surface. So log event instrumentation goes in Phase 2, not "post-MVP". The logging infrastructure (event bus, sinks, types) is already in place -- this phase is about emitting the right events from the new handlers.

### 2.1 `feat: write createApp factory with dependency injection`

Create `src/app.ts` as described in the "Core Design" section above. This is the central wiring point that resolves the "server is singleton but Raven deps are runtime objects" problem.

Key: `createApp(deps: AppDeps)` receives `{ db, apiKey, githubToken }` and wires everything. (`state` is NOT injected — copilot-api routes access it as a global singleton; see "Partial DI" table above.)

### 2.2 `feat: rewire copilot-info.ts to new state/services`

The legacy `copilot-info.ts` depends on `CopilotClient` + `getJwt()` + `githubToken`. The new version needs:

```typescript
// raven/copilot-info.ts — rewired

import { state } from "../lib/state"
import { getCopilotUsage } from "../services/github/get-copilot-usage"
import { cacheModels } from "../lib/utils"

export interface CopilotInfoDeps {
  githubToken: string       // documentation only — asserts token was set before creation
}

export function createCopilotInfoRoute(deps: CopilotInfoDeps): Hono {
  const app = new Hono()

  let cachedUser: unknown = null

  // /copilot/models — read from global state.models (already cached by cacheModels())
  app.get("/copilot/models", async (c) => {
    const refresh = c.req.query("refresh") === "true"
    if (refresh) {
      await cacheModels()   // refreshes state.models in-place
    }
    if (!state.models) {
      return c.json({ error: "Models not available" }, 502)
    }
    return c.json(state.models)
  })

  // /copilot/user — getCopilotUsage reads state.githubToken internally
  // This calls GET api.github.com/copilot_internal/user with GitHub OAuth token
  // (NOT Copilot JWT — this is a GitHub API, not Copilot API)
  app.get("/copilot/user", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "true"
      if (refresh || cachedUser === null) {
        cachedUser = await getCopilotUsage()
      }
      return c.json(cachedUser)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      return c.json({ error: message }, 502)
    }
  })

  // Eager fetch at creation
  getCopilotUsage().then(u => { cachedUser = u }).catch(console.error)

  return app
}
```

**Why `githubToken` is in deps but not used in the function body:** It serves as a precondition assertion — the caller must have `state.githubToken` set before creating this route (which `setupGitHubToken()` does in bootstrap). The actual service `getCopilotUsage()` reads from global `state.githubToken` internally, same as all other copilot-api services. This is consistent with the "Partial DI" model described above: Raven routes access the global state for copilot-api concerns, and only receive Raven-specific deps (like `db`) via real injection.

### 2.3 `feat: add log events to chat-completions handler`

Modify copilot-api's handler to emit structured `LogEvent`s via `logEmitter.emitLog()`. The handler does **not** import `db` or call any persistence function -- the `request-sink` listener (wired in bootstrap) handles SQLite writes automatically when it sees a `request_end` event.

```typescript
// At module level
import { logEmitter } from "~/util/log-emitter"
import { generateId } from "~/util/id"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateId()
  let model = ""
  let stream = false

  try {
    model = payload.model
    stream = !!payload.stream

    // --- request_start ---
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: `POST /v1/chat/completions ${model}`,
      data: { path: "/v1/chat/completions", format: "openai", model, stream },
    })

    const response = await createChatCompletions(payload)

    if (isNonStreaming(response)) {
      // --- request_end (non-stream success) ---
      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `completed ${model}`,
        data: {
          path: "/v1/chat/completions", format: "openai", model,
          resolvedModel: response.model, stream: false,
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          latencyMs: performance.now() - startTime,
          status: "success", statusCode: 200,
        },
      })
      return c.json(response)
    }

    // Streaming path — emit request_end in finally block
    // (covers success, client abort, upstream error)
    // ...
  } catch (error) {
    const statusCode = error instanceof HTTPError ? error.response.status : 500
    // --- request_end (error) ---
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `failed ${model}: ${error instanceof Error ? error.message : String(error)}`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, stream,
        latencyMs: performance.now() - startTime,
        status: "error", statusCode, upstreamStatus: statusCode !== 500 ? statusCode : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}
```

Every request MUST emit exactly one `request_end` event as its terminal event -- this is the contract that `request-sink` depends on for DB persistence.

### 2.4 `feat: add log events to messages handler`

Same event-bus pattern as 2.3 but with:
- `format: "anthropic"` in the data bag
- `path: "/v1/messages"`
- Anthropic stream translation already parses chunks inline, so usage/TTFT extraction is direct

### 2.5 `feat: wire request sink in bootstrap` (already done)

`startRequestSink(db)` is called in `index.ts` at bootstrap (see code above). It subscribes a listener to `logEmitter` that:
1. Filters for `type === "request_end"` events only
2. Extracts `data` fields into a `RequestRecord`
3. Calls `insertRequest(db, record)` -- wrapped in try/catch to never crash the request flow
4. Uses `console.error()` directly (not `logEmitter`) to avoid infinite recursion on DB write failures

No `setDb()` setters needed. No DB imports in route files. The decoupling is clean: handlers emit events, the sink persists them.

### 2.6 `feat: add health endpoint`

In `app.ts`:

```typescript
app.get("/health", (c) => c.json({ status: "ok" }))
```

---

## Phase 3 — MVP Verification

### 3.1 `test: verify core proxy routes`

```bash
bun run dev

# === Core proxy ===
curl http://localhost:7033/health
curl http://localhost:7033/v1/models

curl -X POST http://localhost:7033/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

curl -X POST http://localhost:7033/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'

# === count_tokens (Claude Code compatibility — critical) ===
# copilot-api's messageRoutes registers POST /count_tokens as a sub-route,
# so it's accessible at POST /v1/messages/count_tokens
curl -X POST http://localhost:7033/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hello world"}],"max_tokens":1024}'
# → expect: { "input_tokens": <number> }
```

### 3.2 `test: verify ALL 7 dashboard API endpoints`

```bash
# === Dashboard stats (from SQLite) ===
curl http://localhost:7033/api/stats/overview
curl http://localhost:7033/api/stats/timeseries?interval=hour&range=24h
curl http://localhost:7033/api/stats/models
curl http://localhost:7033/api/stats/recent?limit=5
curl http://localhost:7033/api/requests?limit=10

# === Copilot info (from upstream cache) ===
curl http://localhost:7033/api/copilot/models
curl http://localhost:7033/api/copilot/user
```

All 7 endpoints must return correct JSON shapes. **After sending a chat request in 3.1, re-check stats endpoints to confirm the new request appears in the data.** This validates the logging pipeline end-to-end.

### 3.3 `test: verify auth-protected paths`

```bash
# With RAVEN_API_KEY set:
export RAVEN_API_KEY=test-key

# Should 401 without auth:
curl http://localhost:7033/v1/models
# → 401

# Should 200 with auth:
curl http://localhost:7033/v1/models -H "Authorization: Bearer test-key"
# → 200

# Dashboard API also protected:
curl http://localhost:7033/api/stats/overview
# → 401

curl http://localhost:7033/api/stats/overview -H "Authorization: Bearer test-key"
# → 200

# Health is NOT protected:
curl http://localhost:7033/health
# → 200 (no auth needed)
```

### 3.4 `test: verify dashboard renders with live data`

1. Start proxy: `bun run dev:proxy`
2. Send 2-3 requests via curl (mix of chat and messages)
3. Start dashboard: `bun run dev:dashboard`
4. Verify:
   - Overview page shows request count > 0, token totals, avg latency
   - Models page shows models used
   - Requests page shows individual request rows with correct fields
   - Copilot models page shows model list
   - Copilot account page shows user info

**This is the acceptance gate.** If dashboard shows live data from new requests, MVP is done.

---

## Phase 4 — Test Rebuild

### Test migration strategy

```
proxy-legacy/test/              → reference for test cases
packages/proxy/test/            → new tests
```

### Tests to copy as-is from legacy (40 tests, zero changes needed)

These only depend on Raven-specific modules that are copied verbatim:

```
test/db/requests.test.ts        → 18 tests (SQLite queries)
test/routes/stats.test.ts       → 10 tests (dashboard stats API)
test/middleware.test.ts          → 10 tests (API key auth)
test/config.test.ts             → 2 tests (env var loading)
```

### Tests to adapt (new function signatures, same test cases)

| Priority | Tests | Source | Action |
|----------|-------|--------|--------|
| P0 | Dashboard API contract | New | Snapshot tests for 7 `/api/*` endpoints |
| P0 | E2E smoke | Copy from legacy | 8 tests, adjust if routes changed |
| P1 | Translation (58 cases) | Adapt from legacy | Same test cases, new function names (`translateToOpenAI`/`translateToAnthropic`/`translateChunkToAnthropicEvents`) |
| P1 | Logging (10 cases) | Rewrite | Test `logEmitter.emitLog()` at exit points per handler + `request-sink` persistence |
| P2 | Auth flow | Adapt from legacy | 20 tests, point to new service modules |
| P2 | App wiring | Rewrite | Test `createApp(deps)` with mock deps |
| P3 | Rate limiting | New | Test copilot-api's `checkRateLimit` |
| P3 | Error handling | New | Test `HTTPError` + `forwardError` |

---

## Phase 5 — Iterative Deepening (ongoing)

After MVP is stable, pick from this backlog:

| Item | Effort | Impact |
|------|--------|--------|
| Add request timeout (`AbortSignal.timeout(30s)`) | S | Prevents hung connections |
| Add `zod` request validation | M | Rejects malformed payloads early |
| Upstream tracking (`git remote add upstream`) | S | Track auth/header changes |
| Refactor global `state` → injected dependency | L | Full testability |
| Add `Retry-After` header forwarding on 429 | S | Better client experience |
| Remove `gpt-tokenizer` if count-tokens not needed | S | Fewer deps |

---

## File Trimming Checklist

### copilot-api files: DO NOT COPY

| File | Reason |
|------|--------|
| `src/main.ts` | citty CLI entry |
| `src/auth.ts` | citty CLI subcommand |
| `src/check-usage.ts` | citty CLI subcommand |
| `src/debug.ts` | citty CLI subcommand |
| `src/start.ts` | citty CLI + srvx bootstrap (replaced by our `index.ts`) |
| `src/server.ts` | Bare singleton Hono app (replaced by our `app.ts` factory) |
| `src/lib/approval.ts` | consola interactive prompt |
| `src/lib/proxy.ts` | undici proxy (no-op on Bun) |
| `src/lib/shell.ts` | clipboard UX |
| `src/routes/token/route.ts` | Exposes raw JWT (security risk) |

### copilot-api files: STRIP (copy + remove unwanted deps)

| File | Strip | Keep |
|------|-------|------|
| `lib/error.ts` | `consola` | `HTTPError`, `forwardError` |
| `lib/rate-limit.ts` | `consola` | `checkRateLimit` |
| `lib/token.ts` | `consola` | `setupGitHubToken`, `setupCopilotToken` |
| `lib/utils.ts` | `consola` | `cacheModels`, `cacheVSCodeVersion`, `sleep`, `isNullish` |
| `services/copilot/create-chat-completions.ts` | `consola` | core service |
| `services/github/poll-access-token.ts` | `consola` | polling logic |
| `routes/chat-completions/handler.ts` | `consola`, `approval`, ADD `logEmitter.emitLog()` events | handler + structured logging |
| `routes/messages/handler.ts` | `consola`, `approval`, ADD `logEmitter.emitLog()` events | handler + structured logging |
| `routes/messages/count-tokens-handler.ts` | `consola` | token counting |

### copilot-api files: COPY AS-IS (zero external deps, no changes needed)

```
lib/api-config.ts              ← only node:crypto + internal state type
lib/state.ts                   ← zero deps
lib/tokenizer.ts               ← only gpt-tokenizer
services/copilot/create-embeddings.ts
services/copilot/get-models.ts
services/github/get-copilot-token.ts
services/github/get-copilot-usage.ts
services/github/get-device-code.ts
services/github/get-user.ts
services/get-vscode-version.ts
routes/messages/anthropic-types.ts
routes/messages/non-stream-translation.ts
routes/messages/stream-translation.ts
routes/messages/utils.ts
routes/models/route.ts
routes/embeddings/route.ts
routes/chat-completions/route.ts   ← only hono + forwardError + handler
routes/messages/route.ts           ← only hono + forwardError + handlers (includes /count_tokens)
```

### copilot-api files: PATCH (copy + modify for Raven compatibility)

| File | Change | Reason |
|------|--------|--------|
| `lib/paths.ts` | Replace hardcoded `~/.local/share/copilot-api/` with `RAVEN_TOKEN_PATH`-derived paths | Reconcile token/data storage location (see "Data/Token Path Reconciliation") |

---

## Dependency Audit Summary

| Dep | copilot-api | New Raven | Action |
|-----|-------------|-----------|--------|
| `hono` | ✅ | ✅ | Keep, upgrade to ^4.9.9 |
| `fetch-event-stream` | ✅ | ✅ | Keep |
| `gpt-tokenizer` | ✅ | ✅ | Keep (for count-tokens) |
| `bun:sqlite` | ❌ | ✅ | Raven-specific, built-in |
| `citty` | ✅ | ❌ | Drop — replaced by direct bootstrap |
| `consola` | ✅ | ❌ | Drop -- replaced by `logger.*` (emits through LogEmitter) |
| `clipboardy` | ✅ | ❌ | Drop — UX sugar |
| `srvx` | ✅ | ❌ | Drop — replaced by Bun.serve |
| `tiny-invariant` | ✅ | ❌ | Drop — inline if/throw |
| `undici` | ✅ | ❌ | Drop — Bun no-op |
| `proxy-from-env` | ✅ | ❌ | Drop — Bun no-op |
| `zod` | ✅ | ⏳ Later | Optional, not for MVP |

**Final: 3 runtime deps** (`hono`, `fetch-event-stream`, `gpt-tokenizer`) + `bun:sqlite` built-in.

---

## Dashboard API Contract (must not break)

| # | Endpoint | Response Shape | Source After Rewrite | Verified In |
|---|----------|---------------|---------------------|-------------|
| 1 | `GET /api/stats/overview` | `{ total_requests, total_tokens, error_count, avg_latency_ms }` | `raven/stats.ts` → `db/requests.ts` (untouched) | 3.2 |
| 2 | `GET /api/stats/timeseries?interval=&range=` | `[{ bucket, count, total_tokens, avg_latency_ms }]` | Same | 3.2 |
| 3 | `GET /api/stats/models` | `[{ model, count, total_tokens, avg_latency_ms }]` | Same | 3.2 |
| 4 | `GET /api/stats/recent?limit=` | `RequestRecord[]` | Same | 3.2 |
| 5 | `GET /api/requests?...` | `{ data: RequestRecord[], has_more, next_cursor?, total? }` | Same | 3.2 |
| 6 | `GET /api/copilot/models` | `{ object, data: CopilotModel[] }` | `raven/copilot-info.ts` → `state.models` (rewired) | 3.2 |
| 7 | `GET /api/copilot/user` | `CopilotUser` | `raven/copilot-info.ts` → `getCopilotUsage()` (rewired) | 3.2 |
| 8 | `WS /ws/logs?token=&level=` | Stream of `LogEvent` JSON objects | `ws/logs.ts` → `logEmitter` ring buffer + live events | 3.4 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Dashboard shows empty data | Log event instrumentation is in Phase 2 (MVP), not deferred. `startRequestSink(db)` in bootstrap persists `request_end` events automatically. Verified in 3.2 + 3.4. |
| DB persistence breaks request flow | `request-sink.ts` wraps `insertRequest()` in try/catch, uses `console.error()` directly (not logEmitter) to avoid infinite recursion. DB failures are logged but never crash handlers. |
| `copilot-info.ts` breaks | Reads global `state.models` + calls `getCopilotUsage()` (which reads `state.githubToken`). Tested in 3.2. |
| Legacy pollutes workspace | Moved to `proxy-legacy/` at repo root, outside `packages/*` glob. |
| Auth not tested | Phase 3.3 explicitly tests auth + no-auth paths for both `/v1/*` and `/api/*`. |
| Route prefix collision (/api/stats/stats/*) | Raven routes define full internal paths (`/stats/overview`, `/requests`). All mounted at `/api` prefix. Verified by curl in 3.2. |
| Token/DB path mismatch | `lib/paths.ts` patched to read from `RAVEN_TOKEN_PATH`. Both token and DB live under `data/`. See "Data/Token Path Reconciliation". |
| First-run ENOENT on token file | `ensurePaths()` runs before `setupGitHubToken()` in bootstrap. Creates `data/` dir + empty `github_token` with `0o600` perms. |
| Error status logged as wrong code | `catch` block extracts `HTTPError.response.status` (429, 403, etc.). Only unknown errors fall back to 500. |
| count_tokens breaks Claude Code | `messageRoutes` includes `POST /count_tokens` sub-route. Verified in Phase 3.1. |
| state not truly injectable | Documented as "Partial DI" — copilot-api routes use global singleton. Tests must mutate global state. Full DI is Phase 5 backlog. |
| Translation regression | copilot-api translation is strictly more correct (see comparison in earlier analysis). |
| Upstream copilot-api changes | `git remote add upstream`, periodic diff on `api-config.ts` + `token.ts`. |

---

## Commit Sequence Summary

```
Phase 1 — The Swap
  1.1  chore: move packages/proxy to proxy-legacy outside workspace
  1.2  feat: scaffold new packages/proxy from copilot-api
  1.3  chore: create new package.json with trimmed deps
  1.4  refactor: strip consola from all copilot-api files
  1.5  refactor: strip approval, proxy, shell modules
  1.6  refactor: replace tiny-invariant with inline checks
  1.7  refactor: patch lib/paths.ts to use RAVEN_TOKEN_PATH

Phase 2 — Glue Raven Features (including logging)
  2.1  feat: write createApp factory with partial DI
  2.2  feat: rewire copilot-info.ts to new state/services
  2.3  feat: add log events to chat-completions handler (logEmitter.emitLog)
  2.4  feat: add log events to messages handler (logEmitter.emitLog)
  2.5  feat: wire request sink in bootstrap (startRequestSink)

Phase 3 — MVP Verification
  3.1  test: verify core proxy routes + count_tokens (manual)
  3.2  test: verify ALL 7 dashboard API endpoints (manual)
  3.3  test: verify auth-protected paths (manual)
  3.4  test: verify dashboard renders with live data (manual)

Phase 4 — Test Rebuild
  (copy 40 safe tests, adapt translation tests, write new wiring tests)

Phase 5 — Iterative Deepening
  (timeout, zod, full DI refactor, upstream tracking, ...)
```

---

## Adaptation Notes for copilot-api Code

When copying copilot-api modules, apply these transformations:

1. **`~/` imports** — add `paths: { "~/*": ["./src/*"] }` to `tsconfig.json` (one line, all imports work)
2. **`consola.*` → `logger.*` / `logEmitter.emitLog()`** — infrastructure modules use `logger.*` convenience API, route handlers use `logEmitter.emitLog()` with typed events
3. **`awaitApproval()` calls** — delete entirely (2 handlers)
4. **`manualApprove` checks** — delete entirely (2 handlers)
5. **`tiny-invariant`** — inline `if (!x) throw` (likely zero occurrences in copied files)
6. **Add `logEmitter.emitLog()` events** — 2 handlers, emit `request_start` + `request_end` (+ `upstream_error`, `sse_chunk` for debug). DB persistence is automatic via `request-sink` (see Phase 2.3/2.4)
7. **`server.ts` → `app.ts`** — singleton → factory with `AppDeps` (see Core Design)
8. **`lib/paths.ts`** — patch hardcoded `~/.local/share/copilot-api/` to use `RAVEN_TOKEN_PATH` (see "Data/Token Path Reconciliation")
