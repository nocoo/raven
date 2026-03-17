# Local Auth Mode — Design Doc

## Overview

The dashboard hard-requires Google OAuth (3 mandatory env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`). Without all three, the dashboard either crashes at import time (`process.env.GOOGLE_CLIENT_ID!` → `undefined` passed to Google provider) or produces broken auth flows. This makes it impossible for new users to run the dashboard locally without first creating Google Cloud OAuth credentials.

Raven is a personal-use, local-run project. Requiring OAuth for localhost access is unnecessary friction.

**Goal:** When Google OAuth is not fully configured, the dashboard runs in **local mode** — no authentication, all pages directly accessible, zero configuration required.

---

## 1. Auth Mode Detection

### New file: `packages/dashboard/src/lib/auth-mode.ts`

Server/shared helper that evaluates whether auth is fully configured. Reads secret env vars, so **must not be imported from client components**.

```typescript
// Server-only flag — true when all 3 required OAuth vars are present.
// Client components must NOT import this file.
// Use NEXT_PUBLIC_AUTH_ENABLED (injected via next.config.ts) instead.
export const isAuthEnabled =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.NEXTAUTH_SECRET
```

### Client-side exposure: `packages/dashboard/next.config.ts`

```typescript
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_AUTH_ENABLED:
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.NEXTAUTH_SECRET
        ? "1"
        : "",
  },
  // ... existing config ...
}
```

Client components read `process.env.NEXT_PUBLIC_AUTH_ENABLED` — a simple truthy/falsy string baked in at build/dev time.

---

## 2. Auth Module — Always Export All Symbols

### File: `packages/dashboard/src/auth.ts`

**Constraint:** ESM requires all named exports to be statically present. `proxy.ts` does `import { auth } from "@/auth"` — `auth` must always be exported, in both modes. Existing tests also import and inspect these exports.

**Design:** `auth.ts` always exports `{ handlers, signIn, signOut, auth }`. In local mode, these are compatible stubs — not `null`, not omitted.

```typescript
import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { isAuthEnabled } from "@/lib/auth-mode"

if (!isAuthEnabled) {
  console.info(
    "[auth] Local mode — authentication disabled. " +
    "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and NEXTAUTH_SECRET to enable."
  )
}

// ---------------------------------------------------------------------------
// Local mode stubs
// ---------------------------------------------------------------------------

// auth() stub: compatible with NextAuth middleware wrapper signature.
// Accepts a handler function, returns a new function that calls the handler
// with a fake request object (req.auth = null).
function localAuth(handler: (req: any) => any) {
  return (req: any) => handler({ ...req, auth: null })
}

const localHandlers = {
  GET: () => new Response(JSON.stringify({ mode: "local" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
  POST: () => new Response(JSON.stringify({ mode: "local" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
}

// ---------------------------------------------------------------------------
// Conditional init
// ---------------------------------------------------------------------------

const authExports = isAuthEnabled
  ? NextAuth({
      trustHost: true,
      providers: [
        Google({
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
      ],
      pages: { signIn: "/login", error: "/login" },
      cookies: { /* ... existing cookie config, unchanged ... */ },
      callbacks: {
        async signIn({ user }) {
          /* ... existing allowedEmails logic, unchanged ... */
        },
      },
    })
  : {
      handlers: localHandlers,
      signIn: async () => "/",
      signOut: async () => "/",
      auth: localAuth,
    }

export const { handlers, signIn, signOut, auth } = authExports
export { isAuthEnabled }
```

**Key points:**

- `auth` is always exported — in local mode it's `localAuth`, a function that wraps a handler just like the real `auth()` does, but injects `req.auth = null`.
- `handlers.GET/POST` return 200 with `{ mode: "local" }` so `SessionProvider`'s `/api/auth/session` fetch gets a clean JSON response (not 404).
- `isAuthEnabled` re-exported from `auth.ts` for server-side consumers (e.g., `proxy.ts`) that already import from `@/auth`.

---

## 3. Middleware — Static Import, Internal Branch

### File: `packages/dashboard/src/proxy.ts`

**No `require()`.** Static ESM import only. Since `auth.ts` always exports a compatible `auth` function, `proxy.ts` always uses `auth()` as wrapper — the branching happens inside `auth.ts`, not here.

```typescript
// Next.js 16 proxy convention (replaces middleware.ts)
// Single enforcement point for authentication.

import { auth, isAuthEnabled } from "@/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  // Local mode: pass everything through
  if (!isAuthEnabled) return NextResponse.next()

  const { pathname } = req.nextUrl

  // Allow auth flow routes
  if (pathname.startsWith("/api/auth")) return NextResponse.next()

  // Allow login page
  if (pathname === "/login") {
    if (req.auth) return NextResponse.redirect(new URL("/", req.url))
    return NextResponse.next()
  }

  // Protect everything else
  if (!req.auth) {
    if (pathname.startsWith("/api/"))
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    return NextResponse.redirect(new URL("/login", req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
}
```

The `auth()` wrapper call works in both modes — real NextAuth middleware in auth mode, passthrough wrapper in local mode. The `if (!isAuthEnabled)` guard inside the handler is belt-and-suspenders for the local path.

---

## 4. AuthProvider — Keep SessionProvider, Safe Endpoint

### File: `packages/dashboard/src/components/auth-provider.tsx`

**Design choice:** Keep `SessionProvider` in both modes. Removing it would break `useSession()` calls in `sidebar.tsx` (and potentially other future consumers) — `useSession()` without a provider throws or returns unpredictable results depending on the NextAuth version.

```typescript
"use client"

import { SessionProvider } from "next-auth/react"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
```

**No changes to this file.** The safety comes from section 2: in local mode, `handlers.GET` returns `{ mode: "local" }` (status 200, valid JSON). When `SessionProvider` fetches `/api/auth/session`, it gets this response. Since it doesn't contain a `user` property, `useSession()` returns `{ data: null, status: "unauthenticated" }` — which is exactly the clean empty state that existing optional chaining handles.

---

## 5. Sidebar — No useSession in Local Mode

### File: `packages/dashboard/src/components/layout/sidebar.tsx`

In local mode, `useSession()` returns `{ data: null, status: "unauthenticated" }` (safe, per section 4). But we still want different display values and no sign-out button.

**Read `NEXT_PUBLIC_AUTH_ENABLED` (client-safe):**

```typescript
const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED
```

**Inside component:**

```typescript
const { data: session } = useSession()

// Display values
const userName = isAuthEnabled ? (session?.user?.name ?? "User") : "Local"
const userEmail = isAuthEnabled ? (session?.user?.email ?? "") : "Local mode"
const userImage = isAuthEnabled ? session?.user?.image : undefined
const userInitial = userName[0] ?? "?"
```

**Collapsed view:** In local mode, avatar is static (no `onClick` to `signOut`).

**Expanded view:** In local mode, hide the `<LogOut>` icon button.

```tsx
{/* Sign-out — only when auth is enabled */}
{isAuthEnabled && (
  <Tooltip>
    <TooltipTrigger asChild>
      <button onClick={() => signOut({ callbackUrl: "/login" })} ...>
        <LogOut ... />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top">Sign out</TooltipContent>
  </Tooltip>
)}
```

---

## 6. Login Page — Redirect in Local Mode

### File: `packages/dashboard/src/app/login/page.tsx`

In local mode, `/login` should redirect to `/` — not show a broken Google sign-in button.

```typescript
"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED

function LoginContent() {
  const router = useRouter()

  // Local mode: redirect home immediately
  useEffect(() => {
    if (!isAuthEnabled) router.replace("/")
  }, [router])

  if (!isAuthEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Redirecting…</p>
      </div>
    )
  }

  // ... existing login UI (badge card, Google button, etc.) unchanged ...
}
```

---

## 7. .env.example Update

### File: `packages/dashboard/.env.example`

Add local mode explanation at top:

```
# --- Local mode ---
# If GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and NEXTAUTH_SECRET are all unset,
# the dashboard runs without authentication — suitable for local-only usage.
```

Update variable descriptions: `(required for Google OAuth, not needed for local mode)`.

---

## 8. README Update

### File: `README.md`

In "设置 > Dashboard" section:

1. Add quick-start note:
   > **本地快速启动**：如果只是本地使用，Dashboard 无需额外配置。`bun run dev` 即可同时启动 proxy 和 dashboard，dashboard 自动以 local 模式运行（无需登录）。

2. Wrap existing 6-step Google OAuth guide under sub-heading "（可选）启用 Google OAuth 认证"

3. Update env var table: mark `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET` as `(启用 Google OAuth 时必填)`.

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/dashboard/src/lib/auth-mode.ts` | **New** — server/shared `isAuthEnabled` flag |
| `packages/dashboard/src/auth.ts` | Guard `NextAuth()` init; always export compatible stubs |
| `packages/dashboard/src/proxy.ts` | Add `isAuthEnabled` early-return, keep static import |
| `packages/dashboard/src/app/login/page.tsx` | Redirect to `/` in local mode |
| `packages/dashboard/src/components/layout/sidebar.tsx` | "Local" display, hide sign-out |
| `packages/dashboard/next.config.ts` | Inject `NEXT_PUBLIC_AUTH_ENABLED` |
| `packages/dashboard/.env.example` | Document local mode |
| `README.md` | Quick-start note, optional OAuth section |

## Files NOT Changed

| File | Why |
|------|-----|
| `packages/dashboard/src/components/auth-provider.tsx` | SessionProvider kept in both modes; local mode handlers return safe JSON |
| `packages/proxy/src/index.ts` | SQLite auto-init already works: `mkdirSync` + `new Database()` + `CREATE TABLE IF NOT EXISTS` |
| `packages/proxy/src/lib/paths.ts` | `ensurePaths()` already handles first-run directory/file creation |

---

## Atomic Commits

1. `feat: add auth-mode flag and conditional NextAuth init` — `auth-mode.ts`, `auth.ts`, `next.config.ts`
2. `feat: local mode middleware passthrough` — `proxy.ts`
3. `feat: login redirect and sidebar local mode display` — `login/page.tsx`, `sidebar.tsx`
4. `docs: document local auth mode in env example and readme` — `.env.example`, `README.md`
5. `test: add local auth mode test coverage` — test files

---

## Test Plan

### New tests to add

#### `packages/dashboard/test/auth-mode.test.ts`

| Test | Assertion |
|------|-----------|
| All 3 vars set → `isAuthEnabled = true` | `stubEnv` all 3, import, assert true |
| Missing `GOOGLE_CLIENT_ID` → `false` | Stub other 2 only |
| Missing `GOOGLE_CLIENT_SECRET` → `false` | Stub other 2 only |
| Missing `NEXTAUTH_SECRET` → `false` | Stub other 2 only |
| All empty strings → `false` | Stub all 3 as `""` |

#### `packages/dashboard/test/auth.test.ts` — Add describe block

| Test | Assertion |
|------|-----------|
| Local mode: does not call `NextAuth()` | Mock NextAuth, stub env without OAuth vars, import `@/auth`, assert NextAuth mock not called |
| Local mode: `auth` export is a function | Assert `typeof auth === "function"` |
| Local mode: `auth(handler)` returns a function that calls handler with `req.auth = null` | Call `auth(handler)`, invoke result, assert handler received `req.auth === null` |
| Local mode: `handlers.GET` returns 200 JSON | Call `handlers.GET()`, assert status 200, body contains `{ mode: "local" }` |
| Local mode: logs console.info | Spy on `console.info`, assert message contains "Local mode" |
| Auth mode: calls `NextAuth()` with Google provider | Existing tests (already passing) |

#### `packages/dashboard/test/proxy.test.ts` — Add describe block

| Test | Assertion |
|------|-----------|
| Local mode: all routes pass through (200) | Mock `@/lib/auth-mode` with `isAuthEnabled: false`, mock `@/auth` with local stub, test `/`, `/api/keys`, `/login`, `/api/auth/callback` all return 200 |
| Auth mode: existing tests | All existing tests continue passing unchanged |

#### `packages/dashboard/test/components/sidebar-local.test.tsx`

| Test | Assertion |
|------|-----------|
| Local mode: renders "Local" as user name | Stub `NEXT_PUBLIC_AUTH_ENABLED` as `""`, render `<Sidebar>`, assert text "Local" present |
| Local mode: renders "Local mode" as subtitle | Assert text "Local mode" present |
| Local mode: no sign-out button | Assert no element with `aria-label="Sign out"` |
| Auth mode: renders session user name | Mock `useSession` with user data, assert real name |
| Auth mode: sign-out button present | Assert `aria-label="Sign out"` exists |

#### `packages/dashboard/test/login-local.test.tsx`

| Test | Assertion |
|------|-----------|
| Local mode: calls `router.replace("/")` | Stub `NEXT_PUBLIC_AUTH_ENABLED` as `""`, render, assert `router.replace` called with `"/"` |
| Auth mode: renders Google sign-in button | Stub as `"1"`, render, assert "Sign in with Google" text present |

### Existing tests — no breakage

All existing `auth.test.ts` and `proxy.test.ts` tests must pass unchanged. They test the auth-enabled path. The mock setup (`vi.mock("next-auth", ...)`) simulates auth-enabled behavior by providing a NextAuth mock.

### Verification commands

```bash
bun run --filter dashboard test       # dashboard vitest (existing + new)
bun run --filter @raven/proxy test    # proxy unit tests (unaffected)
bun run typecheck                     # type-check both packages
bun run lint                          # ESLint
```

### Manual verification

1. Remove all Google OAuth vars from `packages/dashboard/.env.local` → `bun run dev` → dashboard loads at `:7032` without redirect to `/login`
2. All pages accessible: `/`, `/logs`, `/models`, `/connect`, `/settings`, `/copilot/account`, `/copilot/models`, `/requests`
3. Sidebar shows "Local" / "Local mode", no sign-out button
4. Navigate to `/login` manually → redirects to `/`
5. Restore Google OAuth vars → restart → login page appears → Google sign-in works → session shows real name/email
