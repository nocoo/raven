import { describe, expect, test } from "bun:test";
import { app } from "../src/index.ts";

describe("Hono server skeleton", () => {
  test("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("GET /v1/models returns empty list", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toEqual([]);
  });

  test("POST /v1/chat/completions returns 501", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(501);
  });

  test("POST /v1/messages returns 501", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(501);
  });

  test("GET /unknown returns 404", async () => {
    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
  });
});
