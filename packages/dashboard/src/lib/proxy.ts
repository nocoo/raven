/**
 * Proxy connection configuration.
 * Dashboard Route Handlers use these to forward requests to the proxy server.
 */

const PROXY_URL = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024";
const API_KEY = process.env.RAVEN_INTERNAL_KEY ?? process.env.RAVEN_API_KEY ?? "";

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number | undefined,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/**
 * Result type for data fetching — explicitly distinguishes success from failure.
 */
export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Typed fetch helper for proxy API calls.
 * Automatically includes API key auth and JSON parsing.
 */
export async function proxyFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${PROXY_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new ProxyError(
      `Proxy responded with ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Safe wrapper that catches errors and returns a FetchResult.
 * Use this in server components to avoid silent error swallowing.
 */
export async function safeFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<FetchResult<T>> {
  try {
    const data = await proxyFetch<T>(path, init);
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : "Unknown error connecting to proxy";
    return { ok: false, error: message };
  }
}
