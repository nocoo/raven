import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @/lib/proxy
// ---------------------------------------------------------------------------

const mockProxyFetch = vi.fn();

vi.mock("@/lib/proxy", () => {
  class ProxyError extends Error {
    constructor(message: string, public readonly statusCode?: number | undefined) {
      super(message);
      this.name = "ProxyError";
    }
  }
  return { proxyFetch: mockProxyFetch, ProxyError };
});

const { ProxyError } = await import("@/lib/proxy");

beforeEach(() => {
  mockProxyFetch.mockReset();
});

// ===========================================================================
// GET /api/keys
// ===========================================================================

describe("GET /api/keys", () => {
  it("success → returns key list as JSON", async () => {
    const data = [{ id: "1", name: "key1", key_prefix: "rk-abc" }];
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/keys/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/keys");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Unauthorized", 401));

    const { GET } = await import("@/app/api/keys/route");
    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Unauthorized");
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("connection refused"));

    const { GET } = await import("@/app/api/keys/route");
    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("connection refused");
  });
});

// ===========================================================================
// POST /api/keys
// ===========================================================================

describe("POST /api/keys", () => {
  it("success → returns 201 with created key data", async () => {
    const data = { id: "1", name: "key1", key: "rk-full-key" };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { POST } = await import("@/app/api/keys/route");
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "key1" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(data);
  });

  it("forwards request body to proxyFetch", async () => {
    mockProxyFetch.mockResolvedValueOnce({});

    const { POST } = await import("@/app/api/keys/route");
    const body = { name: "my-key" };
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await POST(req);

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Conflict", 409));

    const { POST } = await import("@/app/api/keys/route");
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "key1" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// DELETE /api/keys/[id]
// ===========================================================================

describe("DELETE /api/keys/:id", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns JSON", async () => {
    mockProxyFetch.mockResolvedValueOnce({ ok: true });

    const { DELETE } = await import("@/app/api/keys/[id]/route");
    const req = new Request("http://localhost/api/keys/abc123", { method: "DELETE" });
    const res = await DELETE(req, makeParams("abc123"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("extracts id from params promise", async () => {
    mockProxyFetch.mockResolvedValueOnce({ ok: true });

    const { DELETE } = await import("@/app/api/keys/[id]/route");
    const req = new Request("http://localhost/api/keys/xyz", { method: "DELETE" });
    await DELETE(req, makeParams("xyz"));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/keys/xyz", { method: "DELETE" });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { DELETE } = await import("@/app/api/keys/[id]/route");
    const req = new Request("http://localhost/api/keys/abc", { method: "DELETE" });
    const res = await DELETE(req, makeParams("abc"));

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /api/keys/[id]/revoke
// ===========================================================================

describe("POST /api/keys/:id/revoke", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns JSON", async () => {
    mockProxyFetch.mockResolvedValueOnce({ ok: true });

    const { POST } = await import("@/app/api/keys/[id]/revoke/route");
    const req = new Request("http://localhost/api/keys/abc/revoke", { method: "POST" });
    const res = await POST(req, makeParams("abc"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("extracts id from params promise", async () => {
    mockProxyFetch.mockResolvedValueOnce({ ok: true });

    const { POST } = await import("@/app/api/keys/[id]/revoke/route");
    const req = new Request("http://localhost/api/keys/xyz/revoke", { method: "POST" });
    await POST(req, makeParams("xyz"));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/keys/xyz/revoke", { method: "POST" });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Conflict", 409));

    const { POST } = await import("@/app/api/keys/[id]/revoke/route");
    const req = new Request("http://localhost/api/keys/abc/revoke", { method: "POST" });
    const res = await POST(req, makeParams("abc"));

    expect(res.status).toBe(409);
  });
});
