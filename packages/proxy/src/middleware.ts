import type { Database } from "bun:sqlite";
import { createMiddleware } from "hono/factory";
import { validateApiKey, getActiveKeyCount } from "./db/keys.ts";

declare module "hono" {
  interface ContextVariableMap {
    startTime: number;
    keyName: string;
  }
}

/**
 * Injects request context: startTime for latency tracking.
 * Note: requestId is generated per-route via generateId() (ULID) to unify
 * the DB primary key and log correlation key into a single ID.
 */
export function requestContext() {
  return createMiddleware(async (c, next) => {
    c.set("startTime", performance.now());
    await next();
  });
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
// Cached active key count — avoid COUNT(*) on every request
// ---------------------------------------------------------------------------

let cachedActiveKeyCount: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30s

function getCachedActiveKeyCount(db: Database): number {
  const now = Date.now();
  if (cachedActiveKeyCount === null || now - cacheTimestamp > CACHE_TTL_MS) {
    cachedActiveKeyCount = getActiveKeyCount(db);
    cacheTimestamp = now;
  }
  return cachedActiveKeyCount;
}

/** Invalidate the key count cache (call after create/delete/revoke) */
export function invalidateKeyCountCache(): void {
  cachedActiveKeyCount = null;
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Shared 401 response helper
// ---------------------------------------------------------------------------

function unauthorized(c: any, message: string) {
  return c.json(
    { error: { type: "authentication_error", message } },
    401,
  );
}

// ---------------------------------------------------------------------------
// Shared Bearer token validation (used by both middlewares)
// ---------------------------------------------------------------------------

function validateBearerToken(
  c: any,
  db: Database,
  envApiKey?: string,
  internalKey?: string,
): { valid: true; keyName: string } | { valid: false; response: Response } {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, response: unauthorized(c, "Missing or malformed Authorization header") };
  }

  const token = authHeader.slice(7); // strip "Bearer "

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
 * Dev mode (bootstrap only): when no RAVEN_API_KEY, no RAVEN_INTERNAL_KEY,
 * and no active DB keys exist, requests are allowed without auth. This
 * enables the first-run experience where dashboard creates the first key.
 * Once any key exists, dev mode exits permanently.
 *
 * Accepts RAVEN_API_KEY, RAVEN_INTERNAL_KEY, and DB keys.
 */
export function dashboardAuth(opts: DashboardAuthOpts) {
  const { db, envApiKey, internalKey } = opts;

  return createMiddleware(async (c, next) => {
    // Dev mode: no env keys AND no active DB keys → bootstrap allow
    if (!envApiKey && !internalKey && getCachedActiveKeyCount(db) === 0) {
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
