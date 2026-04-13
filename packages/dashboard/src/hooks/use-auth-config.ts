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
// ---------------------------------------------------------------------------

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface UseAuthConfigResult {
  authEnabled: boolean;
  provider: "google" | "local";
  isLoading: boolean;
}

export function useAuthConfig(): UseAuthConfigResult {
  const { data, isLoading } = useSWR<AuthConfig>("/api/auth/config", fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60_000, // cache for 1 minute
  });

  return {
    authEnabled: data?.authEnabled ?? false,
    provider: data?.provider ?? "local",
    isLoading,
  };
}
