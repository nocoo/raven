"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyticsFilters } from "@/lib/analytics-filters";
import type { LogEvent } from "@/hooks/use-log-stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataSourceMode = "historical" | "live" | "auto";

export interface UseAnalyticsDataConfig<T> {
  /** Fetches data from the historical API using the current filters. */
  historicalFetcher: (filters: AnalyticsFilters) => Promise<T>;
  /** Transforms live SSE events into the same data shape. */
  liveTransformer: (events: LogEvent[]) => T;
  /** Source selection mode. */
  mode: DataSourceMode;
  /** Current analytics filters (used for historical fetch + auto mode decision). */
  filters: AnalyticsFilters;
  /** Live SSE events (from useLogStream). */
  events: LogEvent[];
  /** Whether the SSE connection is active. */
  connected: boolean;
  /** Refetch interval for historical mode in ms (default: none / manual). */
  refetchInterval?: number;
}

export interface UseAnalyticsDataReturn<T> {
  /** The current data (from live or historical source). */
  data: T | null;
  /** Whether data is currently sourced from live SSE. */
  isLive: boolean;
  /** Whether historical data is loading. */
  isLoading: boolean;
  /** Error message from the last historical fetch (null if ok). */
  error: string | null;
  /** Force refetch historical data. */
  refetch: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ranges that are short enough to serve from live SSE data. */
const LIVE_ELIGIBLE_RANGES = new Set(["15m"]);

/**
 * Determine effective source based on mode, range, and connection.
 * Exported for testing.
 */
export function resolveSource(
  mode: DataSourceMode,
  range: string,
  connected: boolean,
): "live" | "historical" {
  if (mode === "live") return "live";
  if (mode === "historical") return "historical";
  // auto: use live when range is ≤15m and SSE connected
  if (LIVE_ELIGIBLE_RANGES.has(range) && connected) return "live";
  return "historical";
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Dual-source data hook: transparently serves panel data from either
 * live SSE events or the historical API, with automatic source selection.
 *
 * @example
 * ```tsx
 * const { data, isLive, isLoading } = useAnalyticsData({
 *   historicalFetcher: (f) => fetchSummary(f),
 *   liveTransformer: (events) => computeSummary(events),
 *   mode: "auto",
 *   filters,
 *   events,
 *   connected,
 * });
 * ```
 */
export function useAnalyticsData<T>(
  config: UseAnalyticsDataConfig<T>,
): UseAnalyticsDataReturn<T> {
  const {
    historicalFetcher,
    liveTransformer,
    mode,
    filters,
    events,
    connected,
    refetchInterval,
  } = config;

  const [historicalData, setHistoricalData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track latest fetch to avoid stale updates
  const fetchIdRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const source = resolveSource(mode, filters.range, connected);
  const isLive = source === "live";

  // Stable reference for historicalFetcher
  const fetcherRef = useRef(historicalFetcher);
  fetcherRef.current = historicalFetcher;

  // Stable reference for filters (deep comparison via JSON)
  const filtersJson = JSON.stringify(filters);

  const doFetch = useCallback(async () => {
    const id = ++fetchIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const currentFilters: AnalyticsFilters = JSON.parse(filtersJson);
      const result = await fetcherRef.current(currentFilters);
      // Only update if this is still the latest request
      if (id === fetchIdRef.current) {
        setHistoricalData(result);
      }
    } catch (err) {
      if (id === fetchIdRef.current) {
        setError(err instanceof Error ? err.message : "Fetch failed");
      }
    } finally {
      if (id === fetchIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [filtersJson]);

  // Fetch historical data when source is historical and filters change
  useEffect(() => {
    if (source === "historical") {
      void doFetch();
    }
    // When switching to live, clear loading state
    if (source === "live") {
      setIsLoading(false);
      setError(null);
    }
  }, [source, doFetch]);

  // Refetch interval for historical mode
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (source === "historical" && refetchInterval && refetchInterval > 0) {
      intervalRef.current = setInterval(() => {
        void doFetch();
      }, refetchInterval);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [source, refetchInterval, doFetch]);

  // Compute live data
  const liveData = isLive ? liveTransformer(events) : null;

  const data = isLive ? liveData : historicalData;

  return {
    data,
    isLive,
    isLoading,
    error,
    refetch: doFetch,
  };
}
