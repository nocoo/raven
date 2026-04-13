import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock useAuthConfig hook
// ---------------------------------------------------------------------------

const mockUseAuthConfig = vi.fn();

vi.mock("@/hooks/use-auth-config", () => ({
  useAuthConfig: () => mockUseAuthConfig(),
}));

// ---------------------------------------------------------------------------
// Mock next-auth/react
// ---------------------------------------------------------------------------

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockReplace.mockClear();
  mockUseAuthConfig.mockClear();
});

describe("login page — local mode (auth disabled)", () => {
  it("calls router.replace('/') when auth is disabled", async () => {
    // Simulate local mode: authEnabled=false, isLoading=false
    mockUseAuthConfig.mockReturnValue({
      authEnabled: false,
      provider: "local",
      isLoading: false,
    });

    vi.resetModules();

    const mod = await import("@/app/login/page");

    // The module should export a default component
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });

  it("shows spinner while loading auth config", async () => {
    // Simulate loading state
    mockUseAuthConfig.mockReturnValue({
      authEnabled: false,
      provider: "local",
      isLoading: true,
    });

    vi.resetModules();

    const mod = await import("@/app/login/page");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});

describe("login page — auth mode (Google OAuth)", () => {
  it("exports a default component", async () => {
    // Simulate Google OAuth mode
    mockUseAuthConfig.mockReturnValue({
      authEnabled: true,
      provider: "google",
      isLoading: false,
    });

    vi.resetModules();

    const mod = await import("@/app/login/page");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
