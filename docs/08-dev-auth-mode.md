# Dev Auth Mode — Design Doc

## Overview

The dashboard currently hard-requires Google OAuth configuration (3 mandatory env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`). Without these, the dashboard crashes on startup or fails at login — making it impossible for new users to run the dashboard locally without creating Google Cloud credentials first.

Raven is a personal-use, local-run project. Requiring OAuth for localhost access is unnecessary friction.

**Goal:** When `GOOGLE_CLIENT_ID` is not set, the dashboard automatically runs in **dev mode** — no authentication, all pages directly accessible, zero configuration required.

---

## 1. Auth Module — Dual Export

### File: `packages/dashboard/src/auth.ts`

Detect dev mode at module load time:

```typescript
export const isDevAuth = !process.env.GOOGLE_CLIENT_ID
```

**When `isDevAuth = true`:**

- Do NOT instantiate the Google provider (avoids crash from undefined client ID)
- Export a dummy `auth` function that returns `null` (no session)
- Export noop `handlers` (`GET`/`POST` return 404), noop `signIn`/`signOut`
- Log a console message: `[auth] Dev mode — authentication disabled (GOOGLE_CLIENT_ID not set)`

**When `isDevAuth = false`:**

- Current behavior, unchanged. Google OAuth with ALLOWED_EMAILS, secure cookies, etc.

### Implementation approach

Use conditional module structure:

```typescript
export const isDevAuth = !process.env.GOOGLE_CLIENT_ID

if (isDevAuth) {
  console.info("[auth] Dev mode — authentication disabled (GOOGLE_CLIENT_ID not set)")
}

// Conditional NextAuth init — only when Google OAuth is configured
const authResult = isDevAuth
  ? {
      handlers: {
        GET: () => new Response("Auth disabled in dev mode", { status: 404 }),
        POST: () => new Response("Auth disabled in dev mode", { status: 404 }),
      },
      signIn: async () => undefined,
      signOut: async () => undefined,
      auth: (() => null) as any,
    }
  : NextAuth({ /* existing config */ })

export const { handlers, signIn, signOut, auth } = authResult
```

---

## 2. Middleware Bypass

### File: `packages/dashboard/src/proxy.ts`

Currently `proxy.ts` wraps all requests in `auth()` middleware, redirecting unauthenticated users to `/login`.

**When `isDevAuth = true`:**

- Import `isDevAuth` from `@/auth`
- Short-circuit: return `NextResponse.next()` for all requests — no auth checks, no redirects
- The `auth()` wrapper is still called (NextAuth middleware signature), but the inner callback always passes through

```typescript
import { auth, isDevAuth } from "@/auth"

export default auth((req) => {
  // Dev mode: skip all auth enforcement
  if (isDevAuth) return NextResponse.next()

  // ... existing auth logic unchanged ...
})
```

---

## 3. Login Page — Dev Mode Redirect

### File: `packages/dashboard/src/app/login/page.tsx`

**When `isDevAuth = true`:**

- Detect via env var at render time (`!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID` won't work server-side — need a different approach)
- Solution: add `NEXT_PUBLIC_AUTH_MODE` env var set at build time, OR detect in the page component and redirect

Simplest approach — server component redirect:

Add a new wrapper that checks `isDevAuth` at import time. Since the login page is `"use client"`, the simplest approach is:

1. Export `isDevAuth` from `@/auth` (already done in step 1)
2. In `proxy.ts` middleware: when `isDevAuth` and path is `/login`, redirect to `/` (already handled — middleware passes through, and the user never gets redirected to `/login` in the first place)

**No changes needed to login page itself** — users in dev mode will never see it because the middleware won't redirect them there. If someone navigates to `/login` manually, the Google sign-in button will 404 harmlessly. This is acceptable for a dev mode.

---

## 4. Sidebar — Dev Mode User Display

### File: `packages/dashboard/src/components/layout/sidebar.tsx`

Currently reads `useSession()` to get user name/email/avatar. In dev mode, session is `null`.

The existing fallbacks already handle this:

```typescript
const userName = session?.user?.name ?? "User"    // → "User"
const userEmail = session?.user?.email ?? ""       // → ""
const userImage = session?.user?.image             // → undefined
const userInitial = userName[0] ?? "?"             // → "U"
```

**Changes needed:**

- Import `isDevAuth` from `@/auth`
- Override display name to `"Local"` when dev mode (clearer than generic "User")
- Hide the sign-out button/action in dev mode (nothing to sign out from)

```typescript
import { isDevAuth } from "@/auth"

// In component:
const userName = isDevAuth ? "Local" : (session?.user?.name ?? "User")
const userEmail = isDevAuth ? "Dev mode" : (session?.user?.email ?? "")
// ...

// Collapsed: show avatar without sign-out onClick
// Expanded: hide LogOut button
```

---

## 5. AuthProvider — No Changes

### File: `packages/dashboard/src/components/auth-provider.tsx`

`SessionProvider` from NextAuth with no real backend simply returns `null` session, which is fine. All consumers use optional chaining. **No changes needed.**

---

## 6. .env.example Update

### File: `packages/dashboard/.env.example`

Add dev mode explanation at top:

```
# --- Dev mode ---
# If GOOGLE_CLIENT_ID is not set, the dashboard runs without authentication.
# This is suitable for local-only usage. Configure Google OAuth below to enable login.
```

Mark `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET` with `(optional for local use)`.

---

## 7. README Update

### File: `README.md`

In the "设置 > Dashboard" section, restructure:

1. Add quick-start note at the top:
   > **本地快速启动**：如果只是本地使用，Dashboard 无需额外配置。`bun run dev` 即可同时启动 proxy 和 dashboard，dashboard 自动以 dev 模式运行（无需登录）。

2. Wrap existing Google OAuth steps under sub-heading "（可选）启用 Google OAuth 认证"

3. Keep the existing 6-step guide intact.

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/dashboard/src/auth.ts` | Add `isDevAuth` detection + conditional NextAuth init |
| `packages/dashboard/src/proxy.ts` | Short-circuit auth enforcement when dev mode |
| `packages/dashboard/src/components/layout/sidebar.tsx` | Dev mode user display + hide sign-out |
| `packages/dashboard/.env.example` | Document dev mode |
| `README.md` | Quick-start note, Google OAuth as optional section |

## Files NOT Changed

| File | Why |
|------|-----|
| `packages/dashboard/src/app/login/page.tsx` | Users never reach it in dev mode (middleware doesn't redirect) |
| `packages/dashboard/src/components/auth-provider.tsx` | SessionProvider handles null session gracefully |
| `packages/proxy/src/index.ts` | SQLite auto-init already works: `mkdirSync` + `new Database()` + `CREATE TABLE IF NOT EXISTS` |
| `packages/proxy/src/lib/paths.ts` | `ensurePaths()` already handles first-run directory/file creation |

---

## Atomic Commits

1. `feat: add dev auth mode to dashboard` — `auth.ts` + `proxy.ts` (core behavior change)
2. `feat: show local user in sidebar when dev auth mode` — `sidebar.tsx`
3. `docs: document dev auth mode in env example and readme` — `.env.example` + `README.md`

---

## Verification

1. **Dev mode test**: Remove Google OAuth vars from `.env.local` → `bun run dev:dashboard` → dashboard loads without login redirect → all pages accessible
2. **All pages**: `/`, `/logs`, `/models`, `/connect`, `/settings`, `/copilot/account`, `/copilot/models`, `/requests` — no 401, no redirect
3. **Sidebar**: Shows "Local" with "Dev mode" subtitle, no sign-out button
4. **Google OAuth mode**: Restore Google OAuth vars → login flow works as before → session shows real user name/email/avatar + sign-out button
5. **Unit tests**: `bun run test` passes
6. **Typecheck**: `bun run typecheck` passes
