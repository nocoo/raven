import type { Database } from "bun:sqlite";
import { createMiddleware } from "hono/factory";
import { validateApiKey, getKeyCount } from "./db/keys.ts";

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
// Cached key count — avoid COUNT(*) on every request
// ---------------------------------------------------------------------------

let cachedKeyCount: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30s

function getCachedKeyCount(db: Database): number {
  const now = Date.now();
  if (cachedKeyCount === null || now - cacheTimestamp > CACHE_TTL_MS) {
    cachedKeyCount = getKeyCount(db);
    cacheTimestamp = now;
  }
  return cachedKeyCount;
}

/** Invalidate the key count cache (call after create/delete) */
export function invalidateKeyCountCache(): void {
  cachedKeyCount = null;
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Multi-key auth middleware
// ---------------------------------------------------------------------------

export interface MultiKeyAuthOpts {
  db: Database;
  envApiKey?: string;
}

/**
 * Multi-key authentication middleware with three paths:
 *
 * 1. Dev mode: !envApiKey AND no DB keys → allow all, keyName = "dev"
 * 2. rk- prefix: DB hash lookup → match + not revoked → allow, keyName = key.name
 *                                → no match → 401 (never fallback to env)
 * 3. Other token: timing-safe compare vs envApiKey → match → allow, keyName = "env:default"
 *                                                  → no match → 401
 *
 * If envApiKey is set but DB has no keys, only env path works (no dev mode).
 * If DB has keys but no envApiKey, only rk- path works (no dev mode).
 */
export function multiKeyAuth(opts: MultiKeyAuthOpts) {
  const { db, envApiKey } = opts;

  return createMiddleware(async (c, next) => {
    // Dev mode: no env key AND no DB keys → skip auth
    if (!envApiKey && getCachedKeyCount(db) === 0) {
      c.set("keyName", "dev");
      await next();
      return;
    }

    // Require Authorization header
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            message: "Missing or malformed Authorization header",
          },
        },
        401,
      );
    }

    const token = authHeader.slice(7); // strip "Bearer "

    // Path 2: rk- prefix → DB lookup only, never fallback to env
    if (token.startsWith("rk-")) {
      const keyRecord = validateApiKey(db, token);
      if (!keyRecord) {
        return c.json(
          {
            error: {
              type: "authentication_error",
              message: "Invalid API key",
            },
          },
          401,
        );
      }
      c.set("keyName", keyRecord.name);
      await next();
      return;
    }

    // Path 3: non-rk- token → env timing-safe compare
    if (envApiKey && timingSafeEqual(token, envApiKey)) {
      c.set("keyName", "env:default");
      await next();
      return;
    }

    return c.json(
      {
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      },
      401,
    );
  });
}
