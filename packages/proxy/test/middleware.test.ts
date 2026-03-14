import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { apiKeyAuth, requestContext } from "../src/middleware.ts";

function createTestApp(apiKey: string) {
  const app = new Hono();
  app.use("*", requestContext());
  app.use("/v1/*", apiKeyAuth(apiKey));
  app.use("/api/*", apiKeyAuth(apiKey));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/v1/models", (c) => {
    const requestId = c.get("requestId");
    const startTime = c.get("startTime");
    return c.json({ requestId, startTime });
  });
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  app.get("/api/stats/overview", (c) => c.json({ ok: true }));
  return app;
}

describe("apiKeyAuth middleware", () => {
  const app = createTestApp("sk-raven-secret");

  test("rejects request without Authorization header", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test("rejects request with wrong API key", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with malformed Authorization header", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "sk-raven-secret" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts request with correct API key", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secret" },
    });
    expect(res.status).toBe(200);
  });

  test("protects /api/* routes", async () => {
    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(401);
  });

  test("allows /api/* with correct key", async () => {
    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer sk-raven-secret" },
    });
    expect(res.status).toBe(200);
  });

  test("does not protect /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  test("skips auth when API key is empty (no key configured)", async () => {
    const noAuthApp = createTestApp("");
    const res = await noAuthApp.request("/v1/models");
    expect(res.status).toBe(200);
  });
});

describe("requestContext middleware", () => {
  const app = createTestApp("sk-raven-secret");

  test("injects requestId and startTime", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBeString();
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(body.startTime).toBeNumber();
    expect(body.startTime).toBeGreaterThan(0);
  });

  test("generates unique requestIds", async () => {
    const res1 = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secret" },
    });
    const res2 = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secret" },
    });
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.requestId).not.toBe(body2.requestId);
  });
});

describe("timing-safe comparison", () => {
  const app = createTestApp("sk-raven-secret");

  test("rejects keys of different length", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects keys of same length but different content", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secre!" },
    });
    expect(res.status).toBe(401);
  });
});
