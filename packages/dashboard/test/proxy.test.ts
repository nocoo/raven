import { describe, it, expect, vi } from "vitest";
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

vi.mock("@/auth", () => ({
  auth: (handler: AuthHandler) => {
    capturedHandler = handler;
    return handler;
  },
}));

// Force module evaluation to capture the handler
await import("@/proxy");

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
// Tests
// ---------------------------------------------------------------------------

describe("proxy.ts auth enforcement", () => {
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
