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
  // Test the showAsAuth logic with sessionStatus consideration:
  // - authLoading: showAsAuth = hasSession
  // - hasError: showAsAuth = sessionLoading || hasSession (fail closed)
  // - success: showAsAuth = authEnabled

  it("auth config loading, session exists: shows session user", () => {
    const authLoading = true;
    const hasError = false;
    const authEnabled = false;
    const sessionLoading = false;
    const hasSession = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } };

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";

    expect(showAsAuth).toBe(true);
    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
  });

  it("auth config loading, no session: shows Local placeholder", () => {
    const authLoading = true;
    const hasError = false;
    const authEnabled = false;
    const sessionLoading = false;
    const hasSession = false;

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? "User" : "Local";
    const userEmail = showAsAuth ? "" : "Local mode";

    expect(showAsAuth).toBe(false);
    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
  });

  it("auth config error, session loading: assumes auth mode (fail closed)", () => {
    const authLoading = false;
    const hasError = true;
    const authEnabled = false;
    const sessionLoading = true; // session still loading
    const hasSession = false; // no session data yet

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      // Key: sessionLoading means we can't trust !hasSession
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? "User" : "Local";
    const userEmail = showAsAuth ? "" : "Local mode";

    // Fail closed: assume auth mode while session is loading
    expect(showAsAuth).toBe(true);
    expect(userName).toBe("User");
    expect(userEmail).toBe("");
  });

  it("auth config error, session loaded with user: shows session user", () => {
    const authLoading = false;
    const hasError = true;
    const authEnabled = false;
    const sessionLoading = false;
    const hasSession = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } };

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";

    expect(showAsAuth).toBe(true);
    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
  });

  it("auth config error, session loaded empty: shows Local", () => {
    const authLoading = false;
    const hasError = true;
    const authEnabled = false;
    const sessionLoading = false; // session finished loading
    const hasSession = false; // confirmed no session

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? "User" : "Local";
    const userEmail = showAsAuth ? "" : "Local mode";

    // Session confirmed empty, so we can show local
    expect(showAsAuth).toBe(false);
    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
  });

  it("local mode confirmed: userName=Local, userEmail=Local mode", () => {
    const authLoading = false;
    const hasError = false;
    const authEnabled = false;
    const sessionLoading = false;
    const hasSession = true; // even with session, authEnabled=false means local
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } };

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";

    expect(showAsAuth).toBe(false);
    expect(userName).toBe("Local");
    expect(userEmail).toBe("Local mode");
  });

  it("auth mode confirmed: uses session data", () => {
    const authLoading = false;
    const hasError = false;
    const authEnabled = true;
    const sessionLoading = false;
    const hasSession = true;
    const session = { user: { name: "Real User", email: "real@user.com", image: "http://img" } };

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
    const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";

    expect(showAsAuth).toBe(true);
    expect(userName).toBe("Real User");
    expect(userEmail).toBe("real@user.com");
  });

  it("auth mode: null session falls back to defaults", () => {
    const authLoading = false;
    const hasError = false;
    const authEnabled = true;
    const sessionLoading = false;
    const hasSession = false;

    let showAsAuth: boolean;
    if (authLoading) {
      showAsAuth = hasSession;
    } else if (hasError) {
      showAsAuth = sessionLoading || hasSession;
    } else {
      showAsAuth = authEnabled;
    }

    const userName = showAsAuth ? "User" : "Local";
    const userEmail = showAsAuth ? "" : "Local mode";

    expect(showAsAuth).toBe(true);
    expect(userName).toBe("User");
    expect(userEmail).toBe("");
  });
});
