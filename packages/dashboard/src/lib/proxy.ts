import { managementConfig } from "./management-config";
import { apiErrorDetail, type ApiErrorDetail } from "./routing-client";

/**
 * Proxy connection configuration.
 * Dashboard Route Handlers use these to forward requests to the proxy server.
 */



export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number | undefined,
    public readonly detail?: ApiErrorDetail | undefined,
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
  const { url: base, key: API_KEY } = managementConfig();
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (API_KEY) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...init?.headers,
    },
    cache: "no-store",
    redirect: "error",
  });

  if (!res.ok) {
    const detail = apiErrorDetail(await res.json().catch(() => null));
    throw new ProxyError(
      detail?.message ?? `Proxy responded with ${res.status} ${res.statusText}`,
      res.status,
      detail,
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
