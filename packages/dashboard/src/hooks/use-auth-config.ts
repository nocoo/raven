"use client";

import useSWR from "swr";
import type { AuthConfig } from "@/app/api/auth/config/route";

// ---------------------------------------------------------------------------
// Runtime auth config hook
//
// Fetches auth configuration from the server at runtime, avoiding the
// build-time vs runtime mismatch that occurs with NEXT_PUBLIC_* env vars.
// The API endpoint reads process.env at runtime, so it always reflects
// the actual server configuration.
//
// IMPORTANT: This hook fails closed — if the fetch fails or returns invalid
// data, `hasError` is true and consumers should NOT assume local mode.
// The login page should block navigation when hasError is true.
// ---------------------------------------------------------------------------

async function fetcher(url: string): Promise<AuthConfig> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Auth config fetch failed: ${res.status}`);
  }
  const data: unknown = await res.json();
  // Validate response shape
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as AuthConfig).authEnabled !== "boolean" ||
    ((data as AuthConfig).provider !== "google" && (data as AuthConfig).provider !== "local")
  ) {
    throw new Error("Auth config response malformed");
  }
  return data as AuthConfig;
}

export interface UseAuthConfigResult {
  authEnabled: boolean;
  provider: "google" | "local";
  isLoading: boolean;
  /** True if fetch failed or response was invalid — do NOT assume local mode */
  hasError: boolean;
}

export function useAuthConfig(): UseAuthConfigResult {
  const { data, isLoading, error } = useSWR<AuthConfig>("/api/auth/config", fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60_000, // cache for 1 minute
  });

  return {
    authEnabled: data?.authEnabled ?? false,
    provider: data?.provider ?? "local",
    isLoading,
    hasError: !!error,
  };
}
