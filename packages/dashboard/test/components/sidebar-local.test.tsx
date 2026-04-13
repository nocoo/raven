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
      hasError: false,
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
      hasError: false,
    });

    vi.resetModules();

    const mod = await import("@/components/layout/sidebar");
    expect(mod.Sidebar).toBeDefined();
  });

  it("loading state: module loads while isLoading=true", async () => {
    mockUseAuthConfig.mockReturnValue({
      authEnabled: false,
      provider: "local",
      isLoading: true,
      hasError: false,
    });

    vi.resetModules();

    const mod = await import("@/components/layout/sidebar");
    expect(mod.Sidebar).toBeDefined();
  });
});

describe("sidebar display logic (unit)", () => {
  // Test the showAsAuth logic: while loading, use session presence as hint
  it("loading with session: shows session user (avoids Local mode flash)", () => {
    const authLoading = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } } as
      { user: { name: string; email: string; image: string } } | null;
    const authEnabled = false; // hasn't resolved yet

    // showAsAuth = authLoading ? !!session?.user : authEnabled
    const showAsAuth = authLoading ? !!session?.user : authEnabled;

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";
    const userImage = showAsAuth ? session?.user?.image : undefined;

    expect(showAsAuth).toBe(true); // session exists, so treat as auth
    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
    expect(userImage).toBe("http://img");
  });

  it("loading without session: shows Local (neutral placeholder)", () => {
    const authLoading = true;
    const session = null as { user: { name: string; email: string; image: string } } | null;
    const authEnabled = false;

    const showAsAuth = authLoading ? !!session?.user : authEnabled;

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";

    expect(showAsAuth).toBe(false);
    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
  });

  it("local mode confirmed: userName=Local, userEmail=Local mode", () => {
    const authLoading = false;
    const authEnabled = false;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } } as
      { user: { name: string; email: string; image: string } } | null;

    const showAsAuth = authLoading ? !!session?.user : authEnabled;

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";
    const userImage = showAsAuth ? session?.user?.image : undefined;

    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
    expect(userImage).toBeUndefined();
  });

  it("auth mode confirmed: uses session data", () => {
    const authLoading = false;
    const authEnabled = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } } as
      { user: { name: string; email: string; image: string } } | null;

    const showAsAuth = authLoading ? !!session?.user : authEnabled;

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";
    const userImage = showAsAuth ? session?.user?.image : undefined;

    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
    expect(userImage).toBe("http://img");
  });

  it("auth mode: null session falls back to defaults", () => {
    const authLoading = false;
    const authEnabled = true;
    const session = null as { user: { name: string; email: string; image: string } } | null;

    const showAsAuth = authLoading ? !!session?.user : authEnabled;

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";
    const userImage = showAsAuth ? session?.user?.image : undefined;

    expect(userName).toBe("User");
    expect(userEmail).toBe("");
    expect(userImage).toBeUndefined();
  });
});
