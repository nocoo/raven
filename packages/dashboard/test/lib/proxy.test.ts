import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// ProxyError — can be imported directly (no env dependency)
// ---------------------------------------------------------------------------

import { ProxyError } from "@/lib/proxy";

describe("ProxyError", () => {
  it("sets name to 'ProxyError'", () => {
    const err = new ProxyError("test");
    expect(err.name).toBe("ProxyError");
  });

  it("stores statusCode", () => {
    const err = new ProxyError("test", 404);
    expect(err.statusCode).toBe(404);
  });

  it("statusCode is undefined when not provided", () => {
    const err = new ProxyError("test");
    expect(err.statusCode).toBeUndefined();
  });

  it("inherits from Error", () => {
    const err = new ProxyError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// proxyFetch — env-dependent, needs resetModules per test
// ---------------------------------------------------------------------------

describe("proxyFetch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  async function importProxy(envOverrides?: Record<string, string>) {
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        vi.stubEnv(key, value);
      }
    }
    return await import("@/lib/proxy");
  }

  it("builds correct URL from PROXY_URL + path", async () => {
    const { proxyFetch } = await importProxy({ RAVEN_PROXY_URL: "http://my-proxy:9000" });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await proxyFetch("/api/test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://my-proxy:9000/api/test");
  });

  it("uses default PROXY_URL when env is not set", async () => {
    const { proxyFetch } = await importProxy({ RAVEN_PROXY_URL: "" });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/api/foo");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // RAVEN_PROXY_URL ?? "..." — empty string is NOT nullish, so URL = "" + "/api/foo"
    expect(url).toBe("/api/foo");
  });

  it("includes Content-Type: application/json header", async () => {
    const { proxyFetch } = await importProxy();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes Authorization header when API_KEY is set", async () => {
    const { proxyFetch } = await importProxy({ RAVEN_API_KEY: "test-key-123" });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key-123");
  });

  it("prefers RAVEN_INTERNAL_KEY over RAVEN_API_KEY", async () => {
    const { proxyFetch } = await importProxy({
      RAVEN_INTERNAL_KEY: "internal-key",
      RAVEN_API_KEY: "api-key",
    });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer internal-key");
  });

  it("omits Authorization header when API_KEY is empty", async () => {
    const { proxyFetch } = await importProxy({
      RAVEN_INTERNAL_KEY: "",
      RAVEN_API_KEY: "",
    });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("merges caller-provided headers", async () => {
    const { proxyFetch } = await importProxy();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test", {
      headers: { "X-Custom": "value" },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sets cache: no-store", async () => {
    const { proxyFetch } = await importProxy();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
  });

  it("returns parsed JSON on 200 response", async () => {
    const { proxyFetch } = await importProxy();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: "hello" }), { status: 200 }),
    );

    const result = await proxyFetch<{ data: string }>("/test");
    expect(result).toEqual({ data: "hello" });
  });

  it("throws ProxyError with status code on non-ok response", async () => {
    const { proxyFetch, ProxyError: PE } = await importProxy();
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    try {
      await proxyFetch("/test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PE);
      expect((err as InstanceType<typeof PE>).statusCode).toBe(404);
    }
  });

  it("throws ProxyError with statusText in message", async () => {
    const { proxyFetch, ProxyError: PE } = await importProxy();
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 503, statusText: "Service Unavailable" }),
    );

    try {
      await proxyFetch("/test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PE);
      const proxyErr = err as InstanceType<typeof PE>;
      expect(proxyErr.message).toContain("503");
      expect(proxyErr.message).toContain("Service Unavailable");
      expect(proxyErr.statusCode).toBe(503);
    }
  });

  it("forwards RequestInit options (method, body)", async () => {
    const { proxyFetch } = await importProxy();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await proxyFetch("/test", {
      method: "POST",
      body: JSON.stringify({ name: "key1" }),
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "key1" }));
  });
});

// ---------------------------------------------------------------------------
// safeFetch — wraps proxyFetch with error handling
// ---------------------------------------------------------------------------

describe("safeFetch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("returns { ok: true, data } on success", async () => {
    const { safeFetch } = await import("@/lib/proxy");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [1, 2, 3] }), { status: 200 }),
    );

    const result = await safeFetch<{ items: number[] }>("/test");
    expect(result).toEqual({ ok: true, data: { items: [1, 2, 3] } });
  });

  it("returns { ok: false, error } on ProxyError", async () => {
    const { safeFetch } = await import("@/lib/proxy");
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );

    const result = await safeFetch("/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }
  });

  it("returns { ok: false, error } on generic Error", async () => {
    const { safeFetch } = await import("@/lib/proxy");
    fetchSpy.mockRejectedValueOnce(new Error("network failure"));

    const result = await safeFetch("/test");
    expect(result).toEqual({ ok: false, error: "network failure" });
  });

  it('returns { ok: false, error: "Unknown error..." } on non-Error throw', async () => {
    const { safeFetch } = await import("@/lib/proxy");
    fetchSpy.mockRejectedValueOnce("string error");

    const result = await safeFetch("/test");
    expect(result).toEqual({ ok: false, error: "Unknown error connecting to proxy" });
  });
});
