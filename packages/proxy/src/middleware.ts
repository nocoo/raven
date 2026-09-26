import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { validateApiKey } from "./db/keys.ts";
import { state } from "./lib/state.ts";
import { COPILOT_RULE_ID } from "./core/routing-types.ts";
import { allowsIP, isLoopback, normalizeIP, parseRules, resolveClientIP } from "./lib/ip-access";
import { readIPPolicy } from "./db/ip-policy";
import { logEmitter } from "./util/log-emitter";
import { generateRequestId } from "./util/id";

declare module "hono" {
  interface ContextVariableMap {
    clientIP: string | null;
    peerIP: string | null;
    ipSource: string;
    keyName: string;
    keyId: string;
    ruleId: string;
    admittedAt: number;
    routingDb: Database;
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
): { valid: true; keyName: string; keyId: string; ruleId?: string } | { valid: false; response: Response } {
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
    return { valid: true, keyName: keyRecord.name, keyId: keyRecord.id, ruleId: keyRecord.rule_id };
  }

  // env key timing-safe compare
  if (envApiKey && timingSafeEqual(token, envApiKey)) {
    return { valid: true, keyName: "env:default", keyId: "env:default", ruleId: COPILOT_RULE_ID };
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
    const result = validateRequestToken(c, db, envApiKey);
    if (!result.valid) return result.response;
    const peer = normalizeIP(c.env?.remoteAddress ?? null);
    const client = resolveClientIP(c.req.raw.headers, peer, state.trustedProxyRanges);
    c.set("clientIP", client.ip);
    c.set("peerIP", peer);
    c.set("ipSource", client.source);
    const policy = result.keyId === "env:default" ? { enabled: false, ranges: [] } : readIPPolicy(db, result.keyId);
    const scope = !allowsIP(state.ipWhitelistEnabled, state.ipWhitelistRanges, client.ip) ? "global"
      : !allowsIP(policy.enabled, parseRules(policy.ranges), client.ip) ? "key" : null;
    if (scope) {
      logEmitter.emitLog({ ts: Date.now(), level: "warn", type: "request_end", requestId: generateRequestId(), msg: "IP access denied",
        data: { path: c.req.path, accountName: result.keyName, apiKeyId: result.keyId, clientIP: client.ip, peerIP: peer, ipSource: client.source,
          status: "denied", statusCode: 403, error: `IP denied by ${scope} whitelist`, latencyMs: 0 } });
      return c.json({ error: { type: "ip_access_denied", message: "Source IP is not allowed" } }, 403);
    }
    c.set("keyName", result.keyName);
    c.set("keyId", result.keyId);
    c.set("ruleId", result.ruleId!);
    c.set("admittedAt", Date.now());
    c.set("routingDb", db);
    await next();
  });
}

export function checkManagementAccess(peer: string | null, token: string | null, internalKey: string | null): Response | null {
  if (!isLoopback(peer)) return Response.json({ error: { type: "access_denied", message: "Management requires a local connection" } }, { status: 403 });
  if (!internalKey || !token || !timingSafeEqual(token, internalKey)) return Response.json({ error: { type: "authentication_error", message: "Internal credential required" } }, { status: 401 });
  return null;
}

export function dashboardAuth(opts: { internalKey: string | null }) {
  return createMiddleware(async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.header("x-api-key") ?? null;
    const denied = checkManagementAccess(c.env?.remoteAddress ?? null, token, opts.internalKey);
    if (denied) return denied;
    c.set("keyName", "internal");
    c.set("keyId", "internal");
    await next();
  });
}
