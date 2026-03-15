import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createModelsRoute } from "../../src/routes/models.ts";
import type { CopilotClient } from "../../src/copilot/client.ts";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function createMockClient(
  modelsData: unknown[] = [],
  opts: { status?: number } = {},
): CopilotClient {
  return {
    chatCompletion: mock(async () => new Response()),
    createEmbedding: mock(async () => new Response()),
    fetchModels: mock(async () => {
      return new Response(JSON.stringify({ data: modelsData }), {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

describe("GET /v1/models", () => {
  test("returns upstream models in OpenAI shape", async () => {
    const upstream = [
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", vendor: "Anthropic" },
      { id: "gpt-5-mini", name: "GPT-5 mini", vendor: "Azure OpenAI" },
    ];
    const client = createMockClient(upstream);
    const app = new Hono();
    app.route("/v1", createModelsRoute({ client, getJwt: () => "jwt" }));

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("claude-sonnet-4");
    expect(body.data[0].object).toBe("model");
    expect(body.data[0].owned_by).toBe("Anthropic");
    expect(body.data[1].id).toBe("gpt-5-mini");
  });

  test("caches response and serves from cache", async () => {
    const client = createMockClient([{ id: "m1", vendor: "v" }]);
    const app = new Hono();
    app.route("/v1", createModelsRoute({ client, getJwt: () => "jwt" }));

    await app.request("/v1/models");
    await app.request("/v1/models");

    const fn = client.fetchModels as ReturnType<typeof mock>;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("refresh=true bypasses cache", async () => {
    const client = createMockClient([{ id: "m1", vendor: "v" }]);
    const app = new Hono();
    app.route("/v1", createModelsRoute({ client, getJwt: () => "jwt" }));

    await app.request("/v1/models");
    await app.request("/v1/models?refresh=true");

    const fn = client.fetchModels as ReturnType<typeof mock>;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("falls back to hardcoded list on upstream error", async () => {
    const client = createMockClient([], { status: 500 });
    const app = new Hono();
    app.route("/v1", createModelsRoute({ client, getJwt: () => "jwt" }));

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    // Fallback should include common models
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("claude-sonnet-4");
  });
});
