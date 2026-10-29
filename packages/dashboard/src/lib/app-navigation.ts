"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";

/** Minimal query-string reader accepted by {@link searchParamsToFilters}. */
export type SearchParamsReader = Pick<URLSearchParams, "get" | "has" | "toString">;

/** Pathname for client-side URL updates when the router hook is temporarily null. */
export function useAppPathname(): string {
  return usePathname() ?? "/";
}

/** Mutable URLSearchParams snapshot when the router hook is temporarily null. */
export function useAppSearchParams(): URLSearchParams {
  const params = useSearchParams();
  return useMemo(
    () => new URLSearchParams(params?.toString() ?? ""),
    [params],
  );
}
