import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Test /api/auth/config route
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/auth/config", () => {
  it("returns authEnabled=true, provider=google when all OAuth vars set", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.stubEnv("NEXTAUTH_SECRET", "test-session-secret");

    const { GET } = await import("@/app/api/auth/config/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      authEnabled: true,
      provider: "google",
    });
  });

  it("returns authEnabled=false, provider=local when OAuth vars missing", async () => {
    // No env vars set
    const { GET } = await import("@/app/api/auth/config/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      authEnabled: false,
      provider: "local",
    });
  });

  it("returns authEnabled=false when only GOOGLE_CLIENT_ID set", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");

    const { GET } = await import("@/app/api/auth/config/route");
    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      authEnabled: false,
      provider: "local",
    });
  });
});
