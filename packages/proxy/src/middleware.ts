import { createMiddleware } from "hono/factory";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    startTime: number;
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

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Uses constant-time XOR comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
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

/**
 * API key authentication middleware.
 * When apiKey is empty, all requests are allowed (dev mode).
 */
export function apiKeyAuth(apiKey: string) {
  return createMiddleware(async (c, next) => {
    // skip auth if no key is configured
    if (!apiKey) {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { error: { type: "authentication_error", message: "Missing or malformed Authorization header" } },
        401,
      );
    }

    const token = authHeader.slice(7); // strip "Bearer "
    if (!timingSafeEqual(token, apiKey)) {
      return c.json(
        { error: { type: "authentication_error", message: "Invalid API key" } },
        401,
      );
    }

    await next();
  });
}
