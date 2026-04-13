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
      error: undefined,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(true);
    expect(result.current.provider).toBe("google");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasError).toBe(false);
  });

  it("returns authEnabled=false, provider=local when API returns auth disabled", async () => {
    mockUseSWR.mockReturnValue({
      data: { authEnabled: false, provider: "local" },
      isLoading: false,
      error: undefined,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasError).toBe(false);
  });

  it("returns loading state while fetching", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: undefined,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasError).toBe(false);
  });

  it("defaults to local mode when data is undefined (no error)", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: undefined,
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasError).toBe(false);
  });

  it("returns hasError=true when fetch fails", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Network error"),
    });

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    const { result } = renderHook(() => useAuthConfig());

    expect(result.current.authEnabled).toBe(false);
    expect(result.current.provider).toBe("local");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasError).toBe(true);
  });

  it("calls SWR with correct config", async () => {
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: undefined,
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

// ---------------------------------------------------------------------------
// Fetcher tests — verify validation logic
// ---------------------------------------------------------------------------

describe("useAuthConfig fetcher validation", () => {
  let capturedFetcher: (url: string) => Promise<unknown>;

  beforeEach(() => {
    // Capture the fetcher function passed to SWR
    mockUseSWR.mockImplementation((_key, fetcher) => {
      capturedFetcher = fetcher;
      return { data: undefined, isLoading: false, error: undefined };
    });
  });

  it("returns valid auth config on successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authEnabled: true, provider: "google" }),
    }));

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    const result = await capturedFetcher("/api/auth/config");
    expect(result).toEqual({ authEnabled: true, provider: "google" });

    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }));

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    await expect(capturedFetcher("/api/auth/config")).rejects.toThrow(
      "Auth config fetch failed: 500"
    );

    vi.unstubAllGlobals();
  });

  it("throws on malformed response (missing authEnabled)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "google" }), // missing authEnabled
    }));

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    await expect(capturedFetcher("/api/auth/config")).rejects.toThrow(
      "Auth config response malformed"
    );

    vi.unstubAllGlobals();
  });

  it("throws on malformed response (invalid provider)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authEnabled: true, provider: "github" }), // invalid provider
    }));

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    await expect(capturedFetcher("/api/auth/config")).rejects.toThrow(
      "Auth config response malformed"
    );

    vi.unstubAllGlobals();
  });

  it("throws on null response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }));

    const { useAuthConfig } = await import("@/hooks/use-auth-config");
    renderHook(() => useAuthConfig());

    await expect(capturedFetcher("/api/auth/config")).rejects.toThrow(
      "Auth config response malformed"
    );

    vi.unstubAllGlobals();
  });
});
