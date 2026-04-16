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
// GET /api/settings/socks5
// ===========================================================================

describe("GET /api/settings/socks5", () => {
  it("success → returns JSON with 200", async () => {
    const data = { enabled: false, host: null, port: null };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/settings/socks5/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/settings/socks5");
  });

  it("ProxyError with statusCode → returns that status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { GET } = await import("@/app/api/settings/socks5/route");
    const res = await GET();

    expect(res.status).toBe(404);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("timeout"));

    const { GET } = await import("@/app/api/settings/socks5/route");
    const res = await GET();

    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// PUT /api/settings/socks5
// ===========================================================================

describe("PUT /api/settings/socks5", () => {
  it("success → forwards body and returns 200", async () => {
    const responseData = { enabled: true, host: "proxy.example.com" };
    mockProxyFetch.mockResolvedValueOnce(responseData);

    const { PUT } = await import("@/app/api/settings/socks5/route");
    const req = new Request("http://localhost/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, host: "proxy.example.com" }),
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseData);
    expect(mockProxyFetch).toHaveBeenCalledWith(
      "/api/settings/socks5",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Bad config", 400));

    const { PUT } = await import("@/app/api/settings/socks5/route");
    const req = new Request("http://localhost/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = await PUT(req);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /api/settings/socks5/test
// ===========================================================================

describe("POST /api/settings/socks5/test", () => {
  it("success → forwards body and returns 200", async () => {
    const responseData = { success: true, latencyMs: 120 };
    mockProxyFetch.mockResolvedValueOnce(responseData);

    const { POST } = await import("@/app/api/settings/socks5/test/route");
    const req = new Request("http://localhost/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "proxy.example.com", port: 1080 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseData);
    expect(mockProxyFetch).toHaveBeenCalledWith(
      "/api/settings/socks5/test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Connection refused", 400));

    const { POST } = await import("@/app/api/settings/socks5/test/route");
    const req = new Request("http://localhost/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "bad-host", port: 1080 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("network down"));

    const { POST } = await import("@/app/api/settings/socks5/test/route");
    const req = new Request("http://localhost/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "proxy.example.com", port: 1080 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(502);
  });
});
