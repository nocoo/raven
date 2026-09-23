// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHistoryRetention } from "@/hooks/use-history-retention";

afterEach(() => vi.restoreAllMocks());

describe("history retention settings", () => {
  it("saves a validated choice and uses the server-confirmed value", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ history_retention_days: 60 }));
    const { result } = renderHook(() => useHistoryRetention(30));
    await act(() => result.current.save("60"));
    expect(request).toHaveBeenCalledWith("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "history_retention_days", value: "60" }) });
    expect(result.current.days).toBe(60);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    await act(() => result.current.save("60"));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks overlapping writes without optimistically changing a destructive policy", async () => {
    let resolve!: (response: Response) => void;
    const request = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useHistoryRetention(30));
    let saving!: Promise<void>;
    act(() => { saving = result.current.save("7"); });
    expect(result.current.saving).toBe(true);
    expect(result.current.days).toBe(30);
    await act(() => result.current.save("14"));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(Response.json({ history_retention_days: 7 })); await saving; });
    expect(result.current.days).toBe(7);
    expect(result.current.saving).toBe(false);
  });

  it("preserves the saved choice on API failure and permits a corrected save", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: { message: "Fixture failure" } }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ history_retention_days: 14 }));
    const { result } = renderHook(() => useHistoryRetention(90));
    await act(() => result.current.save("14"));
    expect(result.current.days).toBe(90);
    expect(result.current.error).toBe("Fixture failure");
    expect(result.current.saving).toBe(false);
    await act(() => result.current.save("14"));
    expect(result.current.days).toBe(14);
    expect(result.current.error).toBeNull();
  });

  it("rejects unsupported choices before sending and malformed server policies before adopting", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ history_retention_days: 1 }));
    const { result } = renderHook(() => useHistoryRetention(30));
    await act(() => result.current.save("91"));
    expect(request).not.toHaveBeenCalled();
    expect(result.current.error).toContain("History retention must be");
    await act(() => result.current.save("7"));
    expect(result.current.days).toBe(30);
    expect(result.current.error).toContain("History retention must be");
  });
});
