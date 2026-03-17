# Unified Auth Architecture — Design Doc

> **Status: Pending**

## Problem

The project currently has two independent auth concepts that are named confusingly and have security gaps:

1. **Dashboard "local mode"** (doc 08): When Google OAuth env vars are missing, dashboard skips Google login. This is correct and stays.

2. **Proxy "dev mode"** (doc 02): When neither `RAVEN_API_KEY` nor DB keys exist, proxy skips ALL authentication — any request without a Bearer token is allowed through. This is a security hole: a user who just wants to skip Google login (local mode) gets an unauthenticated proxy as a side effect, exposing their Copilot quota to the LAN.

Additionally, the no-prefix route aliases (`/chat/completions`, `/embeddings`) were not covered by the auth middleware path patterns (`/v1/*`, `/api/*`), bypassing authentication entirely. These aliases were removed in commit `931f472` but should be restored with proper auth.

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

### Two keys, two purposes

| Key | Purpose | Who sends it | Accepted by |
|-----|---------|-------------|-------------|
| `RAVEN_API_KEY` | External client auth | Claude Code, Cursor, etc. | `apiKeyAuth` + `dashboardAuth` |
| `RAVEN_INTERNAL_KEY` | Dashboard → Proxy management channel | Dashboard server-side `proxyFetch()` | `dashboardAuth` + `/ws/logs` only |
| DB key (`rk-*`) | Per-client auth (managed via dashboard) | External clients | `apiKeyAuth` + `dashboardAuth` |

**Why `RAVEN_INTERNAL_KEY` must exist:**

Dashboard's BFF layer (`proxyFetch()`) needs a stable server-side credential to call proxy management endpoints (`/api/stats`, `/api/keys`, etc.). This credential cannot be a DB key because:
- DB keys are created *through* the dashboard — circular dependency on first key creation
- DB keys are meant for external clients, not internal infrastructure
- After the user creates their first DB key, `dashboardAuth` exits dev mode and requires a Bearer token — without `RAVEN_INTERNAL_KEY`, the dashboard immediately locks itself out

`RAVEN_INTERNAL_KEY` is never accepted by `apiKeyAuth` — it cannot be used to call AI API routes (`/v1/messages`, `/v1/chat/completions`, etc.). This separation ensures that the management credential cannot be used to consume Copilot quota.

**Proxy-side support:** Proxy loads `RAVEN_INTERNAL_KEY` from env in `config.ts`. `dashboardAuth` and `authenticateWs` accept it via timing-safe compare. `apiKeyAuth` does not.

```typescript
// packages/proxy/src/config.ts
export interface Config {
  port: number;
  apiKey: string;
  internalKey: string;
  tokenPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  baseUrl: string;
}

export function loadConfig(): Config {
  // ...
  const internalKey = process.env.RAVEN_INTERNAL_KEY ?? "";
  return { port, apiKey, internalKey, tokenPath, logLevel, baseUrl };
}
```

Dashboard side is unchanged — it already prefers `RAVEN_INTERNAL_KEY`:

```typescript
// packages/dashboard/src/lib/proxy.ts (existing, no change)
const API_KEY = process.env.RAVEN_INTERNAL_KEY ?? process.env.RAVEN_API_KEY ?? "";
```

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

**`RAVEN_INTERNAL_KEY` is NOT accepted here.** The management credential cannot consume Copilot quota.

Key difference from current `multiKeyAuth`: **no dev mode bypass**. If you have zero keys configured (no `RAVEN_API_KEY`, no DB keys), all AI API requests get 401. This is intentional — you must create at least one key to use the proxy.

#### 2. `dashboardAuth` — for dashboard management routes

Covers: `/api/*`

**Keeps dev mode for first-run bootstrap.** Dev mode activates when ALL of the following are true:
- `RAVEN_API_KEY` is not set
- `RAVEN_INTERNAL_KEY` is not set
- No **active** (non-revoked) DB keys exist

Flow:

```
Request → dev mode? (!envApiKey && !internalKey && no active DB keys)
  ├─ Yes → allow (keyName = "dev")
  └─ No → Bearer token?
           ├─ No token → 401
           ├─ rk- prefix → DB hash lookup → match + not revoked → allow
           └─ other → timing-safe compare vs RAVEN_API_KEY → match → allow (keyName = "env:default")
                       timing-safe compare vs RAVEN_INTERNAL_KEY → match → allow (keyName = "internal")
                       neither → 401
```

Rationale: Dashboard management routes (`/api/stats`, `/api/keys`, `/api/connection-info`, etc.) are accessed by the dashboard's server-side code via `proxyFetch()`. In local mode, the user hasn't configured any keys yet, and the dashboard needs to reach these endpoints to function (including the `/api/keys` endpoint used to create the first API key). Blocking these would make first-run impossible.

**First-run → first DB key transition:**

1. No env keys, no DB keys → dev mode active → dashboard works without Bearer
2. User creates first DB key via dashboard → active key count becomes > 0
3. `dashboardAuth` exits dev mode → requires Bearer
4. Dashboard's `proxyFetch()` sends `RAVEN_INTERNAL_KEY` as Bearer → **still works** if `RAVEN_INTERNAL_KEY` is set
5. If `RAVEN_INTERNAL_KEY` is also unset → dashboard loses access to `/api/*`

This means: **setting `RAVEN_INTERNAL_KEY` is required before creating the first DB key**, unless `RAVEN_API_KEY` is already set. The first-run guide must document this.

**Anti-lockout: "no active keys" not "DB empty".**

The current `getKeyCount()` counts ALL keys including revoked ones (`SELECT COUNT(*) FROM api_keys`). If a user has no env key and only revoked DB keys, the current logic sees `count > 0` → requires auth, but no valid key exists → dashboard is locked out.

Fix: Add `getActiveKeyCount()` that excludes revoked keys:

```sql
SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL
```

Dev mode condition uses `getActiveKeyCount(db) === 0` instead of `getKeyCount(db) === 0`. This ensures:
- All keys revoked + no env keys → dev mode re-activates → user can create a new key via dashboard
- At least one active key or env key → auth required

### Route → middleware mapping

```typescript
// AI coding routes — strict auth, no dev mode
const aiAuth = apiKeyAuth({ db, envApiKey: apiKey })
app.use("/v1/*", aiAuth)
app.use("/chat/*", aiAuth)
app.use("/embeddings", aiAuth)

// Dashboard management routes — allows dev mode for first-run
const mgmtAuth = dashboardAuth({ db, envApiKey: apiKey, internalKey })
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

### WebSocket auth

The WebSocket log stream at `/ws/logs` is a dashboard management feature, not an AI API. It follows the same dev mode rules as `dashboardAuth`:
- No keys configured → allow (dev mode)
- Keys configured → require valid token via query parameter
- Accepts `RAVEN_INTERNAL_KEY` and `RAVEN_API_KEY`

The `authenticateWs` function in `index.ts` is updated to use `getActiveKeyCount()` and accept `RAVEN_INTERNAL_KEY`.

---

## New auth matrix

| Route | Middleware | Dev mode | Accepts `RAVEN_API_KEY` | Accepts `RAVEN_INTERNAL_KEY` | Accepts DB key |
|-------|-----------|----------|------------------------|-----------------------------|-|
| `/v1/chat/completions` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/chat/completions` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/v1/messages` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/v1/models` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/v1/embeddings` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/embeddings` | `apiKeyAuth` | ❌ | ✅ | ❌ | ✅ |
| `/api/*` (dashboard) | `dashboardAuth` | ✅ | ✅ | ✅ | ✅ |
| `/health` | none | — | — | — | — |
| `/ws/logs` | custom | ✅ | ✅ | ✅ | ✅ |

---

## First-run UX

### Zero-config path (no env keys)

1. `bun run dev` — proxy + dashboard start
2. GitHub Device Flow — user authorizes in browser
3. Dashboard opens at `:7032` — all pages load (dashboard local mode + proxy dev mode for `/api/*`)
4. AI API requests return 401 — no key configured yet
5. User goes to Connect page → creates first DB key
6. ⚠️ Dashboard management requests now also return 401 (dev mode exited, no `RAVEN_INTERNAL_KEY`)
7. User must set `RAVEN_INTERNAL_KEY` in dashboard `.env.local` and restart, or set `RAVEN_API_KEY` in proxy `.env.local`

### Recommended path (set env keys first)

1. Set `RAVEN_API_KEY` in proxy `.env.local` (or set both `RAVEN_API_KEY` and `RAVEN_INTERNAL_KEY`)
2. Set `RAVEN_API_KEY` (or `RAVEN_INTERNAL_KEY`) in dashboard `.env.local`
3. `bun run dev` — proxy + dashboard start
4. GitHub Device Flow — user authorizes in browser
5. Dashboard works immediately (dashboard sends env key to proxy)
6. User can optionally create DB keys for per-client attribution
7. Configure Claude Code with `RAVEN_API_KEY` or a DB key

**The README first-run guide should recommend the "set env keys first" path.**

---

## Interaction with doc 08 (Dashboard Local Mode)

Doc 08's scope is **dashboard-only** — it controls Google OAuth for the Next.js dashboard. This doc (09) is **proxy-only** — it controls API key auth for the Hono proxy.

The two are fully independent:

| | Dashboard Local Mode (doc 08) | Proxy Auth (doc 09) |
|---|---|---|
| What it controls | Google login for dashboard UI | API key for proxy endpoints |
| Condition | Missing Google OAuth env vars | `RAVEN_API_KEY`, `RAVEN_INTERNAL_KEY`, and/or DB keys |
| Effect when disabled | Skip Google login, all pages open | N/A (always enforced for AI routes) |
| Effect when enabled | Require Google sign-in | Require Bearer token |

A user can have:
- Local mode ON + no API keys → dashboard works (dev mode), AI API returns 401
- Local mode ON + API key configured → dashboard works, AI API works with key
- Local mode OFF (Google OAuth) + API key → must login to see dashboard, must have key for AI API

---

## Files to modify

| File | Change |
|------|--------|
| `packages/proxy/src/config.ts` | Add `internalKey` field, load `RAVEN_INTERNAL_KEY` from env |
| `packages/proxy/src/middleware.ts` | Split `multiKeyAuth` into `apiKeyAuth` + `dashboardAuth`; use `getActiveKeyCount` |
| `packages/proxy/src/db/keys.ts` | Add `getActiveKeyCount()` (excludes revoked keys) |
| `packages/proxy/src/app.ts` | Use `apiKeyAuth` for `/v1/*`, `/chat/*`, `/embeddings`; `dashboardAuth` for `/api/*`; restore aliases; pass `internalKey` |
| `packages/proxy/src/index.ts` | Update `authenticateWs` to use `getActiveKeyCount()` and accept `RAVEN_INTERNAL_KEY` |
| `packages/proxy/test/middleware.test.ts` | Update/add tests for split middleware |
| `packages/proxy/test/app.test.ts` | Update `"no apiKey and no DB keys → open access"` to test split behavior; add alias auth tests |

## Files NOT changed

| File | Why |
|------|-----|
| `packages/dashboard/src/auth.ts` | Dashboard auth is unchanged (doc 08) |
| `packages/dashboard/src/lib/proxy.ts` | Already sends `RAVEN_INTERNAL_KEY ?? RAVEN_API_KEY`, no change needed |
| `packages/proxy/src/routes/*` | Route handlers unchanged |

---

## Atomic commits

| # | Commit | Files |
|---|--------|-------|
| 1 | `feat: add RAVEN_INTERNAL_KEY to proxy config` | `config.ts` |
| 2 | `feat: add getActiveKeyCount for anti-lockout` | `db/keys.ts` |
| 3 | `refactor: split multiKeyAuth into apiKeyAuth and dashboardAuth` | `middleware.ts` |
| 4 | `feat: enforce strict auth on AI routes, restore aliases` | `app.ts`, `index.ts` |
| 5 | `test: update auth tests for split middleware and aliases` | `middleware.test.ts`, `app.test.ts` |

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
| `RAVEN_INTERNAL_KEY` → 401 | Internal key rejected by AI auth |
| Both env + DB key: each works independently | |

### `middleware.test.ts` — dashboardAuth

| Test | Assertion |
|------|-----------|
| No keys configured → 200 (dev mode) | keyName = "dev" |
| Only revoked DB keys → 200 (dev mode) | Anti-lockout: revoked keys don't count |
| `RAVEN_API_KEY` set → requires Bearer | Dev mode disabled |
| `RAVEN_INTERNAL_KEY` set → requires Bearer | Dev mode disabled |
| Active DB key exists → requires Bearer (no dev mode) | |
| Valid `RAVEN_API_KEY` → 200 | keyName = "env:default" |
| Valid `RAVEN_INTERNAL_KEY` → 200 | keyName = "internal" |
| Valid DB key → 200 | |

### `app.test.ts` — route integration

| Test | Assertion |
|------|-----------|
| `/v1/chat/completions` without key → 401 | Even when no keys configured |
| `/chat/completions` without key → 401 | Alias has same auth |
| `/v1/messages` without key → 401 | Same |
| `/v1/models` without key → 401 | Same |
| `/embeddings` without key → 401 | Alias has same auth |
| `/api/stats/overview` without key → 200 | Dev mode for dashboard |
| `/health` without key → 200 | No auth |
| `/v1/models` with env key → non-401 | AI route accepts env key |
| `/chat/completions` with DB key → non-401 | Alias accepts DB key |
| `/v1/models` with internal key → 401 | AI route rejects internal key |
| `/api/stats/overview` with internal key → 200 | Dashboard route accepts internal key |
| Update existing `"no apiKey and no DB keys → open access"` | Split into: `/api/*` open (dev mode), `/v1/*` returns 401 |

### Existing tests

All existing `middleware.test.ts` tests for the env key and DB key paths should continue passing — the validation logic is the same, only the dev mode behavior diverges between the two middlewares.

---

## Doc updates after implementation

The following documents reference the old `multiKeyAuth` or "dev mode" semantics and must be updated:

| Document | Section | Required change |
|----------|---------|-----------------|
| `docs/02-key-management.md` | Section 二 "验证流程" (line 78-88) | Replace `multiKeyAuth` three-path flow with `apiKeyAuth` + `dashboardAuth`. Remove "Dev mode" from AI auth path. Add `RAVEN_INTERNAL_KEY` to dashboard auth path. |
| `docs/02-key-management.md` | Section 五 "Proxy 通信" (line 149) | Note that proxy now natively loads `RAVEN_INTERNAL_KEY`. |
| `docs/02-key-management.md` | Section 六 "向后兼容" (line 293) | Remove "Dev mode 逻辑：env 为空且 DB 无 key → 跳过 auth" — this no longer applies to AI routes. |
| `docs/03-unified-logging.md` | WS auth section (line 313-317) | Update "WS 鉴权复用 multiKeyAuth 相同语义" to reference `dashboardAuth` semantics. Replace "DB 无 key" with "no active keys". Add `RAVEN_INTERNAL_KEY` acceptance. |
| `README.md` | Proxy env vars table | Update `RAVEN_API_KEY` description from "空 = 跳过" to "AI API 认证，空 = 需通过 dashboard 创建 DB key". Add `RAVEN_INTERNAL_KEY` row to proxy table. |
| `README.md` | First-run guide | Recommend setting `RAVEN_API_KEY` before `bun run dev`. Add step: "创建 API key" before configuring Claude Code. |
| `packages/proxy/.env.example` | `RAVEN_API_KEY` comment | Remove "Leave empty to skip auth" language. Add `RAVEN_INTERNAL_KEY` entry. |
| `packages/dashboard/.env.example` | `RAVEN_INTERNAL_KEY` comment (line 38) | Update from "Must match a key registered in the proxy" to "Proxy reads this natively as a dashboard management credential." |
