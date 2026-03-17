# Unified Auth Architecture — Design Doc

> **Status: Pending**

## Problem

The project currently has two independent auth concepts that are named confusingly and have security gaps:

1. **Dashboard "local mode"** (doc 08): When Google OAuth env vars are missing, dashboard skips Google login. This is correct and stays.

2. **Proxy "dev mode"** (doc 02): When neither `RAVEN_API_KEY` nor DB keys exist, proxy skips ALL authentication — any request without a Bearer token is allowed through. This is a security hole: a user who just wants to skip Google login (local mode) gets an unauthenticated proxy as a side effect, exposing their Copilot quota to the LAN.

Additionally, the no-prefix route aliases (`/chat/completions`, `/embeddings`) were not covered by the auth middleware path patterns (`/v1/*`, `/api/*`), bypassing authentication entirely. These aliases were removed in commit `931f472` but the user wants them restored with proper auth.

### Current auth matrix (broken)

| Route | Auth middleware | Dev mode bypass |
|-------|---------------|-----------------|
| `/v1/chat/completions` | ✅ `/v1/*` | ✅ if no keys |
| `/v1/messages` | ✅ `/v1/*` | ✅ if no keys |
| `/v1/models` | ✅ `/v1/*` | ✅ if no keys |
| `/v1/embeddings` | ✅ `/v1/*` | ✅ if no keys |
| `/chat/completions` | ❌ (removed) | N/A |
| `/embeddings` | ❌ (removed) | N/A |
| `/api/*` (dashboard) | ✅ `/api/*` | ✅ if no keys |
| `/health` | ❌ (intentional) | N/A |
| `/ws/logs` | ✅ (custom) | ✅ if no keys |

---

## Goal

Separate the two auth concerns cleanly:

- **Dashboard auth** (Google OAuth) controls "who can see the dashboard." Independent of proxy auth.
- **Proxy auth** (API keys) controls "who can use the Copilot API." No dev mode bypass — if no key is configured, AI API routes return 401.

---

## Design

### Two middleware functions, not one

Replace the single `multiKeyAuth` with two distinct middlewares:

#### 1. `apiKeyAuth` — for AI coding routes

Covers: `/v1/*`, `/chat/*`, `/embeddings`

**No dev mode.** Always requires a valid API key. Flow:

```
Request → Bearer token?
  ├─ No token → 401
  ├─ rk- prefix → DB hash lookup → match + not revoked → allow (keyName = key.name)
  │                                → no match → 401
  └─ other → RAVEN_API_KEY set? → timing-safe compare → match → allow (keyName = "env:default")
                                                       → no match → 401
             RAVEN_API_KEY unset? → 401
```

Key difference from current `multiKeyAuth`: **no dev mode bypass**. If you have zero keys configured (no `RAVEN_API_KEY`, no DB keys), all AI API requests get 401. This is intentional — you must create at least one key to use the proxy.

#### 2. `dashboardAuth` — for dashboard management routes

Covers: `/api/*`

**Keeps dev mode.** When neither `RAVEN_API_KEY` nor `RAVEN_INTERNAL_KEY` nor DB keys exist, dashboard management routes are accessible without auth. This enables the zero-config first-run experience where dashboard can talk to proxy without any key setup.

Flow:

```
Request → dev mode? (!envApiKey && !internalKey && DB empty)
  ├─ Yes → allow (keyName = "dev")
  └─ No → same Bearer token validation as apiKeyAuth
          (also accepts RAVEN_INTERNAL_KEY via timing-safe compare)
```

Rationale: Dashboard management routes (`/api/stats`, `/api/keys`, `/api/connection-info`, etc.) are accessed by the dashboard's server-side code via `proxyFetch()`. In local mode, the user hasn't configured any keys yet, and the dashboard needs to reach these endpoints to function (including the `/api/keys` endpoint used to create the first API key). Blocking these would make first-run impossible.

### Route → middleware mapping

```typescript
// AI coding routes — strict auth, no dev mode
const aiAuth = apiKeyAuth({ db, envApiKey: apiKey })
app.use("/v1/*", aiAuth)
app.use("/chat/*", aiAuth)
app.use("/embeddings", aiAuth)

// Dashboard management routes — allows dev mode for first-run
const mgmtAuth = dashboardAuth({ db, envApiKey: apiKey })
app.use("/api/*", mgmtAuth)
```

### Route aliases restored

```typescript
app.route("/v1/chat/completions", completionRoutes)
app.route("/chat/completions", completionRoutes)     // alias, covered by /chat/*
app.route("/v1/messages", messageRoutes)
app.route("/v1/models", modelRoutes)
app.route("/v1/embeddings", embeddingRoutes)
app.route("/embeddings", embeddingRoutes)             // alias, covered by /embeddings
```

### WebSocket auth updated

`authenticateWs` in `index.ts` follows the same strict logic as `apiKeyAuth` — no dev mode bypass for the log stream either. Dashboard accesses logs via its own SSE bridge (`/api/logs/stream`), which goes through `dashboardAuth`.

Wait — actually the dashboard's log stream SSE bridge hits the proxy's WebSocket at `/ws/logs`. If we remove dev mode from WS auth, the dashboard can't stream logs without a key. Two options:

**Option A:** Keep dev mode for WS auth (same as dashboardAuth). The WS endpoint is a monitoring/management concern, not an AI API.

**Option B:** Route dashboard log streaming through `/api/*` path so it falls under dashboardAuth.

**Decision: Option A.** The WebSocket log stream is a dashboard management feature, not an AI API. It should follow the same dev mode rules as `/api/*`. The `authenticateWs` function already mirrors `multiKeyAuth` — just keep its dev mode intact.

---

## New auth matrix

| Route | Middleware | Dev mode | First-run (no keys) |
|-------|-----------|----------|---------------------|
| `/v1/chat/completions` | `apiKeyAuth` | ❌ | 401 |
| `/chat/completions` | `apiKeyAuth` | ❌ | 401 |
| `/v1/messages` | `apiKeyAuth` | ❌ | 401 |
| `/v1/models` | `apiKeyAuth` | ❌ | 401 |
| `/v1/embeddings` | `apiKeyAuth` | ❌ | 401 |
| `/embeddings` | `apiKeyAuth` | ❌ | 401 |
| `/api/*` (dashboard) | `dashboardAuth` | ✅ | allowed |
| `/health` | none | — | allowed |
| `/ws/logs` | custom (dev mode) | ✅ | allowed |

---

## First-run UX

With this design, the first-run experience becomes:

1. `bun run dev` — proxy + dashboard start
2. GitHub Device Flow — user authorizes in browser
3. Dashboard opens at `:7032` — all pages load (dashboard local mode + proxy dev mode for `/api/*`)
4. User goes to Connect page → creates first API key via dashboard UI
5. User configures Claude Code: `claude config set --global apiUrl http://localhost:7033/v1` and sets the API key
6. AI API requests now work with the key

**Before step 4, AI API requests return 401.** This is the correct behavior — the user should explicitly create a key before external tools can consume their Copilot quota.

---

## Interaction with doc 08 (Dashboard Local Mode)

Doc 08's scope is **dashboard-only** — it controls Google OAuth for the Next.js dashboard. This doc (09) is **proxy-only** — it controls API key auth for the Hono proxy.

The two are fully independent:

| | Dashboard Local Mode (doc 08) | Proxy Auth (doc 09) |
|---|---|---|
| What it controls | Google login for dashboard UI | API key for proxy endpoints |
| Condition | Missing Google OAuth env vars | `RAVEN_API_KEY` and/or DB keys |
| Effect when disabled | Skip Google login, all pages open | N/A (always enforced for AI routes) |
| Effect when enabled | Require Google sign-in | Require Bearer token |

A user can have:
- Local mode ON + no API keys → dashboard works, AI API returns 401
- Local mode ON + API key configured → dashboard works, AI API works with key
- Local mode OFF (Google OAuth) + API key → must login to see dashboard, must have key for AI API

---

## Files to modify

| File | Change |
|------|--------|
| `packages/proxy/src/middleware.ts` | Split `multiKeyAuth` into `apiKeyAuth` + `dashboardAuth` |
| `packages/proxy/src/app.ts` | Use `apiKeyAuth` for `/v1/*`, `/chat/*`, `/embeddings`; `dashboardAuth` for `/api/*`; restore aliases |
| `packages/proxy/src/index.ts` | Keep `authenticateWs` dev mode (dashboard management feature) |
| `packages/proxy/test/middleware.test.ts` | Update tests for split middleware |

## Files NOT changed

| File | Why |
|------|-----|
| `packages/dashboard/src/auth.ts` | Dashboard auth is unchanged (doc 08) |
| `packages/dashboard/src/proxy.ts` | Still uses `RAVEN_INTERNAL_KEY ?? RAVEN_API_KEY` for `/api/*` |
| `packages/proxy/src/db/keys.ts` | Key storage/validation unchanged |
| `packages/proxy/src/routes/*` | Route handlers unchanged |

---

## Atomic commits

| # | Commit | Files |
|---|--------|-------|
| 1 | `refactor: split multiKeyAuth into apiKeyAuth and dashboardAuth` | `middleware.ts` |
| 2 | `feat: enforce strict api key auth on all AI routes` | `app.ts` |
| 3 | `test: update middleware tests for split auth` | `middleware.test.ts` |

---

## Test plan

### `middleware.test.ts` — apiKeyAuth

| Test | Assertion |
|------|-----------|
| No keys configured → 401 | No dev mode bypass |
| No Authorization header → 401 | Even when no keys exist |
| Valid `RAVEN_API_KEY` → 200 | keyName = "env:default" |
| Valid DB key (rk-) → 200 | keyName = key.name |
| Invalid rk- key → 401 | No fallback to env |
| Revoked DB key → 401 | |
| Wrong env key → 401 | |
| Both env + DB key: each works independently | |

### `middleware.test.ts` — dashboardAuth

| Test | Assertion |
|------|-----------|
| No keys configured → 200 (dev mode) | keyName = "dev" |
| `RAVEN_API_KEY` set → requires Bearer | |
| DB key exists → requires Bearer | |
| Valid env key → 200 | |
| Valid DB key → 200 | |

### `app.ts` integration

| Test | Assertion |
|------|-----------|
| `/v1/chat/completions` without key → 401 | Even when no keys configured |
| `/chat/completions` without key → 401 | Alias has same auth |
| `/embeddings` without key → 401 | Alias has same auth |
| `/api/stats/overview` without key → 200 | Dev mode for dashboard |
| `/health` without key → 200 | No auth |

### Existing tests

All existing `middleware.test.ts` tests for the env key and DB key paths should continue passing — the validation logic is the same, only the dev mode behavior diverges between the two middlewares.

---

## Doc updates after implementation

- **Doc 02** (Key Management): Update section 二 to reference `apiKeyAuth` + `dashboardAuth` instead of single `multiKeyAuth`. Remove "Dev mode" from the AI auth flow.
- **README**: Update first-run guide to mention that an API key must be created before AI tools can connect.
</content>
</invoke>