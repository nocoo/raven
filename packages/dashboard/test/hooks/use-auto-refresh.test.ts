// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAutoRefresh } from "@/hooks/use-auto-refresh";

describe("useAutoRefresh", () => {
  it.each([1000, 3000, 5000])("refreshes at %ims and releases its timer on unmount", (intervalMs) => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const { unmount } = renderHook(() => useAutoRefresh(intervalMs, refresh, false));
      act(() => vi.advanceTimersByTime(intervalMs - 1));
      expect(refresh).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(refresh).toHaveBeenCalledOnce();
      unmount();
      act(() => vi.advanceTimersByTime(intervalMs * 2));
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses pending and hidden-page refreshes, reschedules intervals and supports off", () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      visibility.mockReturnValue("visible");
      const refresh = vi.fn();
      const { rerender, unmount } = renderHook(
        ({ interval, pending }) => useAutoRefresh(interval, refresh, pending),
        { initialProps: { interval: 3000, pending: true } },
      );
      act(() => vi.advanceTimersByTime(9000));
      expect(refresh).not.toHaveBeenCalled();
      rerender({ interval: 3000, pending: false });
      visibility.mockReturnValue("hidden");
      act(() => vi.advanceTimersByTime(3000));
      expect(refresh).not.toHaveBeenCalled();
      visibility.mockReturnValue("visible");
      act(() => vi.advanceTimersByTime(3000));
      expect(refresh).toHaveBeenCalledTimes(1);
      rerender({ interval: 1000, pending: false });
      act(() => vi.advanceTimersByTime(1000));
      expect(refresh).toHaveBeenCalledTimes(2);
      rerender({ interval: 1000, pending: true });
      act(() => vi.advanceTimersByTime(3000));
      expect(refresh).toHaveBeenCalledTimes(2);
      rerender({ interval: 0, pending: false });
      act(() => vi.advanceTimersByTime(9000));
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      unmount();
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });
});
