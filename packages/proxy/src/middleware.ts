import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { validateApiKey } from "./db/keys.ts";
import { state } from "./lib/state.ts";
import { extractIPv4, parseIPv4, isIPInRanges } from "./lib/ip-whitelist.ts";

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
// Shared request token validation (used by both middlewares)
// ---------------------------------------------------------------------------

function validateRequestToken(
  c: Context,
  db: Database,
  envApiKey: string | null,
  internalKey: string | null,
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
  envApiKey: string | null;
}

/**
 * Strict API key auth for AI coding routes (/v1/*, /chat/*, /embeddings).
 *
 * No dev mode bypass. Always requires a valid token via:
 * - Authorization: Bearer <token>
 * - x-api-key: <token> (for Claude Code compatibility)
 *
 * Token validation:
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
    const result = validateRequestToken(c, db, envApiKey, null);
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
  envApiKey: string | null;
  internalKey: string | null;
}

/**
 * Dashboard management auth for /api/* routes.
 *
 * Dev mode: when neither RAVEN_API_KEY nor RAVEN_INTERNAL_KEY is set,
 * all requests are allowed without auth. This is independent of DB keys —
 * creating/revoking DB keys does not affect dashboard access.
 *
 * When either env key is set, a valid token is required via:
 * - Authorization: Bearer <token>
 * - x-api-key: <token> (for Claude Code compatibility)
 *
 * Accepts RAVEN_API_KEY, RAVEN_INTERNAL_KEY, and DB keys.
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

    const result = validateRequestToken(c, db, envApiKey, internalKey);
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

// ---------------------------------------------------------------------------
// IP whitelist middleware — silently drop requests from non-whitelisted IPs
// ---------------------------------------------------------------------------

/**
 * Get the client IP from a Hono context.
 *
 * SECURITY: Only trusts x-forwarded-for/x-real-ip headers when
 * state.ipWhitelistTrustProxy is explicitly true. Otherwise,
 * only the direct connection IP is used to prevent header spoofing.
 */
function getClientIP(c: Context): string | null {
  // Only trust proxy headers when explicitly configured
  if (state.ipWhitelistTrustProxy) {
    // Check x-forwarded-for for reverse proxy setups
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      // Take the first IP (original client)
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }

    // Try x-real-ip (nginx)
    const realIP = c.req.header("x-real-ip");
    if (realIP) return realIP.trim();
  }

  // Direct connection IP from Bun server info
  const info = c.env?.info;
  if (info?.remoteAddress) {
    return info.remoteAddress;
  }

  return null;
}

/**
 * Check if a client IP is allowed by the whitelist.
 * Exported for use in WebSocket upgrade path.
 *
 * Returns: { allowed: true } | { allowed: false, reason: string }
 */
export function checkIPWhitelist(clientIP: string | null): { allowed: true } | { allowed: false; reason: string } {
  // Skip if whitelist is disabled
  if (!state.ipWhitelistEnabled) {
    return { allowed: true };
  }

  // Skip if no ranges configured (fail-open to avoid lockout)
  if (state.ipWhitelistRanges.length === 0) {
    return { allowed: true };
  }

  if (!clientIP) {
    // Cannot determine IP — fail-open
    return { allowed: true };
  }

  // Extract IPv4 from potentially IPv6-wrapped address
  const ipv4 = extractIPv4(clientIP);
  if (!ipv4) {
    return { allowed: false, reason: "not-ipv4" };
  }

  const ipNum = parseIPv4(ipv4);
  if (ipNum === null) {
    return { allowed: false, reason: "invalid-ip" };
  }

  // Check if IP is in any whitelisted range
  if (!isIPInRanges(ipNum, state.ipWhitelistRanges)) {
    return { allowed: false, reason: "not-whitelisted" };
  }

  return { allowed: true };
}

/**
 * Extract client IP from request for use outside of Hono context.
 * Used by WebSocket upgrade path.
 *
 * SECURITY: Only trusts proxy headers when state.ipWhitelistTrustProxy is true.
 */
export function getClientIPFromRequest(req: Request, remoteAddress: string | null): string | null {
  if (state.ipWhitelistTrustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }

    const realIP = req.headers.get("x-real-ip");
    if (realIP) return realIP.trim();
  }

  return remoteAddress;
}

/**
 * IP whitelist middleware.
 *
 * When IP whitelist is enabled (state.ipWhitelistEnabled = true),
 * requests from IPs not in the whitelist are silently dropped
 * (connection closed with no response).
 *
 * When disabled, all requests pass through.
 *
 * SECURITY: Proxy headers (x-forwarded-for, x-real-ip) are only trusted
 * when state.ipWhitelistTrustProxy is explicitly true. This prevents
 * clients from spoofing their IP via headers.
 *
 * This middleware should be applied at the app level, before any routes.
 */
export function ipWhitelistMiddleware() {
  return createMiddleware(async (c, next) => {
    const clientIP = getClientIP(c);
    const result = checkIPWhitelist(clientIP);

    if (!result.allowed) {
      return new Response(null, { status: 403, headers: { Connection: "close" } });
    }

    await next();
  });
}
