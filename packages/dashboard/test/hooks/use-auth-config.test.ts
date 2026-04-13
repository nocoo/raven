// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

const mockUseSWR = vi.fn();

vi.mock("swr", () => ({
  default: (key: string, fetcher: (url: string) => Promise<unknown>, options?: object) =>
    mockUseSWR(key, fetcher, options),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseSWR.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("useAuthConfig hook", () => {
  it("returns authEnabled=true, provider=google when API returns auth enabled", async () => {
    mockUseSWR.mockReturnValue({
      data: { authEnabled: true, provider: "google" },
      isLoading: false,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(true);
    expect(result.current.provider).toBe("google");
    expect(result.current.isLoading).toBe(false);
  });

  it("returns authEnabled=false, provider=local when API returns auth disabled", async () => {
    mockUseSWR.mockReturnValue({
      data: { authEnabled: false, provider: "local" },
      isLoading: false,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(false);
  });

  it("returns loading state while fetching", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(true);
  });

  it("defaults to local mode when data is undefined", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(false);
  });

  it("calls SWR with correct config", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    expect(mockUseSWR).toHaveBeenCalledWith(
      "/api/auth/config",
      expect.any(Function),
      expect.objectContaining({
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        dedupingInterval: 60_000,
      })
    );
  });
});
