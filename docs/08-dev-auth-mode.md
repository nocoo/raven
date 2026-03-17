# Dev Auth Mode — Design Doc

## Overview

The dashboard hard-requires Google OAuth (3 mandatory env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`). Without all three, the dashboard either crashes at import time (`process.env.GOOGLE_CLIENT_ID!` → `undefined` passed to Google provider) or produces broken auth flows. This makes it impossible for new users to run the dashboard locally without first creating Google Cloud OAuth credentials.

Raven is a personal-use, local-run project. Requiring OAuth for localhost access is unnecessary friction.

**Goal:** When Google OAuth is not fully configured, the dashboard runs in **dev mode** — no authentication, all pages directly accessible, zero configuration required.

---

## 1. Auth Mode Detection

### New file: `packages/dashboard/src/lib/auth-mode.ts`

A client-safe module that exposes the auth mode flag. **Isolated from `auth.ts`** to avoid pulling server-only NextAuth code into client components.

```typescript
// True when all 3 required OAuth vars are present
export const isAuthEnabled =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.NEXTAUTH_SECRET
```

This checks all three variables — setting only `GOOGLE_CLIENT_ID` without the other two would previously crash NextAuth at runtime.

Additionally, expose this flag to client components via Next.js public env:

```typescript
// In next.config.ts, add:
env: {
  NEXT_PUBLIC_AUTH_ENABLED: isAuthEnabled ? "1" : "",
}
```

Client components read `process.env.NEXT_PUBLIC_AUTH_ENABLED` — a simple truthy/falsy string. This avoids importing server modules into `"use client"` components.

---

## 2. Auth Module — Conditional Init

### File: `packages/dashboard/src/auth.ts`

```typescript
import { isAuthEnabled } from "@/lib/auth-mode"

if (!isAuthEnabled) {
  console.info(
    "[auth] Dev mode — authentication disabled. " +
    "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and NEXTAUTH_SECRET to enable."
  )
}
```

**When `isAuthEnabled = false`:**

- Do NOT call `NextAuth()` — do not instantiate the Google provider at all
- Export stub values:

```typescript
const devHandlers = {
  GET: () => new Response("Auth disabled in dev mode", { status: 404 }),
  POST: () => new Response("Auth disabled in dev mode", { status: 404 }),
}
export const handlers = devHandlers
export const signIn = async () => "/login"
export const signOut = async () => "/login"
// auth is NOT exported in dev mode — proxy.ts uses a different code path
```

**When `isAuthEnabled = true`:**

- Current `NextAuth()` initialization, unchanged.
- Export `handlers`, `signIn`, `signOut`, `auth` as today.

Key point: **`auth` is only exported when `isAuthEnabled`**. The `proxy.ts` middleware (section 3) branches before trying to use it.

---

## 3. Middleware — Explicit Branch

### File: `packages/dashboard/src/proxy.ts`

The current code does `export default auth((req) => ...)` — the `auth()` function wraps the handler as NextAuth middleware. In dev mode, `auth` is not a valid wrapper.

**Replace with an explicit branch at the top level:**

```typescript
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { isAuthEnabled } from "@/lib/auth-mode"

function devProxy(_req: NextRequest) {
  return NextResponse.next()
}

function createAuthProxy() {
  // Dynamic import so NextAuth is never loaded in dev mode
  const { auth } = require("@/auth")
  return auth((req: any) => {
    const { pathname } = req.nextUrl
    if (pathname.startsWith("/api/auth")) return NextResponse.next()
    if (pathname === "/login") {
      if (req.auth) return NextResponse.redirect(new URL("/", req.url))
      return NextResponse.next()
    }
    if (!req.auth) {
      if (pathname.startsWith("/api/"))
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      return NextResponse.redirect(new URL("/login", req.url))
    }
    return NextResponse.next()
  })
}

export default isAuthEnabled ? createAuthProxy() : devProxy

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
}
```

In dev mode, `devProxy` is a plain `(req) => NextResponse.next()` function — no NextAuth involvement at all.

**⚠️ Note on `require()`**: Next.js middleware must be statically analyzable, so the `require("@/auth")` must work at module scope. Alternative: use conditional `import` at top level and only reference `auth` inside the branch. Either way, the key constraint is: **NextAuth() must never be invoked when `isAuthEnabled = false`.**

Preferred approach — conditional top-level import:

```typescript
import { isAuthEnabled } from "@/lib/auth-mode"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Only import auth when needed — auth.ts guards NextAuth() init behind isAuthEnabled
import { auth } from "@/auth"

// ... rest same, but use `auth` only inside the isAuthEnabled branch
```

This works because `auth.ts` itself guards the `NextAuth()` call behind `isAuthEnabled`, so importing the module is safe — it just won't export a real `auth` function in dev mode. The proxy.ts must not _call_ `auth()` in that case.

Final simplified design:

```typescript
import { isAuthEnabled } from "@/lib/auth-mode"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

let middleware: (req: NextRequest) => Response | NextResponse

if (isAuthEnabled) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { auth } = require("@/auth") as { auth: Function }
  middleware = auth((req: any) => {
    // ... existing auth logic, verbatim ...
  })
} else {
  middleware = (_req: NextRequest) => NextResponse.next()
}

export default middleware

export const config = { /* same matcher */ }
```

---

## 4. AuthProvider — Conditional

### File: `packages/dashboard/src/components/auth-provider.tsx`

Currently always wraps children in `<SessionProvider>`. In dev mode with `/api/auth/*` returning 404, `useSession()` would fire requests to `/api/auth/session` and get 404 responses — producing console errors and potentially broken state.

**Fix: skip `SessionProvider` in dev mode.**

```typescript
"use client"

import { SessionProvider } from "next-auth/react"

const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (!isAuthEnabled) return <>{children}</>
  return <SessionProvider>{children}</SessionProvider>
}
```

When `SessionProvider` is absent, `useSession()` calls in child components return `{ data: null, status: "unauthenticated" }` — this is the NextAuth default when no provider is above. Existing optional chaining (`session?.user?.name ?? "User"`) handles this gracefully.

---

## 5. Login Page — Dev Mode Redirect

### File: `packages/dashboard/src/app/login/page.tsx`

Currently a `"use client"` page that renders a Google sign-in button. In dev mode, the button calls `signIn("google")` which hits the 404 stub — bad UX.

**Fix: redirect to `/` in dev mode.**

```typescript
"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED

function LoginContent() {
  const router = useRouter()

  // Dev mode: no login needed, redirect home
  useEffect(() => {
    if (!isAuthEnabled) router.replace("/")
  }, [router])

  if (!isAuthEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">
          Redirecting…
        </p>
      </div>
    )
  }

  // ... existing login UI unchanged ...
}
```

This ensures users who manually navigate to `/login` get sent to `/` immediately.

---

## 6. Sidebar — Dev Mode Display

### File: `packages/dashboard/src/components/layout/sidebar.tsx`

Uses `useSession()` for user name/email/avatar, and `signOut()` for the logout button.

**Changes:**

Read `NEXT_PUBLIC_AUTH_ENABLED` (client-safe, no server import):

```typescript
const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED
```

- When `!isAuthEnabled`:
  - `userName = "Local"`, `userEmail = "Dev mode"`, `userInitial = "L"`
  - Collapsed avatar: static (no `onClick` to `signOut`)
  - Expanded view: hide `<LogOut>` button entirely
- When `isAuthEnabled`: current behavior unchanged

---

## 7. next.config.ts — Expose Public Env

### File: `packages/dashboard/next.config.ts`

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

This bakes the auth mode into the client bundle at build/dev time.

---

## 8. .env.example Update

### File: `packages/dashboard/.env.example`

Add dev mode explanation at top:

```
# --- Dev mode ---
# If GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and NEXTAUTH_SECRET are all unset,
# the dashboard runs without authentication — suitable for local-only usage.
```

Update variable descriptions to say "(required for Google OAuth)" instead of just "(必填)".

---

## 9. README Update

### File: `README.md`

In "设置 > Dashboard" section:

1. Add quick-start note:
   > **本地快速启动**：如果只是本地使用，Dashboard 无需额外配置。`bun run dev` 即可同时启动 proxy 和 dashboard，dashboard 自动以 dev 模式运行（无需登录）。

2. Wrap existing 6-step Google OAuth guide under sub-heading "（可选）启用 Google OAuth 认证"

3. Update env var table: mark `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET` as "(required for Google OAuth, not needed for local dev mode)".

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/dashboard/src/lib/auth-mode.ts` | **New** — client-safe `isAuthEnabled` flag |
| `packages/dashboard/src/auth.ts` | Guard `NextAuth()` behind `isAuthEnabled` |
| `packages/dashboard/src/proxy.ts` | Branch: auth middleware vs passthrough |
| `packages/dashboard/src/components/auth-provider.tsx` | Skip `SessionProvider` in dev mode |
| `packages/dashboard/src/app/login/page.tsx` | Redirect to `/` in dev mode |
| `packages/dashboard/src/components/layout/sidebar.tsx` | "Local" / "Dev mode" display, hide sign-out |
| `packages/dashboard/next.config.ts` | Expose `NEXT_PUBLIC_AUTH_ENABLED` |
| `packages/dashboard/.env.example` | Document dev mode, mark OAuth vars optional |
| `README.md` | Quick-start note, optional OAuth section |

## Files NOT Changed

| File | Why |
|------|-----|
| `packages/proxy/src/index.ts` | SQLite auto-init already works: `mkdirSync` + `new Database()` + `CREATE TABLE IF NOT EXISTS` |
| `packages/proxy/src/lib/paths.ts` | `ensurePaths()` already handles first-run directory/file creation |

---

## Atomic Commits

1. `feat: add auth-mode detection and conditional NextAuth init` — `auth-mode.ts`, `auth.ts`, `next.config.ts`
2. `feat: dev auth mode middleware bypass` — `proxy.ts`
3. `feat: skip SessionProvider in dev auth mode` — `auth-provider.tsx`
4. `feat: login page redirect and sidebar dev mode display` — `login/page.tsx`, `sidebar.tsx`
5. `docs: document dev auth mode in env example and readme` — `.env.example`, `README.md`
6. `test: add dev auth mode test coverage` — test files

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
| All empty → `false` | Stub all 3 as `""` |

#### `packages/dashboard/test/auth.test.ts` — Add describe block

| Test | Assertion |
|------|-----------|
| Dev mode: does not call `NextAuth()` | Mock NextAuth, stub env without Google vars, import `@/auth`, assert NextAuth mock not called |
| Dev mode: `handlers.GET` returns 404 | Import `@/auth` in dev mode, call `handlers.GET()`, assert status 404 |
| Dev mode: logs console.info | Spy on `console.info`, assert message contains "Dev mode" |
| Auth mode: calls `NextAuth()` with Google provider | Existing tests (already passing) cover this |

#### `packages/dashboard/test/proxy.test.ts` — Add describe block

| Test | Assertion |
|------|-----------|
| Dev mode: all routes return `NextResponse.next()` (200) | Mock `@/lib/auth-mode` with `isAuthEnabled: false`, import proxy, test `/`, `/api/keys`, `/login`, `/api/auth/callback` all return 200 |
| Dev mode: no `auth()` wrapper invoked | Assert `auth` from `@/auth` not called |
| Auth mode: existing tests | All existing tests continue passing |

#### `packages/dashboard/test/components/sidebar-dev.test.tsx`

| Test | Assertion |
|------|-----------|
| Dev mode: renders "Local" as user name | Stub `NEXT_PUBLIC_AUTH_ENABLED` as `""`, render `<Sidebar>`, assert text "Local" present |
| Dev mode: renders "Dev mode" as subtitle | Assert text "Dev mode" present |
| Dev mode: no sign-out button | Assert no button with `aria-label="Sign out"` |
| Auth mode: renders session user name | Mock `useSession` with user, assert real name renders |
| Auth mode: sign-out button present | Assert button with `aria-label="Sign out"` exists |

#### `packages/dashboard/test/login-dev.test.tsx`

| Test | Assertion |
|------|-----------|
| Dev mode: redirects to `/` | Stub `NEXT_PUBLIC_AUTH_ENABLED` as `""`, render `<LoginPage>`, assert `router.replace("/")` called |
| Auth mode: renders Google sign-in button | Stub `NEXT_PUBLIC_AUTH_ENABLED` as `"1"`, render, assert "Sign in with Google" button present |

### Existing tests — no breakage

All existing `auth.test.ts` and `proxy.test.ts` tests must continue passing. They test the **auth-enabled** path, which is unchanged. The mock setup (`vi.mock("next-auth", ...)`) simulates the auth-enabled path by default.

### Verification commands

```bash
bun run --filter dashboard test       # dashboard vitest (existing + new)
bun run --filter @raven/proxy test    # proxy unit tests (should be unaffected)
bun run typecheck                     # type-check both packages
bun run lint                          # ESLint
```

### Manual verification

1. Remove all Google OAuth vars from `packages/dashboard/.env.local` → `bun run dev` → dashboard loads at `:7032` without redirect to `/login`
2. All pages accessible: `/`, `/logs`, `/models`, `/connect`, `/settings`, `/copilot/account`, `/copilot/models`, `/requests`
3. Sidebar shows "Local" / "Dev mode", no sign-out button
4. Navigate to `/login` manually → redirects to `/`
5. Restore Google OAuth vars → restart → login page appears → Google sign-in works → session shows real name/email
