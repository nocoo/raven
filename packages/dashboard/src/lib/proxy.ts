/**
 * Proxy connection configuration.
 * Dashboard Route Handlers use these to forward requests to the proxy server.
 */

const PROXY_URL = process.env.RAVEN_PROXY_URL ?? "http://localhost:7033";
const API_KEY = process.env.RAVEN_API_KEY ?? "";

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
    throw new Error(`Proxy fetch failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}
