// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { LogDockProvider, useLogDock } from "@/components/logs/log-dock-context";

describe("LogDockContext", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LogDockProvider>{children}</LogDockProvider>
  );

  it("throws when useLogDock is used outside provider", () => {
    expect(() => renderHook(() => useLogDock())).toThrow(
      "useLogDock must be used within a LogDockProvider",
    );
  });

  it("initializes with closed state and null filter", () => {
    const { result } = renderHook(() => useLogDock(), { wrapper });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.requestIdFilter).toBeNull();
  });

  it("opens logs without filter", () => {
    const { result } = renderHook(() => useLogDock(), { wrapper });
    act(() => {
      result.current.openLogs();
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.requestIdFilter).toBeNull();
  });

  it("opens logs with specific requestId filter", () => {
    const { result } = renderHook(() => useLogDock(), { wrapper });
    act(() => {
      result.current.openLogs("req-abc");
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.requestIdFilter).toBe("req-abc");
  });

  it("toggles and closes logs", () => {
    const { result } = renderHook(() => useLogDock(), { wrapper });
    act(() => {
      result.current.toggleLogs();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.closeLogs();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("updates requestIdFilter independently", () => {
    const { result } = renderHook(() => useLogDock(), { wrapper });
    act(() => {
      result.current.setRequestIdFilter("req-456");
    });
    expect(result.current.requestIdFilter).toBe("req-456");

    act(() => {
      result.current.setRequestIdFilter(null);
    });
    expect(result.current.requestIdFilter).toBeNull();
  });
});
