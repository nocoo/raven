import type { Database } from "bun:sqlite";
import { createMiddleware } from "hono/factory";
import { validateApiKey, getKeyCount } from "./db/keys.ts";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    startTime: number;
    keyName: string;
  }
}

/**
 * Injects request context: unique requestId and startTime.
 */
export function requestContext() {
  return createMiddleware(async (c, next) => {
    c.set("requestId", globalThis.crypto.randomUUID());
    c.set("startTime", performance.now());
    await next();
  });
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
// DB-key auth middleware
// ---------------------------------------------------------------------------

export interface DbKeyAuthOpts {
  db: Database;
}

/**
 * Database-key authentication middleware with two paths:
 *
 * 1. Dev mode: no DB keys → allow all, keyName = "dev"
 * 2. rk- token: DB hash lookup → match + not revoked → allow, keyName = key.name
 *                               → no match or missing header → 401
 */
export function dbKeyAuth(opts: DbKeyAuthOpts) {
  const { db } = opts;

  return createMiddleware(async (c, next) => {
    // Dev mode: no DB keys → skip auth
    if (getCachedKeyCount(db) === 0) {
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

    // DB key lookup
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
  });
}
