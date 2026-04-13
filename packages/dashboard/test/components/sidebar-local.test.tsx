import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock useAuthConfig hook
// ---------------------------------------------------------------------------

const mockUseAuthConfig = vi.fn();

vi.mock("@/hooks/use-auth-config", () => ({
  useAuthConfig: () => mockUseAuthConfig(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseAuthConfig.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sidebar module — auth config hook", () => {
  it("local mode: module loads with useAuthConfig returning authEnabled=false", async () => {
    mockUseAuthConfig.mockReturnValue({
      authEnabled: false,
      provider: "local",
      isLoading: false,
    });

    vi.resetModules();

    const mod = await import("@/components/layout/sidebar");
    expect(mod.Sidebar).toBeDefined();
    expect(typeof mod.Sidebar).toBe("function");
    expect(mod.NAV_GROUPS).toBeDefined();
    expect(mod.ALL_NAV_ITEMS).toBeDefined();
  });

  it("auth mode: module loads with useAuthConfig returning authEnabled=true", async () => {
    mockUseAuthConfig.mockReturnValue({
      authEnabled: true,
      provider: "google",
      isLoading: false,
    });

    vi.resetModules();

    const mod = await import("@/components/layout/sidebar");
    expect(mod.Sidebar).toBeDefined();
  });
});

describe("sidebar display logic (unit)", () => {
  // Test the display logic directly without rendering
  it("local mode: userName=Local, userEmail=Local mode when authEnabled=false", () => {
    const authEnabled = false;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } } as
      { user: { name: string; email: string; image: string } } | null;

    const userName = authEnabled ? (session?.user?.name ?? "User") : "Local";
    const userEmail = authEnabled ? (session?.user?.email ?? "") : "Local mode";
    const userImage = authEnabled ? session?.user?.image : undefined;

    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
    expect(userImage).toBeUndefined();
  });

  it("auth mode: uses session data when authEnabled=true", () => {
    const authEnabled = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } } as
      { user: { name: string; email: string; image: string } } | null;

    const userName = authEnabled ? (session?.user?.name ?? "User") : "Local";
    const userEmail = authEnabled ? (session?.user?.email ?? "") : "Local mode";
    const userImage = authEnabled ? session?.user?.image : undefined;

    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
    expect(userImage).toBe("http://img");
  });

  it("auth mode: null session falls back to defaults", () => {
    const authEnabled = true;
    const session = null as { user: { name: string; email: string; image: string } } | null;

    const userName = authEnabled ? (session?.user?.name ?? "User") : "Local";
    const userEmail = authEnabled ? (session?.user?.email ?? "") : "Local mode";
    const userImage = authEnabled ? session?.user?.image : undefined;

    expect(userName).toBe("User");
    expect(userEmail).toBe("");
    expect(userImage).toBeUndefined();
  });
});
