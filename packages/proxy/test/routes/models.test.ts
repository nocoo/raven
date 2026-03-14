import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { modelsRoute } from "../../src/routes/models.ts";

describe("GET /v1/models", () => {
  const app = new Hono();
  app.route("/v1", modelsRoute);

  test("returns list of available models", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    // Each model should have id, object, created
    for (const model of body.data) {
      expect(model.id).toBeString();
      expect(model.object).toBe("model");
      expect(model.created).toBeNumber();
    }
  });

  test("includes common Claude models", async () => {
    const res = await app.request("/v1/models");
    const body = await res.json();

    const modelIds = body.data.map((m: { id: string }) => m.id);
    expect(modelIds).toContain("claude-sonnet-4-20250514");
    expect(modelIds).toContain("claude-3.5-sonnet");
  });
});
