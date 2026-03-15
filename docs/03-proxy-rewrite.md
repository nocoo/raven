# 03 — Proxy Rewrite: Big-Bang Replace with copilot-api

## Background

Raven proxy has high error rates from hand-written SSE parsing, stream lifecycle bugs, and translation layer issues. The open-source [copilot-api](https://github.com/ericc-ch/copilot-api) (MIT, v0.7.0) solves the same problem with better stability: `streamSSE()` abort handling, `forwardError()` unified errors, rate limiting, and robust stream translation.

**copilot-api version note:** v0.7.0 is the latest release (published 2025-10-05, 5+ months old). Local repo at `copilot-api/` matches `origin/master` exactly at commit `0ea08fe`. The project appears low-activity — monitor `api-config.ts` and `token.ts` for upstream auth/header changes that could break Copilot integration.

## Strategy

**Big-bang replace, then glue, then iterate.**

1. Move `packages/proxy` → `proxy-legacy/` (out of workspace, reference only)
2. Copy copilot-api source into `packages/proxy` as the new core
3. Strip CLI/UX deps, write `createApp()` factory with DI, wire to Bun.serve on :7033
4. Glue Raven features back **including logging** — `db/`, `middleware.ts`, dashboard API routes, `count-tokens`, `logRequest()` hooks
5. Get MVP running (proxy forwards requests, dashboard loads **with live data**)
6. Iterate: add tests, refactor

**Assumption:** Phase 0 (`logRequest` extraction to `db/log.ts`) is already done.

---

## Core Design: App Factory with Partial DI

copilot-api uses a module-level singleton `server` in `server.ts` and a global mutable `state`. Raven needs to attach runtime objects (`db`, `apiKey`, `githubToken`) that don't exist at import time.

**Solution:** Replace copilot-api's bare `export const server = new Hono()` with a `createApp(deps)` factory. This factory handles Raven-specific wiring (db, auth, dashboard routes). copilot-api's core routes still read from the global `state` singleton internally — we do NOT attempt to inject `state` into those handlers.

**Honesty about DI scope:**

| Layer | DI? | How deps flow |
|-------|-----|---------------|
| `createApp(deps)` — Raven wiring | ✅ Real DI | `db`, `apiKey`, `githubToken` passed explicitly |
| Raven routes (stats, requests, copilot-info) | ✅ Real DI | Receive `db` / `state` via factory params |
| copilot-api routes (chat, messages, models) | ❌ Global singleton | `import { state } from "~/lib/state"` — unchanged |
| copilot-api services | ❌ Global singleton | Same — read `state.copilotToken` etc. directly |

This means: **you cannot pass a mock `state` into `createApp()` and expect copilot-api routes to use it.** Testing copilot-api routes requires mutating the global `state` object. This is acceptable for MVP — copilot-api itself has zero tests and was designed around this singleton. Full DI refactoring is Phase 5 backlog.

```typescript
// packages/proxy/src/app.ts

import type { Database } from "bun:sqlite"

export interface AppDeps {
  db: Database                    // SQLite for request logging + dashboard queries
  apiKey: string                  // RAVEN_API_KEY (empty = no auth)
  githubToken: string             // needed by copilot-info /user endpoint
}

export function createApp(deps: AppDeps): Hono {
  const { db, apiKey, githubToken } = deps
  const app = new Hono()

  // --- Middleware ---
  app.use(logger())
  app.use(cors())
  app.use("*", requestContext())
  if (apiKey) {
    app.use("/v1/*", apiKeyAuth(apiKey))
    app.use("/api/*", apiKeyAuth(apiKey))
  }

  // --- Wire db into handlers for logging ---
  setChatDb(db)
  setMsgDb(db)

  // --- copilot-api core routes (read from global state internally) ---
  app.route("/chat/completions", completionRoutes)
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/v1/messages", messageRoutes)     // includes /v1/messages/count_tokens
  app.route("/models", modelRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/embeddings", embeddingRoutes)
  app.route("/v1/embeddings", embeddingRoutes)

  // --- Raven: health ---
  app.get("/health", (c) => c.json({ status: "ok" }))

  // --- Raven: dashboard API ---
  // NOTE: Raven routes define internal paths like "/stats/overview", "/requests",
  // "/copilot/models". Mount at "/api" so final paths become "/api/stats/overview" etc.
  app.route("/api", createStatsRoute(db))
  app.route("/api", createRequestsRoute(db))
  app.route("/api", createCopilotInfoRoute({ githubToken }))

  // --- copilot-api extras ---
  app.route("/usage", usageRoute)
  // NOTE: /token route deliberately excluded (exposes JWT, security risk)

  return app
}
```

**`index.ts` (bootstrap) creates runtime objects, then passes them into the factory:**

```typescript
// packages/proxy/src/index.ts

import { Database } from "bun:sqlite"
import { loadConfig } from "./raven/config"
import { initDatabase } from "./db/requests"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { createApp } from "./app"
import { resolve } from "node:path"
import { ensurePaths } from "./lib/paths"

const config = loadConfig()

// --- Ensure data dir + token file exist BEFORE anything reads them ---
await ensurePaths()

// --- Raven: SQLite ---
// DB lives next to token file: config.tokenPath = "data/github_token"
// → DB path = "data/raven.db"
const dataDir = resolve(config.tokenPath, "..")
const db = new Database(resolve(dataDir, "raven.db"), { create: true })
initDatabase(db)

// --- copilot-api boot sequence ---
// copilot-api's lib/paths.ts hardcodes ~/.local/share/copilot-api/github_token
// for its own token storage. We override by setting RAVEN_TOKEN_PATH in config
// and patching lib/paths.ts to use it (see "Data/Token Path Reconciliation" below).
state.accountType = "individual"
await cacheVSCodeVersion()
await setupGitHubToken()
await setupCopilotToken()
await cacheModels()

// --- Create app with all deps ---
const app = createApp({
  db,
  apiKey: config.apiKey,
  githubToken: state.githubToken!,
})

// --- Start ---
Bun.serve({ fetch: app.fetch, port: config.port })
console.log(`Raven proxy listening on http://localhost:${config.port}`)
```

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

Copy copilot-api `src/` into `packages/proxy/src/`. New directory layout:

```
packages/proxy/
├── package.json                ← NEW (based on copilot-api, trimmed)
├── tsconfig.json               ← NEW (add ~/paths, bun types)
│
├── src/
│   ├── index.ts                ← NEW (Raven bootstrap)
│   ├── app.ts                  ← NEW (createApp factory with DI)
│   │
│   ├── lib/                    ← FROM copilot-api (trimmed)
│   │   ├── api-config.ts       ← KEEP (headers, URLs, constants)
│   │   ├── error.ts            ← KEEP (HTTPError, forwardError) — strip consola
│   │   ├── paths.ts            ← KEEP (token file paths)
│   │   ├── rate-limit.ts       ← KEEP — strip consola
│   │   ├── state.ts            ← KEEP (global state singleton)
│   │   ├── token.ts            ← KEEP (GitHub + Copilot token setup) — strip consola
│   │   ├── tokenizer.ts        ← KEEP (gpt-tokenizer wrapper)
│   │   └── utils.ts            ← KEEP (cacheModels, cacheVSCodeVersion) — strip consola
│   │
│   ├── services/               ← FROM copilot-api (all kept)
│   │   ├── copilot/
│   │   │   ├── create-chat-completions.ts  ← strip consola
│   │   │   ├── create-embeddings.ts
│   │   │   └── get-models.ts
│   │   ├── github/
│   │   │   ├── get-copilot-token.ts
│   │   │   ├── get-copilot-usage.ts
│   │   │   ├── get-device-code.ts
│   │   │   ├── get-user.ts
│   │   │   └── poll-access-token.ts        ← strip consola
│   │   └── get-vscode-version.ts
│   │
│   ├── routes/                 ← FROM copilot-api (core routes) + logging hooks
│   │   ├── chat-completions/
│   │   │   ├── route.ts
│   │   │   └── handler.ts     ← strip consola/approval, ADD logRequest hooks
│   │   ├── messages/
│   │   │   ├── route.ts
│   │   │   ├── handler.ts     ← strip consola/approval, ADD logRequest hooks
│   │   │   ├── anthropic-types.ts
│   │   │   ├── non-stream-translation.ts
│   │   │   ├── stream-translation.ts
│   │   │   ├── count-tokens-handler.ts     ← strip consola
│   │   │   └── utils.ts
│   │   ├── models/
│   │   │   └── route.ts
│   │   ├── embeddings/
│   │   │   └── route.ts
│   │   └── usage/
│   │       └── route.ts
│   │
│   ├── db/                     ← FROM proxy-legacy (Raven-specific, copy as-is)
│   │   ├── requests.ts
│   │   └── log.ts              ← FROM Phase 0 extraction
│   │
│   ├── raven/                  ← FROM proxy-legacy (Raven-specific features)
│   │   ├── middleware.ts       ← API key auth + requestContext
│   │   ├── config.ts           ← RAVEN_* env vars
│   │   ├── stats.ts            ← GET /api/stats/* routes
│   │   ├── requests.ts         ← GET /api/requests route
│   │   └── copilot-info.ts     ← GET /api/copilot/* routes (rewired)
│   │
│   └── util/
│       └── logger.ts           ← FROM proxy-legacy
│
├── test/                       ← tests (initially copied safe ones from legacy)
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

Mechanical find-and-replace across 14 files:

| Pattern | Replacement |
|---------|-------------|
| `import { consola } from "consola"` | remove line |
| `consola.debug(...)` | remove or `// debug: ...` |
| `consola.info(...)` | `console.log(...)` |
| `consola.warn(...)` | `console.warn(...)` |
| `consola.error(...)` | `console.error(...)` |
| `consola.start(...)` | `console.log(...)` |
| `consola.success(...)` | `console.log(...)` |

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

**Logging is MVP-critical.** Without `logRequest()` calls in the new handlers, `/api/stats/*` and `/api/requests` return empty data — that's a behavior regression the dashboard would immediately surface. So logging hooks go in Phase 2, not "post-MVP".

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

### 2.3 `feat: add logRequest hooks to chat-completions handler`

Modify copilot-api's `chat-completions/handler.ts` to accept `db` and call `logRequest()`:

```typescript
// At module level — import logging
import { logRequest, generateId } from "../../db/log"
import type { Database } from "bun:sqlite"

// db is accessed via a module-level setter (see 2.4)
let _db: Database | undefined

export function setDb(db: Database | undefined) { _db = db }

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateId()
  let model = ""
  let stream = false

  try {
    // ... existing handler logic ...
    // After payload parse:
    model = payload.model
    stream = !!payload.stream

    const response = await createChatCompletions(payload)

    if (isNonStreaming(response)) {
      const latency = performance.now() - startTime
      logRequest(_db, {
        id: requestId,
        path: "/v1/chat/completions",
        clientFormat: "openai",
        model,
        resolvedModel: response.model ?? null,
        stream: false,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        latencyMs: latency,
        status: "success",
        statusCode: 200,
      })
      return c.json(response)
    }

    // Streaming path
    let ttft: number | undefined
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let resolvedModel: string | undefined
    let streamError: Error | undefined

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        logRequest(_db, {
          id: requestId, path: "/v1/chat/completions",
          clientFormat: "openai", model, stream: true,
          inputTokens, outputTokens, ttftMs: ttft,
          latencyMs: performance.now() - startTime,
          status: "error", statusCode: 499,
          errorMessage: "Client disconnected",
        })
      })

      for await (const chunk of response) {
        await stream.writeSSE(chunk)
        // Parse chunk for metrics
        try {
          const parsed = JSON.parse(chunk.data)
          if (!ttft && parsed.choices?.[0]?.delta?.content) {
            ttft = performance.now() - startTime
          }
          if (!resolvedModel && parsed.model) resolvedModel = parsed.model
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens
            outputTokens = parsed.usage.completion_tokens
          }
        } catch { /* metrics extraction is best-effort */ }
      }

      logRequest(_db, {
        id: requestId, path: "/v1/chat/completions",
        clientFormat: "openai", model, resolvedModel,
        stream: true, inputTokens, outputTokens, ttftMs: ttft,
        latencyMs: performance.now() - startTime,
        status: "success", statusCode: 200,
      })
    }, (err) => {
      // Stream-internal error — could be upstream disconnect, parse error, etc.
      const statusCode = err instanceof HTTPError ? err.response.status : 502
      logRequest(_db, {
        id: requestId, path: "/v1/chat/completions",
        clientFormat: "openai", model, stream: true,
        latencyMs: performance.now() - startTime,
        status: "error", statusCode,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    })
  } catch (error) {
    // Extract real status from HTTPError (e.g. 429 from rate limit, upstream 4xx/5xx)
    // Only fall back to 500 for truly unknown errors
    const statusCode = error instanceof HTTPError
      ? error.response.status    // preserves 429, 403, 502 etc.
      : 500                      // unknown error
    const upstreamStatus = error instanceof HTTPError
      ? error.response.status
      : undefined

    logRequest(_db, {
      id: requestId, path: "/v1/chat/completions",
      clientFormat: "openai", model, stream,
      latencyMs: performance.now() - startTime,
      status: "error", statusCode, upstreamStatus,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error  // let route.ts forwardError handle the response
  }
}
```

### 2.4 `feat: add logRequest hooks to messages handler`

Same pattern as 2.3 but with:
- `clientFormat: "anthropic"`
- `path: "/v1/messages"`
- Messages handler already does `JSON.parse(rawEvent.data)` at L75, so usage extraction is direct

### 2.5 `feat: wire db into handlers via createApp`

`setChatDb(db)` and `setMsgDb(db)` are called inside `createApp()` (see Core Design section above). No separate step needed — this happens as part of 2.1.

**Why module-level setter instead of passing db through Hono context?** copilot-api's handlers are plain functions `handleCompletion(c: Context)` — they only receive Hono's Context. We could add db to Hono's context variables, but that requires type augmentation across all files. The setter approach is minimal-invasive: one function call at boot, zero changes to handler signatures. It can be refactored to proper DI later (Phase 5).

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
| P1 | Logging (10 cases) | Rewrite | Test `logRequest()` at 4 exit points per handler |
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
| Refactor `setDb()` setter → proper DI via Hono context | M | Cleaner architecture |
| Refactor global `state` → injected dependency | L | Full testability |
| Add TTFT tracking to dashboard charts | M | New metric visibility |
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
| `routes/chat-completions/handler.ts` | `consola`, `approval`, ADD `logRequest` hooks | handler + logging |
| `routes/messages/handler.ts` | `consola`, `approval`, ADD `logRequest` hooks | handler + logging |
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
| `consola` | ✅ | ❌ | Drop — mechanical replace with console.* |
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

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Dashboard shows empty data | Logging hooks are in Phase 2 (MVP), not deferred. Verified in 3.2 + 3.4. |
| `db` not accessible in handlers | `createApp(deps)` factory wires `setDb()` at boot. |
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
  2.3  feat: add logRequest hooks to chat-completions handler
  2.4  feat: add logRequest hooks to messages handler
  2.5  feat: add health endpoint

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
2. **`consola.*` → `console.*`** — mechanical replacement, 14 files
3. **`awaitApproval()` calls** — delete entirely (2 handlers)
4. **`manualApprove` checks** — delete entirely (2 handlers)
5. **`tiny-invariant`** — inline `if (!x) throw` (likely zero occurrences in copied files)
6. **Add `logRequest()` hooks** — 2 handlers, 4 exit points each (see Phase 2.3/2.4)
7. **`server.ts` → `app.ts`** — singleton → factory with `AppDeps` (see Core Design)
8. **`lib/paths.ts`** — patch hardcoded `~/.local/share/copilot-api/` to use `RAVEN_TOKEN_PATH` (see "Data/Token Path Reconciliation")
