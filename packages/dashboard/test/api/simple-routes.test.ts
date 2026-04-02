import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @/lib/proxy — all BFF routes import proxyFetch from here
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

// Re-export ProxyError from mock for instanceof checks
const { ProxyError } = await import("@/lib/proxy");

beforeEach(() => {
  mockProxyFetch.mockReset();
});

// ===========================================================================
// GET /api/connection-info
// ===========================================================================

describe("GET /api/connection-info", () => {
  it("success → returns JSON with 200", async () => {
    const data = { base_url: "http://localhost:7024", endpoints: {} };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/connection-info/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/connection-info");
  });

  it("ProxyError with statusCode → returns that status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { GET } = await import("@/app/api/connection-info/route");
    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Not Found");
  });

  it("ProxyError without statusCode → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("timeout"));

    const { GET } = await import("@/app/api/connection-info/route");
    const res = await GET();

    expect(res.status).toBe(502);
  });

  it("generic Error → returns 502 with error message", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("network down"));

    const { GET } = await import("@/app/api/connection-info/route");
    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("network down");
  });
});

// ===========================================================================
// GET /api/requests
// ===========================================================================

describe("GET /api/requests", () => {
  it("success → returns JSON with 200", async () => {
    const data = { data: [], total: 0, has_more: false };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/requests/route");
    const req = new Request("http://localhost/api/requests");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/requests");
  });

  it("forwards query params to proxy", async () => {
    mockProxyFetch.mockResolvedValueOnce({ data: [] });

    const { GET } = await import("@/app/api/requests/route");
    const req = new Request("http://localhost/api/requests?cursor=abc&limit=20&sort=timestamp");
    await GET(req);

    expect(mockProxyFetch).toHaveBeenCalledWith(
      "/api/requests?cursor=abc&limit=20&sort=timestamp",
    );
  });

  it("empty query params → path without ?", async () => {
    mockProxyFetch.mockResolvedValueOnce({ data: [] });

    const { GET } = await import("@/app/api/requests/route");
    const req = new Request("http://localhost/api/requests");
    await GET(req);

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/requests");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Server Error", 500));

    const { GET } = await import("@/app/api/requests/route");
    const req = new Request("http://localhost/api/requests");
    const res = await GET(req);

    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/copilot/[...path]
// ===========================================================================

describe("GET /api/copilot/[...path]", () => {
  function makeParams(path: string[]) {
    return { params: Promise.resolve({ path }) };
  }

  it("success → returns JSON with 200", async () => {
    const data = { login: "test-user" };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/copilot/[...path]/route");
    const req = new Request("http://localhost/api/copilot/user");
    const res = await GET(req, makeParams(["user"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
  });

  it("joins path segments correctly", async () => {
    mockProxyFetch.mockResolvedValueOnce({});

    const { GET } = await import("@/app/api/copilot/[...path]/route");
    const req = new Request("http://localhost/api/copilot/models/list");
    await GET(req, makeParams(["models", "list"]));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/copilot/models/list");
  });

  it("forwards query parameters", async () => {
    mockProxyFetch.mockResolvedValueOnce({});

    const { GET } = await import("@/app/api/copilot/[...path]/route");
    const req = new Request("http://localhost/api/copilot/user?refresh=true");
    await GET(req, makeParams(["user"]));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/copilot/user?refresh=true");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Forbidden", 403));

    const { GET } = await import("@/app/api/copilot/[...path]/route");
    const req = new Request("http://localhost/api/copilot/user");
    const res = await GET(req, makeParams(["user"]));

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// GET /api/stats/[...path]
// ===========================================================================

describe("GET /api/stats/[...path]", () => {
  function makeParams(path: string[]) {
    return { params: Promise.resolve({ path }) };
  }

  it("success → returns JSON with 200", async () => {
    const data = { total_requests: 100 };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/stats/[...path]/route");
    const req = new Request("http://localhost/api/stats/overview");
    const res = await GET(req, makeParams(["overview"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
  });

  it("joins path segments correctly", async () => {
    mockProxyFetch.mockResolvedValueOnce({});

    const { GET } = await import("@/app/api/stats/[...path]/route");
    const req = new Request("http://localhost/api/stats/timeseries/hourly");
    await GET(req, makeParams(["timeseries", "hourly"]));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/stats/timeseries/hourly");
  });

  it("forwards query parameters", async () => {
    mockProxyFetch.mockResolvedValueOnce({});

    const { GET } = await import("@/app/api/stats/[...path]/route");
    const req = new Request("http://localhost/api/stats/overview?hours=24");
    await GET(req, makeParams(["overview"]));

    expect(mockProxyFetch).toHaveBeenCalledWith("/api/stats/overview?hours=24");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Gateway Timeout", 504));

    const { GET } = await import("@/app/api/stats/[...path]/route");
    const req = new Request("http://localhost/api/stats/overview");
    const res = await GET(req, makeParams(["overview"]));

    expect(res.status).toBe(504);
  });
});

// ===========================================================================
// GET /api/settings
// ===========================================================================

describe("GET /api/settings", () => {
  it("success → returns JSON with 200", async () => {
    const data = { theme: "dark", lang: "en" };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/settings");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Server Error", 500));

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();

    expect(res.status).toBe(500);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("fail"));

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("fail");
  });
});

// ===========================================================================
// PUT /api/settings
// ===========================================================================

describe("PUT /api/settings", () => {
  it("success → returns JSON with 200", async () => {
    const body = { theme: "light" };
    const data = { theme: "light", lang: "en" };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Bad Request", 400));

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// DELETE /api/settings/[key]
// ===========================================================================

describe("DELETE /api/settings/[key]", () => {
  function makeParams(key: string) {
    return { params: Promise.resolve({ key }) };
  }

  it("success → returns JSON with 200", async () => {
    const data = { theme: "dark" };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { DELETE } = await import("@/app/api/settings/[key]/route");
    const req = new Request("http://localhost/api/settings/lang", { method: "DELETE" });
    const res = await DELETE(req, makeParams("lang"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/settings/lang", { method: "DELETE" });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { DELETE } = await import("@/app/api/settings/[key]/route");
    const req = new Request("http://localhost/api/settings/nope", { method: "DELETE" });
    const res = await DELETE(req, makeParams("nope"));

    expect(res.status).toBe(404);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("timeout"));

    const { DELETE } = await import("@/app/api/settings/[key]/route");
    const req = new Request("http://localhost/api/settings/x", { method: "DELETE" });
    const res = await DELETE(req, makeParams("x"));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("timeout");
  });
});

// ===========================================================================
// GET /api/upstreams
// ===========================================================================

describe("GET /api/upstreams", () => {
  it("success → returns JSON with 200", async () => {
    const data = [
      { id: "p1", name: "TestProvider", base_url: "https://example.com", format: "anthropic" as const,
        api_key_preview: "sk-test...****", model_patterns: ["test"], is_enabled: true,
        created_at: 1234567890, updated_at: 1234567890 },
    ];
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/upstreams/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Server Error", 500));

    const { GET } = await import("@/app/api/upstreams/route");
    const res = await GET();

    expect(res.status).toBe(500);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("network down"));

    const { GET } = await import("@/app/api/upstreams/route");
    const res = await GET();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("network down");
  });
});

// ===========================================================================
// POST /api/upstreams
// ===========================================================================

describe("POST /api/upstreams", () => {
  it("success → returns JSON with 201", async () => {
    const body = { name: "NewProvider", base_url: "https://example.com", format: "openai" as const,
      api_key: "sk-test", model_patterns: ["gpt-*"] };
    const data = { id: "p1", ...body, api_key_preview: "sk-test...****", is_enabled: true,
      created_at: 1234567890, updated_at: 1234567890 };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { POST } = await import("@/app/api/upstreams/route");
    const req = new Request("http://localhost/api/upstreams", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams", {
      method: "POST",
      body: JSON.stringify(body),
    });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Conflict", 409));

    const { POST } = await import("@/app/api/upstreams/route");
    const req = new Request("http://localhost/api/upstreams", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// GET /api/upstreams/[id]
// ===========================================================================

describe("GET /api/upstreams/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns JSON with 200", async () => {
    const data = { id: "p1", name: "TestProvider", base_url: "https://example.com", format: "anthropic" as const,
      api_key_preview: "sk-test...****", model_patterns: ["test"], is_enabled: true,
      created_at: 1234567890, updated_at: 1234567890 };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1");
    const res = await GET(req, makeParams("p1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams/p1");
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { GET } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1");
    const res = await GET(req, makeParams("p1"));

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// PUT /api/upstreams/[id]
// ===========================================================================

describe("PUT /api/upstreams/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns JSON with 200", async () => {
    const body = { name: "UpdatedProvider" };
    const data = { id: "p1", name: "UpdatedProvider", base_url: "https://example.com", format: "anthropic" as const,
      api_key_preview: "sk-test...****", model_patterns: ["test"], is_enabled: true,
      created_at: 1234567890, updated_at: 1234567891 };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { PUT } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const res = await PUT(req, makeParams("p1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams/p1", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Validation Error", 400));

    const { PUT } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req, makeParams("p1"));

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// DELETE /api/upstreams/[id]
// ===========================================================================

describe("DELETE /api/upstreams/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns JSON with 200", async () => {
    const data = { success: true };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { DELETE } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1", { method: "DELETE" });
    const res = await DELETE(req, makeParams("p1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams/p1", { method: "DELETE" });
  });

  it("ProxyError → returns error status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Not Found", 404));

    const { DELETE } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1", { method: "DELETE" });
    const res = await DELETE(req, makeParams("p1"));

    expect(res.status).toBe(404);
  });

  it("generic Error → returns 502", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("timeout"));

    const { DELETE } = await import("@/app/api/upstreams/[id]/route");
    const req = new Request("http://localhost/api/upstreams/p1", { method: "DELETE" });
    const res = await DELETE(req, makeParams("p1"));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("timeout");
  });
});

// ===========================================================================
// GET /api/upstreams/[id]/models
// ===========================================================================

describe("GET /api/upstreams/[id]/models", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("success → returns healthy response with models", async () => {
    const data = {
      healthy: true,
      total: 3,
      models: { omlx: ["model-a", "model-b", "model-c"] },
    };
    mockProxyFetch.mockResolvedValueOnce(data);

    const { GET } = await import("@/app/api/upstreams/[id]/models/route");
    const req = new Request("http://localhost/api/upstreams/p1/models");
    const res = await GET(req, makeParams("p1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect(mockProxyFetch).toHaveBeenCalledWith("/api/upstreams/p1/models");
  });

  it("ProxyError with 502 → returns unhealthy response", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Upstream returned 500", 502));

    const { GET } = await import("@/app/api/upstreams/[id]/models/route");
    const req = new Request("http://localhost/api/upstreams/p1/models");
    const res = await GET(req, makeParams("p1"));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.error).toBeDefined();
  });

  it("generic Error → returns 502 with unhealthy status", async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error("network down"));

    const { GET } = await import("@/app/api/upstreams/[id]/models/route");
    const req = new Request("http://localhost/api/upstreams/p1/models");
    const res = await GET(req, makeParams("p1"));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.error.message).toBe("network down");
  });

  it("provider not found → returns 404 via ProxyError", async () => {
    mockProxyFetch.mockRejectedValueOnce(new ProxyError("Provider not found", 404));

    const { GET } = await import("@/app/api/upstreams/[id]/models/route");
    const req = new Request("http://localhost/api/upstreams/nonexistent/models");
    const res = await GET(req, makeParams("nonexistent"));

    expect(res.status).toBe(404);
  });
});
