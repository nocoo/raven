import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importAuthMode(envOverrides?: Record<string, string>) {
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      vi.stubEnv(key, value);
    }
  }
  return await import("@/lib/auth-mode");
}

describe("auth-mode.ts isAuthEnabled", () => {
  it("all 3 vars set → true", async () => {
    const { isAuthEnabled } = await importAuthMode({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "sess-secret",
    });
    expect(isAuthEnabled).toBe(true);
  });

  it("missing GOOGLE_CLIENT_ID → false", async () => {
    const { isAuthEnabled } = await importAuthMode({
      GOOGLE_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "sess-secret",
    });
    expect(isAuthEnabled).toBe(false);
  });

  it("missing GOOGLE_CLIENT_SECRET → false", async () => {
    const { isAuthEnabled } = await importAuthMode({
      GOOGLE_CLIENT_ID: "id",
      NEXTAUTH_SECRET: "sess-secret",
    });
    expect(isAuthEnabled).toBe(false);
  });

  it("missing NEXTAUTH_SECRET → false", async () => {
    const { isAuthEnabled } = await importAuthMode({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(isAuthEnabled).toBe(false);
  });

  it("all empty strings → false", async () => {
    const { isAuthEnabled } = await importAuthMode({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      NEXTAUTH_SECRET: "",
    });
    expect(isAuthEnabled).toBe(false);
  });

  it("all unset → false", async () => {
    const { isAuthEnabled } = await importAuthMode();
    expect(isAuthEnabled).toBe(false);
  });
});
