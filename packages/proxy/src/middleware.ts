import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { validateApiKey } from "./db/keys.ts";

declare module "hono" {
  interface ContextVariableMap {
    keyName: string;
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Uses constant-time XOR comparison.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Key count cache invalidation — retained as no-op export for keys.ts
// compatibility. dashboardAuth dev mode no longer depends on key count
// (it only checks env keys), but routes still call this on create/revoke/delete.
// ---------------------------------------------------------------------------

/** @deprecated No-op — dashboardAuth dev mode no longer depends on key count */
export function invalidateKeyCountCache(): void {
  // intentionally empty
}

// ---------------------------------------------------------------------------
// Shared 401 response helper
// ---------------------------------------------------------------------------

function unauthorized(c: Context, message: string) {
  return c.json(
    { error: { type: "authentication_error", message } },
    401,
  );
}

// ---------------------------------------------------------------------------
// Shared Bearer token validation (used by both middlewares)
// ---------------------------------------------------------------------------

function validateBearerToken(
  c: Context,
  db: Database,
  envApiKey?: string,
  internalKey?: string,
): { valid: true; keyName: string } | { valid: false; response: Response } {
  // Accept token from Authorization: Bearer <token> or x-api-key: <token>
  // (Claude Code sends x-api-key when ANTHROPIC_BASE_URL != api.anthropic.com)
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");

  let token: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (xApiKey) {
    token = xApiKey;
  }

  if (!token) {
    return { valid: false, response: unauthorized(c, "Missing or invalid authentication credentials") };
  }

  // rk- prefix → DB lookup only, never fallback to env
  if (token.startsWith("rk-")) {
    const keyRecord = validateApiKey(db, token);
    if (!keyRecord) {
      return { valid: false, response: unauthorized(c, "Invalid API key") };
    }
    return { valid: true, keyName: keyRecord.name };
  }

  // env key timing-safe compare
  if (envApiKey && timingSafeEqual(token, envApiKey)) {
    return { valid: true, keyName: "env:default" };
  }

  // internal key timing-safe compare (dashboardAuth only, caller controls whether to pass this)
  if (internalKey && timingSafeEqual(token, internalKey)) {
    return { valid: true, keyName: "internal" };
  }

  return { valid: false, response: unauthorized(c, "Invalid API key") };
}

// ---------------------------------------------------------------------------
// apiKeyAuth — strict auth for AI coding routes, no dev mode
// ---------------------------------------------------------------------------

export interface ApiKeyAuthOpts {
  db: Database;
  envApiKey?: string;
}

/**
 * Strict API key auth for AI coding routes (/v1/*, /chat/*, /embeddings).
 *
 * No dev mode bypass. Always requires a valid Bearer token:
 * - rk- prefix → DB hash lookup
 * - other → timing-safe compare vs RAVEN_API_KEY
 *
 * RAVEN_INTERNAL_KEY is NOT accepted — the management credential
 * cannot be used to consume Copilot quota.
 */
export function apiKeyAuth(opts: ApiKeyAuthOpts) {
  const { db, envApiKey } = opts;

  return createMiddleware(async (c, next) => {
    // No internalKey parameter — apiKeyAuth never accepts it
    const result = validateBearerToken(c, db, envApiKey);
    if (!result.valid) return result.response;
    c.set("keyName", result.keyName);
    await next();
  });
}

// ---------------------------------------------------------------------------
// dashboardAuth — management routes with dev mode for bootstrap
// ---------------------------------------------------------------------------

export interface DashboardAuthOpts {
  db: Database;
  envApiKey?: string;
  internalKey?: string;
}

/**
 * Dashboard management auth for /api/* routes.
 *
 * Dev mode: when neither RAVEN_API_KEY nor RAVEN_INTERNAL_KEY is set,
 * all requests are allowed without auth. This is independent of DB keys —
 * creating/revoking DB keys does not affect dashboard access.
 *
 * When either env key is set, a valid Bearer token is required.
 * Accepts RAVEN_API_KEY, RAVEN_INTERNAL_KEY, and DB keys as Bearer tokens.
 */
export function dashboardAuth(opts: DashboardAuthOpts) {
  const { db, envApiKey, internalKey } = opts;

  return createMiddleware(async (c, next) => {
    // Dev mode: no env keys configured → always allow
    // DB key existence does NOT affect dashboard access
    if (!envApiKey && !internalKey) {
      c.set("keyName", "dev");
      await next();
      return;
    }

    const result = validateBearerToken(c, db, envApiKey, internalKey);
    if (!result.valid) return result.response;
    c.set("keyName", result.keyName);
    await next();
  });
}

// ---------------------------------------------------------------------------
// Legacy alias — kept for backward compatibility during migration
// ---------------------------------------------------------------------------

/** @deprecated Use apiKeyAuth or dashboardAuth instead */
export const multiKeyAuth = apiKeyAuth;
