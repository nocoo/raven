// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { resolveSource } from "@/hooks/use-analytics-data";
import type { LogEvent } from "@/hooks/use-log-stream";
import type { AnalyticsFilters } from "@/lib/analytics-filters";

// ---------------------------------------------------------------------------
// resolveSource — pure function tests
// ---------------------------------------------------------------------------

describe("resolveSource", () => {
  it("returns 'live' when mode is 'live' regardless of connection/range", () => {
    expect(resolveSource("live", "24h", false)).toBe("live");
    expect(resolveSource("live", "7d", true)).toBe("live");
  });

  it("returns 'historical' when mode is 'historical' regardless of connection/range", () => {
    expect(resolveSource("historical", "15m", true)).toBe("historical");
    expect(resolveSource("historical", "15m", false)).toBe("historical");
  });

  it("returns 'live' in auto mode when range is 15m and connected", () => {
    expect(resolveSource("auto", "15m", true)).toBe("live");
  });

  it("returns 'historical' in auto mode when range is 15m but disconnected", () => {
    expect(resolveSource("auto", "15m", false)).toBe("historical");
  });

  it("returns 'historical' in auto mode when range is > 15m even if connected", () => {
    expect(resolveSource("auto", "1h", true)).toBe("historical");
    expect(resolveSource("auto", "24h", true)).toBe("historical");
    expect(resolveSource("auto", "7d", true)).toBe("historical");
    expect(resolveSource("auto", "30d", true)).toBe("historical");
  });
});

// ---------------------------------------------------------------------------
// useAnalyticsData hook tests
// ---------------------------------------------------------------------------

describe("useAnalyticsData", () => {
  const mockEvents: LogEvent[] = [
    { ts: 1000, level: "info", type: "request_end", requestId: "r1", msg: "done", data: { model: "gpt-4" } },
  ];

  const baseFilters: AnalyticsFilters = { range: "24h" };
  const liveFilters: AnalyticsFilters = { range: "15m" };

  let useAnalyticsData: typeof import("@/hooks/use-analytics-data").useAnalyticsData;

  beforeEach(async () => {
    const mod = await import("@/hooks/use-analytics-data");
    useAnalyticsData = mod.useAnalyticsData;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("uses liveTransformer when source resolves to live", () => {
    const liveTransformer = vi.fn(() => ({ count: 42 }));
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 100 }));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "live",
        filters: baseFilters,
        events: mockEvents,
        connected: true,
      }),
    );

    expect(result.current.isLive).toBe(true);
    expect(result.current.data).toEqual({ count: 42 });
    expect(liveTransformer).toHaveBeenCalledWith(mockEvents);
    expect(historicalFetcher).not.toHaveBeenCalled();
  });

  it("uses historicalFetcher when source resolves to historical", async () => {
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 100 }));
    const liveTransformer = vi.fn(() => ({ count: 42 }));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "historical",
        filters: baseFilters,
        events: mockEvents,
        connected: true,
      }),
    );

    expect(result.current.isLive).toBe(false);
    expect(historicalFetcher).toHaveBeenCalledWith(baseFilters);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.data).toEqual({ count: 100 });
    expect(result.current.error).toBeNull();
  });

  it("auto mode selects live when range=15m and connected", () => {
    const liveTransformer = vi.fn(() => ({ count: 10 }));
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 99 }));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "auto",
        filters: liveFilters,
        events: mockEvents,
        connected: true,
      }),
    );

    expect(result.current.isLive).toBe(true);
    expect(result.current.data).toEqual({ count: 10 });
    expect(historicalFetcher).not.toHaveBeenCalled();
  });

  it("auto mode selects historical when range=24h", async () => {
    const liveTransformer = vi.fn(() => ({ count: 10 }));
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 99 }));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "auto",
        filters: baseFilters,
        events: mockEvents,
        connected: true,
      }),
    );

    expect(result.current.isLive).toBe(false);
    expect(historicalFetcher).toHaveBeenCalled();

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 99 });
    });
  });

  it("reports error when historicalFetcher rejects", async () => {
    const liveTransformer = vi.fn(() => ({ count: 0 }));
    const historicalFetcher = vi.fn(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "historical",
        filters: baseFilters,
        events: [],
        connected: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe("Network error");
    expect(result.current.data).toBeNull();
  });

  it("refetch triggers a new historical fetch", async () => {
    let callCount = 0;
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: ++callCount }));
    const liveTransformer = vi.fn(() => ({ count: 0 }));

    const { result } = renderHook(() =>
      useAnalyticsData({
        historicalFetcher,
        liveTransformer,
        mode: "historical",
        filters: baseFilters,
        events: [],
        connected: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 1 });
    });

    // Call refetch
    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 2 });
    });
    expect(historicalFetcher).toHaveBeenCalledTimes(2);
  });

  it("switches from historical to live when connection/range change", async () => {
    const liveTransformer = vi.fn(() => ({ count: 5 }));
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 50 }));

    // Start with historical (24h range, disconnected)
    const { result, rerender } = renderHook(
      (props: { filters: AnalyticsFilters; connected: boolean }) =>
        useAnalyticsData({
          historicalFetcher,
          liveTransformer,
          mode: "auto",
          filters: props.filters,
          events: mockEvents,
          connected: props.connected,
        }),
      { initialProps: { filters: baseFilters, connected: false } },
    );

    expect(result.current.isLive).toBe(false);

    // Switch to live-eligible state
    rerender({ filters: liveFilters, connected: true });
    expect(result.current.isLive).toBe(true);
    expect(result.current.data).toEqual({ count: 5 });
  });

  it("live mode re-computes data when events change", () => {
    const liveTransformer = vi.fn((evts: LogEvent[]) => ({ count: evts.length }));
    const historicalFetcher = vi.fn(() => Promise.resolve({ count: 0 }));

    const { result, rerender } = renderHook(
      (props: { events: LogEvent[] }) =>
        useAnalyticsData({
          historicalFetcher,
          liveTransformer,
          mode: "live",
          filters: baseFilters,
          events: props.events,
          connected: true,
        }),
      { initialProps: { events: mockEvents } },
    );

    expect(result.current.data).toEqual({ count: 1 });

    const moreEvents: LogEvent[] = [
      ...mockEvents,
      { ts: 2000, level: "info", type: "request_end", requestId: "r2", msg: "done", data: { model: "gpt-4" } },
    ];
    rerender({ events: moreEvents });
    expect(result.current.data).toEqual({ count: 2 });
  });
});
