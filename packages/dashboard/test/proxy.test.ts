import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mock @/auth — capture the handler function passed to auth()
// ---------------------------------------------------------------------------

type AuthHandler = (req: {
  nextUrl: URL;
  url: string;
  auth: unknown;
}) => NextResponse | Response;

let capturedHandler: AuthHandler;
let mockIsAuthEnabled = true;

vi.mock("@/auth", () => ({
  auth: (handler: AuthHandler) => {
    capturedHandler = handler;
    return handler;
  },
  get isAuthEnabled() {
    return mockIsAuthEnabled;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(pathname: string, auth: unknown = null) {
  const url = `http://localhost:3000${pathname}`;
  return {
    nextUrl: new URL(url),
    url,
    auth,
  };
}

// ---------------------------------------------------------------------------
// Auth mode tests (existing)
// ---------------------------------------------------------------------------

describe("proxy.ts auth enforcement (auth mode)", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsAuthEnabled = true;
    await import("@/proxy");
  });

  describe("/api/auth/* routes", () => {
    it("passes through regardless of auth state", () => {
      const res = capturedHandler(makeReq("/api/auth/callback/google"));
      // NextResponse.next() has no body, just passes through
      expect(res.status).toBe(200);
    });

    it("passes through when authenticated", () => {
      const res = capturedHandler(makeReq("/api/auth/session", { user: { email: "a@b.com" } }));
      expect(res.status).toBe(200);
    });
  });

  describe("/login", () => {
    it("unauthenticated → passes through", () => {
      const res = capturedHandler(makeReq("/login"));
      expect(res.status).toBe(200);
    });

    it("authenticated → redirects to /", () => {
      const res = capturedHandler(makeReq("/login", { user: { email: "a@b.com" } }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/");
    });
  });

  describe("/api/* routes (non-auth)", () => {
    it("unauthenticated → returns 401 JSON { error: 'Unauthorized' }", async () => {
      const res = capturedHandler(makeReq("/api/keys"));
      expect(res.status).toBe(401);
      const body = await new Response(res.body).json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("authenticated → passes through", () => {
      const res = capturedHandler(makeReq("/api/keys", { user: { email: "a@b.com" } }));
      expect(res.status).toBe(200);
    });
  });

  describe("page routes", () => {
    it("unauthenticated → redirects to /login", () => {
      const res = capturedHandler(makeReq("/"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/login");
    });

    it("authenticated → passes through", () => {
      const res = capturedHandler(makeReq("/", { user: { email: "a@b.com" } }));
      expect(res.status).toBe(200);
    });

    it("deep page unauthenticated → redirects to /login", () => {
      const res = capturedHandler(makeReq("/requests"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/login");
    });
  });
});

// ---------------------------------------------------------------------------
// Local mode tests
// ---------------------------------------------------------------------------

describe("proxy.ts local mode (isAuthEnabled = false)", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsAuthEnabled = false;
    await import("@/proxy");
  });

  afterEach(() => {
    mockIsAuthEnabled = true;
  });

  it("/ → passes through (200)", () => {
    const res = capturedHandler(makeReq("/"));
    expect(res.status).toBe(200);
  });

  it("/login → passes through (200)", () => {
    const res = capturedHandler(makeReq("/login"));
    expect(res.status).toBe(200);
  });

  it("/api/keys → passes through (200), not 401", () => {
    const res = capturedHandler(makeReq("/api/keys"));
    expect(res.status).toBe(200);
  });

  it("/api/auth/callback/google → passes through (200)", () => {
    const res = capturedHandler(makeReq("/api/auth/callback/google"));
    expect(res.status).toBe(200);
  });

  it("/models → passes through (200)", () => {
    const res = capturedHandler(makeReq("/models"));
    expect(res.status).toBe(200);
  });

  it("/requests → passes through (200)", () => {
    const res = capturedHandler(makeReq("/requests"));
    expect(res.status).toBe(200);
  });
});
