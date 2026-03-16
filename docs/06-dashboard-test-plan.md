# 06 — Dashboard Test Plan: Zero to Confidence

## Background

The dashboard package (`packages/dashboard`) is a Next.js 16 + NextAuth v5 app that serves as the management UI for the Raven proxy. It currently has **zero automated tests** — no test runner, no test dependencies, no test scripts in `package.json`.

### Architecture

```
Browser ──SSE/fetch──► Dashboard (Next.js :7032) ──fetch/WS──► Proxy (Hono :7033)
                          │
                          ├── proxy.ts          Auth enforcement (replaces middleware.ts)
                          ├── auth.ts           NextAuth v5 config (Google OAuth)
                          ├── lib/proxy.ts      proxyFetch / safeFetch helpers
                          ├── app/api/*         BFF route handlers (9 routes)
                          ├── hooks/            useLogStream (SSE client)
                          └── components/       RequestTable, ConnectContent, etc.
```

### Source file inventory (22 files with runtime logic)

| File | Lines | Category | Testability |
|------|-------|----------|-------------|
| `src/proxy.ts` | 42 | Auth middleware | Needs NextAuth mock |
| `src/auth.ts` | 101 | Auth config | Module-level side effects |
| `src/lib/proxy.ts` | 80 | Fetch helpers | Pure functions, easy |
| `src/lib/types.ts` | 169 | Types only | No runtime logic |
| `src/app/api/connection-info/route.ts` | 17 | BFF route | Easy — mock proxyFetch |
| `src/app/api/copilot/[...path]/route.ts` | 27 | BFF route | Easy |
| `src/app/api/keys/route.ts` | 32 | BFF route | Easy |
| `src/app/api/keys/[id]/route.ts` | 22 | BFF route | Easy |
| `src/app/api/keys/[id]/revoke/route.ts` | 22 | BFF route | Easy |
| `src/app/api/logs/stream/route.ts` | 112 | SSE bridge | Needs WS mock |
| `src/app/api/requests/route.ts` | 21 | BFF route | Easy |
| `src/app/api/stats/[...path]/route.ts` | 27 | BFF route | Easy |
| `src/hooks/use-log-stream.ts` | 190 | React hook | Needs EventSource mock |
| `src/components/requests/request-table.tsx` | 221 | React component | Needs router mock |
| `src/app/connect/connect-content.tsx` | 383 | React component | Needs fetch mock |
| `src/app/copilot/account/account-content.tsx` | 387 | React component | Needs fetch mock |
| `src/app/copilot/models/models-content.tsx` | 191 | React component | Needs fetch mock |

### Known bugs to fix during testing

1. **`connect-content.tsx` L199-206**: `handleAction` (revoke/delete key) ignores fetch errors — no user feedback on failure
2. **`account-content.tsx` L205-213**: `handleRefresh` ignores fetch errors — silent failure
3. **`models-content.tsx` L90-98**: `handleRefresh` ignores fetch errors — silent failure
4. **`models-content.tsx` L26**: `navigator.clipboard.writeText` has no catch — unhandled rejection in HTTP context

### Target

**90%+ line coverage on all non-UI-presentational files** (`lib/proxy.ts`, all BFF routes, `use-log-stream.ts`). Component tests focus on interaction logic (error handling, pagination, API calls), not visual rendering.

---

## Strategy

**Phase 1 — Infrastructure**: Set up Vitest + React Testing Library + MSW. No tests yet, just validate the toolchain.

**Phase 2 — Pure logic**: `lib/proxy.ts` (ProxyError, proxyFetch, safeFetch). Zero external dependencies.

**Phase 3 — BFF routes**: All 8 API route handlers. Mock `proxyFetch` via `vi.mock`.

**Phase 4 — SSE bridge**: `api/logs/stream/route.ts`. Mock WebSocket.

**Phase 5 — React hooks**: `use-log-stream.ts`. Mock EventSource.

**Phase 6 — Component interactions**: Error handling bugs in `connect-content.tsx`, `account-content.tsx`, `models-content.tsx`. Pagination logic in `request-table.tsx`.

**Phase 7 — Auth**: `proxy.ts` auth enforcement. Mock NextAuth `auth()`.

---

## Phase 1 — Test Infrastructure Setup

### Commit 1a: Install test dependencies

```bash
bun add -d vitest @testing-library/react @testing-library/jest-dom @vitejs/plugin-react jsdom
```

### Commit 1b: Configure Vitest

**New file:** `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
```

**New file:** `test/setup.ts`

```ts
import "@testing-library/jest-dom/vitest";
```

**Modify:** `package.json` — add `"test": "vitest run"`, `"test:watch": "vitest"`

### Commit 1c: Verify toolchain

**New file:** `test/smoke.test.ts`

```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("vitest runs", () => { expect(1 + 1).toBe(2); });
});
```

Run `bun run test` → confirm green.

---

## Phase 2 — Pure Logic: `lib/proxy.ts`

**New file:** `test/lib/proxy.test.ts`

**Source:** `src/lib/proxy.ts` (80 lines)

### ProxyError

```
- constructor sets name to "ProxyError"
- stores statusCode
- statusCode is undefined when not provided
```

### proxyFetch

Requires mocking `globalThis.fetch`. Module reads `PROXY_URL` and `API_KEY` from env at import time — use `vi.stubEnv` or set `process.env` before import.

```
describe("proxyFetch")
  - builds correct URL from PROXY_URL + path
  - includes Content-Type: application/json header
  - includes Authorization header when API_KEY is set
  - omits Authorization header when API_KEY is empty
  - merges caller-provided headers
  - sets cache: "no-store"
  - returns parsed JSON on 200 response
  - throws ProxyError with status code on non-ok response
  - throws ProxyError with statusText in message
  - forwards RequestInit options (method, body)
```

### safeFetch

```
describe("safeFetch")
  - returns { ok: true, data } on success
  - returns { ok: false, error: message } on ProxyError
  - returns { ok: false, error: message } on generic Error
  - returns { ok: false, error: "Unknown error..." } on non-Error throw
```

---

## Phase 3 — BFF Route Handlers

All 8 BFF routes share the same pattern:

```ts
try {
  const data = await proxyFetch<T>(path, init);
  return NextResponse.json(data, { status });
} catch (err) {
  const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
  const message = err instanceof Error ? err.message : "Failed to reach proxy";
  return NextResponse.json({ error: message }, { status });
}
```

Mock strategy: `vi.mock("@/lib/proxy")` to control `proxyFetch` return values.

### Commit 3a: Simple GET routes

**New file:** `test/api/simple-routes.test.ts`

Cover 4 routes with identical structure (success + ProxyError + generic Error):

| Route | Handler | Proxy path |
|-------|---------|-----------|
| `api/connection-info/route.ts` | `GET` | `/api/connection-info` |
| `api/requests/route.ts` | `GET` | `/api/requests` + query params |
| `api/copilot/[...path]/route.ts` | `GET` | `/api/copilot/{path}` + query params |
| `api/stats/[...path]/route.ts` | `GET` | `/api/stats/{path}` + query params |

Tests per route:
```
- success → returns JSON with 200
- ProxyError with statusCode → returns that status
- ProxyError without statusCode → returns 502
- generic Error → returns 502 with error message
```

Catch-all routes (`copilot`, `stats`) additionally test:
```
- joins path segments correctly (e.g., ["user"] → "user", ["models", "list"] → "models/list")
- forwards query parameters
```

Requests route additionally tests:
```
- forwards query params to proxy (cursor, limit, sort, order)
- empty query params → path without "?"
```

### Commit 3b: Keys routes (GET + POST + DELETE + revoke)

**New file:** `test/api/keys-routes.test.ts`

Cover 3 route files:

**`api/keys/route.ts`** — GET + POST:
```
describe("GET /api/keys")
  - success → returns key list as JSON
  - ProxyError → returns error status

describe("POST /api/keys")
  - success → returns 201 with created key data
  - forwards request body to proxyFetch
  - ProxyError → returns error status
```

**`api/keys/[id]/route.ts`** — DELETE:
```
describe("DELETE /api/keys/:id")
  - success → returns JSON
  - extracts id from params promise
  - ProxyError → returns error status
```

**`api/keys/[id]/revoke/route.ts`** — POST:
```
describe("POST /api/keys/:id/revoke")
  - success → returns JSON
  - extracts id from params promise
  - ProxyError → returns error status
```

---

## Phase 4 — SSE Bridge: `api/logs/stream/route.ts`

**New file:** `test/api/logs-stream.test.ts`

**Source:** `src/app/api/logs/stream/route.ts` (112 lines)

This is the most complex route — it creates a `ReadableStream` that bridges upstream WebSocket messages to SSE events. Requires a mock WebSocket.

### Mock strategy

Create a controllable `MockWebSocket` class:

```ts
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0; // CONNECTING
  close() { this.readyState = 3; }
}
```

Stub `globalThis.WebSocket` with a factory that returns the mock instance.

### Tests

```
describe("GET /api/logs/stream")
  describe("connection setup")
    - builds WebSocket URL with ws:// protocol from http:// PROXY_URL
    - builds WebSocket URL with wss:// protocol from https:// PROXY_URL
    - includes API_KEY as token query param
    - includes level query param (default: info)
    - includes requestId query param when provided
    - returns response with Content-Type: text/event-stream

  describe("SSE events")
    - onopen → emits "connected" SSE event
    - onmessage → emits "log" SSE event with message data
    - onerror → emits "error" SSE event
    - onclose → emits "disconnected" SSE event + closes stream

  describe("error handling")
    - WebSocket constructor throws → emits error event + closes stream
    - controller.enqueue throws in onerror → silently caught (L71-73)
    - controller.enqueue throws in onclose → silently caught (L84-86)

  describe("cleanup")
    - stream cancel → closes upstream WebSocket
    - stream cancel when WS already closed → no error
```

---

## Phase 5 — React Hook: `use-log-stream.ts`

**New file:** `test/hooks/use-log-stream.test.ts`

**Source:** `src/hooks/use-log-stream.ts` (190 lines)

### Mock strategy

Create a controllable `MockEventSource`:

```ts
class MockEventSource {
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  url: string;
  readyState = 0;
  close = vi.fn();

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  // Test helpers
  emit(type: string, data?: string) {
    for (const h of this.listeners[type] ?? []) {
      h(new MessageEvent(type, { data }));
    }
  }
}
```

Use `renderHook` from `@testing-library/react`.

### Tests

```
describe("useLogStream")
  describe("connection")
    - creates EventSource with correct URL params
    - includes level param
    - includes requestId param when provided
    - enabled=false → no EventSource created

  describe("events")
    - "connected" event → sets connected=true
    - "connected" event → resets reconnect counter
    - "log" event → appends to events array
    - "log" event with malformed JSON → ignored (no crash)
    - events capped at maxEvents (default 500)
    - events over maxEvents → keeps most recent

  describe("pause/resume")
    - setPaused(true) → buffers incoming events
    - setPaused(false) → flushes buffer into events
    - buffer flush respects maxEvents cap

  describe("reconnect")
    - "disconnected" event → closes EventSource + schedules reconnect
    - "error" event → closes EventSource + schedules reconnect
    - reconnect uses exponential backoff (1s, 2s, 4s, ..., 30s max)
    - duplicate reconnect guard (both "disconnected" and "error" → only one reconnect)
    - successful reconnect resets attempt counter

  describe("cleanup")
    - unmount → closes EventSource
    - unmount → clears reconnect timer
    - level change → reconnects with new URL

  describe("clear")
    - clear() → empties events array
    - clear() → empties pause buffer
```

---

## Phase 6 — Component Interactions

### Commit 6a: `connect-content.tsx` — API key management

**New file:** `test/components/connect-content.test.ts`

**Source:** `src/app/connect/connect-content.tsx` (383 lines)

Focus on `ApiKeysSection` and `CreateKeyDialog` interaction logic. Mock `fetch` and `useRouter`.

```
describe("ApiKeysSection")
  describe("handleAction — revoke")
    - calls POST /api/keys/{id}/revoke
    - calls router.refresh() on success
    - ⚠️ BUG: fetch failure → no error feedback (document current behavior)

  describe("handleAction — delete")
    - calls DELETE /api/keys/{id}
    - calls router.refresh() on success
    - ⚠️ BUG: fetch failure → no error feedback (document current behavior)

describe("CreateKeyDialog")
  - empty name → create button disabled
  - submit → calls POST /api/keys with name
  - success → shows created key for copy
  - res.ok=false → shows error message from response body
  - fetch throws → shows "Failed to create key"
  - ⚠️ BUG: error message reads `data.error?.message` but route returns `{ error: string }` not `{ error: { message: string } }` — mismatch at L317
```

### Commit 6b: `account-content.tsx` and `models-content.tsx` — refresh error handling

**New file:** `test/components/copilot-content.test.ts`

```
describe("AccountContent.handleRefresh")
  - calls GET /api/copilot/user?refresh=true
  - calls router.refresh() on success
  - ⚠️ BUG: fetch failure → no error feedback, only setIsRefreshing(false)

describe("CopilotModelsContent.handleRefresh")
  - calls GET /api/copilot/models?refresh=true
  - calls router.refresh() on success
  - ⚠️ BUG: fetch failure → no error feedback

describe("CopilotModelsContent.CopyButton")
  - ⚠️ BUG: navigator.clipboard.writeText throws → unhandled promise rejection
```

### Commit 6c: `request-table.tsx` — pagination and sorting

**New file:** `test/components/request-table.test.ts`

**Source:** `src/components/requests/request-table.tsx` (221 lines)

Mock `useRouter` and `useSearchParams`.

```
describe("formatTimestamp")
  - formats epoch ms to readable string

describe("formatLatency")
  - ms < 1000 → "123ms"
  - ms >= 1000 → "1.2s"

describe("formatTokens")
  - formats input/output with locale separators
  - null input/output → "0 / 0"

describe("toggleSort")
  - click same column → toggles order (desc↔asc)
  - click different column → sets new column + desc
  - clears cursor, offset, prevCursors

describe("pagination — cursor mode (sort=timestamp)")
  - next page → pushes current cursor to prevCursors, sets nextCursor
  - prev page → pops from prevCursors stack
  - prev page on first page → deletes cursor param
  - canGoPrev = true when cursor param exists

describe("pagination — offset mode (sort=latency_ms)")
  - next page → offset += limit
  - prev page → offset -= limit, min 0
  - offset=0 → deletes offset param
  - canGoPrev = true when offset > 0

describe("empty state")
  - data=[] → shows "No requests found"
```

---

## Phase 7 — Auth: `proxy.ts`

**New file:** `test/proxy.test.ts`

**Source:** `src/proxy.ts` (42 lines)

### Mock strategy

`proxy.ts` exports `default` as `auth(handler)` — the handler function receives `req` with an `auth` property. The easiest approach: extract the handler callback and test it directly by constructing mock request objects with/without `req.auth`.

Alternatively, mock `@/auth` module to return a pass-through `auth` wrapper, then import and call the default export.

### Tests

```
describe("proxy.ts auth enforcement")
  describe("/api/auth/* routes")
    - passes through regardless of auth state

  describe("/login")
    - unauthenticated → passes through
    - authenticated → redirects to /

  describe("/api/* routes (non-auth)")
    - unauthenticated → returns 401 JSON { error: "Unauthorized" }

  describe("page routes")
    - unauthenticated → redirects to /login
    - authenticated → passes through
```

---

## Bugs to Fix

These bugs should be fixed as part of the test commits that expose them.

### Bug 1: `connect-content.tsx` L199-206 — handleAction ignores errors

**Current code:**
```ts
const handleAction = useCallback(async (id: string, action: "revoke" | "delete") => {
  if (action === "revoke") {
    await fetch(`/api/keys/${id}/revoke`, { method: "POST" });
  } else {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
  }
  router.refresh();
}, [router]);
```

**Problem:** If fetch fails (network error) or returns non-2xx, user gets no feedback. The page refreshes and shows unchanged state, making it appear like the action worked when it didn't.

**Fix:** Add try/catch, check `res.ok`, show toast or inline error on failure.

### Bug 2: `connect-content.tsx` L317 — error message format mismatch

**Current code:**
```ts
setError(data.error?.message ?? "Failed to create key");
```

**Problem:** The BFF route at `api/keys/route.ts` L29 returns `{ error: message }` (string), not `{ error: { message: string } }` (object). So `data.error?.message` is always `undefined`, and the user always sees the generic "Failed to create key" instead of the actual proxy error message.

**Fix:** `setError(typeof data.error === "string" ? data.error : data.error?.message ?? "Failed to create key")`

### Bug 3: `account-content.tsx` L205-213 — handleRefresh ignores errors

Same pattern as Bug 1. `fetch` is not checked for errors.

**Fix:** Add try/catch with error feedback (toast or inline message).

### Bug 4: `models-content.tsx` L90-98 — handleRefresh ignores errors

Same as Bug 3.

### Bug 5: `models-content.tsx` L26 — clipboard.writeText unhandled rejection

**Current code:**
```ts
const handleCopy = useCallback(async () => {
  await navigator.clipboard.writeText(text);
  setCopied(true);
  setTimeout(() => setCopied(false), 1500);
}, [text]);
```

**Problem:** `navigator.clipboard.writeText` throws in HTTP (non-HTTPS) contexts or when Clipboard API is unavailable. The promise rejection is unhandled.

**Fix:** Wrap in try/catch. Consider fallback to `document.execCommand("copy")` or show error toast.

---

## Typecheck Stability

### Issue: `.next/types` in tsconfig includes

`tsconfig.json` includes `.next/types/**/*.ts` which contains generated route type definitions. These files only exist after `next build` or `next dev` and are not committed to git. Running `bun run typecheck` without a prior build may fail or produce inconsistent results.

**Fix:** Ensure `bun run typecheck` either:
1. Runs `next build` first (slow but correct), or
2. Excludes `.next/types` from typecheck (fast but loses route type safety), or
3. Documents that `bun run build` is a prerequisite for typecheck

---

## Test Infrastructure Notes

### Why Vitest (not Jest/Bun test)

- Next.js ecosystem alignment — `@testing-library/react` and `jsdom` integrate cleanly
- `vi.mock` supports ESM module mocking needed for `@/lib/proxy` and `@/auth`
- `vi.stubEnv` for controlling env vars that are read at module load time
- Path alias (`@/*`) support via Vite's `resolve.alias`

### Mocking patterns

| Target | Pattern | Reason |
|--------|---------|--------|
| `@/lib/proxy` | `vi.mock("@/lib/proxy")` | Control proxyFetch returns per test |
| `globalThis.fetch` | `vi.spyOn(globalThis, "fetch")` | Component-level fetch calls (handleAction, handleRefresh) |
| `next/navigation` | `vi.mock("next/navigation")` | Mock useRouter, useSearchParams |
| `@/auth` | `vi.mock("@/auth")` | Mock auth() wrapper for proxy.ts tests |
| `WebSocket` | `vi.stubGlobal("WebSocket", MockWebSocket)` | SSE bridge test |
| `EventSource` | `vi.stubGlobal("EventSource", MockEventSource)` | useLogStream test |
| `navigator.clipboard` | `vi.stubGlobal("navigator", ...)` | CopyButton tests |

### File structure

```
packages/dashboard/
├── test/
│   ├── setup.ts                        # Testing library matchers
│   ├── smoke.test.ts                   # Toolchain verification
│   ├── lib/
│   │   └── proxy.test.ts              # proxyFetch, safeFetch, ProxyError
│   ├── api/
│   │   ├── simple-routes.test.ts      # connection-info, requests, copilot, stats
│   │   ├── keys-routes.test.ts        # keys CRUD routes
│   │   └── logs-stream.test.ts        # SSE bridge
│   ├── hooks/
│   │   └── use-log-stream.test.ts     # SSE hook
│   ├── components/
│   │   ├── connect-content.test.ts    # API key management interactions
│   │   ├── copilot-content.test.ts    # Account + models refresh
│   │   └── request-table.test.ts      # Pagination + sorting
│   └── proxy.test.ts                  # Auth enforcement
└── vitest.config.ts
```

---

## Verification

```bash
bun run test             # all dashboard tests
bun run test -- --coverage  # with coverage report
bun run typecheck        # ensure no type regressions
```

Check:
1. All test files pass
2. `lib/proxy.ts` ≥ 95% line coverage
3. All BFF routes ≥ 90% line coverage
4. `use-log-stream.ts` ≥ 85% line coverage
5. Bug fixes verified by tests that previously demonstrated the broken behavior
