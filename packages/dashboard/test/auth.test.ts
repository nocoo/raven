import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock next-auth — capture the config object passed to NextAuth()
// ---------------------------------------------------------------------------

interface NextAuthConfig {
  trustHost: boolean;
  providers: Array<{ id: string; clientId?: string; clientSecret?: string }>;
  pages: { signIn: string; error: string };
  cookies: Record<string, { name: string; options: { httpOnly: boolean; sameSite: string; path: string; secure: boolean } }>;
  callbacks: {
    signIn: (params: { user: { email?: string | null | undefined } }) => Promise<boolean>;
  };
}

let lastConfig: NextAuthConfig;
const nextAuthMock = vi.fn();

vi.mock("next-auth", () => ({
  default: (config: NextAuthConfig) => {
    lastConfig = config;
    nextAuthMock(config);
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  },
}));

vi.mock("next-auth/providers/google", () => ({
  default: (opts: Record<string, unknown>) => ({ id: "google", ...opts }),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Base env vars to enable auth mode — tests that need auth mode must include these
const AUTH_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-secret",
  NEXTAUTH_SECRET: "test-nextauth-secret",
};

beforeEach(() => {
  vi.resetModules();
  nextAuthMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importAuth(envOverrides?: Record<string, string>) {
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      vi.stubEnv(key, value);
    }
  }
  return await import("@/auth");
}

// ---------------------------------------------------------------------------
// Local mode tests
// ---------------------------------------------------------------------------

describe("auth.ts local mode (no OAuth vars)", () => {
  it("does not call NextAuth()", async () => {
    await importAuth();
    expect(nextAuthMock).not.toHaveBeenCalled();
  });

  it("logs console.info about local mode", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await importAuth();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Local mode"),
    );
    infoSpy.mockRestore();
  });

  it("exports auth as a function", async () => {
    const { auth } = await importAuth();
    expect(typeof auth).toBe("function");
  });

  it("auth(handler) returns a function that calls handler with req.auth = null", async () => {
    const { auth } = await importAuth();
    const handler = vi.fn((req: any) => req.auth);
    const wrapped = auth(handler);

    const fakeReq = { nextUrl: new URL("http://localhost/"), url: "http://localhost/" };
    const result = wrapped(fakeReq);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBeNull();
  });

  it("auth(handler) preserves req.nextUrl and req.url", async () => {
    const { auth } = await importAuth();
    const handler = vi.fn((req: any) => ({ nextUrl: req.nextUrl, url: req.url }));
    const wrapped = auth(handler);

    const nextUrl = new URL("http://localhost/test");
    const fakeReq = { nextUrl, url: "http://localhost/test" };
    const result = wrapped(fakeReq);

    expect(result.nextUrl).toBe(nextUrl);
    expect(result.url).toBe("http://localhost/test");
  });

  it("handlers.GET returns 200 with empty JSON body", async () => {
    const { handlers } = await importAuth();
    const res = (handlers.GET as any)() as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("handlers.POST returns 200 with empty JSON body", async () => {
    const { handlers } = await importAuth();
    const res = (handlers.POST as any)() as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("exports isAuthEnabled as false", async () => {
    const { isAuthEnabled } = await importAuth();
    expect(isAuthEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth mode tests (existing, updated to set OAuth vars)
// ---------------------------------------------------------------------------

describe("auth.ts signIn callback", () => {
  describe("ALLOWED_EMAILS set", () => {
    it("email in allowlist → returns true", async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "alice@example.com,bob@example.com" });
      const result = await lastConfig.callbacks.signIn({ user: { email: "alice@example.com" } });
      expect(result).toBe(true);
    });

    it("email NOT in allowlist → returns false", async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "alice@example.com" });
      const result = await lastConfig.callbacks.signIn({ user: { email: "eve@evil.com" } });
      expect(result).toBe(false);
    });

    it('email comparison is case-insensitive ("User@GMAIL.com" matches "user@gmail.com")', async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "user@gmail.com" });
      const result = await lastConfig.callbacks.signIn({ user: { email: "User@GMAIL.COM" } });
      expect(result).toBe(true);
    });

    it("user with no email → returns false", async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "alice@example.com" });
      const result = await lastConfig.callbacks.signIn({ user: { email: null } });
      expect(result).toBe(false);
    });

    it("user with undefined email → returns false", async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "alice@example.com" });
      const result = await lastConfig.callbacks.signIn({ user: { email: undefined } });
      expect(result).toBe(false);
    });
  });

  describe("ALLOWED_EMAILS empty or unset", () => {
    it("any email → returns true (open access)", async () => {
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "" });
      const result = await lastConfig.callbacks.signIn({ user: { email: "anyone@anywhere.com" } });
      expect(result).toBe(true);
    });

    it("logs console.warn about unrestricted access", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await importAuth({ ...AUTH_ENV, ALLOWED_EMAILS: "" });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ALLOWED_EMAILS is not set"),
      );
      warnSpy.mockRestore();
    });
  });
});

describe("auth.ts cookie configuration", () => {
  describe("useSecureCookies = true", () => {
    it("NODE_ENV=production → secure cookies with __Secure- / __Host- prefixes", async () => {
      await importAuth({ ...AUTH_ENV, NODE_ENV: "production" });

      expect(lastConfig.cookies["sessionToken"]!.name).toBe("__Secure-authjs.session-token");
      expect(lastConfig.cookies["csrfToken"]!.name).toBe("__Host-authjs.csrf-token");
      expect(lastConfig.cookies["state"]!.name).toBe("__Secure-authjs.state");
      expect(lastConfig.cookies["pkceCodeVerifier"]!.name).toBe("__Secure-authjs.pkce.code_verifier");
      expect(lastConfig.cookies["callbackUrl"]!.name).toBe("__Secure-authjs.callback-url");
    });

    it("NEXTAUTH_URL=https://... → secure cookies", async () => {
      await importAuth({
        ...AUTH_ENV,
        NODE_ENV: "development",
        NEXTAUTH_URL: "https://dashboard.example.com",
      });

      expect(lastConfig.cookies["sessionToken"]!.name).toBe("__Secure-authjs.session-token");
      expect(lastConfig.cookies["sessionToken"]!.options.secure).toBe(true);
    });

    it("USE_SECURE_COOKIES=true → secure cookies", async () => {
      await importAuth({
        ...AUTH_ENV,
        NODE_ENV: "development",
        USE_SECURE_COOKIES: "true",
      });

      expect(lastConfig.cookies["sessionToken"]!.name).toBe("__Secure-authjs.session-token");
      expect(lastConfig.cookies["sessionToken"]!.options.secure).toBe(true);
    });

    it("all cookie options have httpOnly: true, sameSite: lax", async () => {
      await importAuth({ ...AUTH_ENV, NODE_ENV: "production" });

      for (const cookie of Object.values(lastConfig.cookies)) {
        expect(cookie.options.httpOnly).toBe(true);
        expect(cookie.options.sameSite).toBe("lax");
      }
    });
  });

  describe("useSecureCookies = false", () => {
    it("NODE_ENV=development + http URL + no USE_SECURE_COOKIES → non-secure cookie names", async () => {
      await importAuth({
        ...AUTH_ENV,
        NODE_ENV: "development",
        NEXTAUTH_URL: "http://localhost:3000",
        USE_SECURE_COOKIES: "",
      });

      expect(lastConfig.cookies["sessionToken"]!.name).toBe("authjs.session-token");
      expect(lastConfig.cookies["csrfToken"]!.name).toBe("authjs.csrf-token");
    });

    it("cookie secure option is false", async () => {
      await importAuth({
        ...AUTH_ENV,
        NODE_ENV: "development",
        NEXTAUTH_URL: "http://localhost:3000",
        USE_SECURE_COOKIES: "",
      });

      expect(lastConfig.cookies["sessionToken"]!.options.secure).toBe(false);
    });
  });
});

describe("auth.ts provider config", () => {
  it("passes GOOGLE_CLIENT_ID to Google provider", async () => {
    await importAuth({ ...AUTH_ENV, GOOGLE_CLIENT_ID: "custom-id" });
    const google = lastConfig.providers[0]!;
    expect(google.clientId).toBe("custom-id");
  });

  it("passes GOOGLE_CLIENT_SECRET to Google provider", async () => {
    await importAuth({ ...AUTH_ENV, GOOGLE_CLIENT_SECRET: "custom-secret" });
    const google = lastConfig.providers[0]!;
    expect(google.clientSecret).toBe("custom-secret");
  });

  it("custom pages: signIn → /login, error → /login", async () => {
    await importAuth(AUTH_ENV);
    expect(lastConfig.pages.signIn).toBe("/login");
    expect(lastConfig.pages.error).toBe("/login");
  });

  it("trustHost is true", async () => {
    await importAuth(AUTH_ENV);
    expect(lastConfig.trustHost).toBe(true);
  });

  it("exports isAuthEnabled as true", async () => {
    const { isAuthEnabled } = await importAuth(AUTH_ENV);
    expect(isAuthEnabled).toBe(true);
  });
});
