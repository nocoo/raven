import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app.ts";
import { initDatabase } from "../src/db/requests.ts";
import type { CopilotClient } from "../src/copilot/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  initDatabase(db);
  return db;
}

function createMockClient(): CopilotClient {
  return {
    chatCompletion: mock(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-123",
          object: "chat.completion",
          created: 1700000000,
          model: "claude-sonnet-4",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello!" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
    fetchModels: mock(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// Health & models
// ===========================================================================

describe("app wiring", () => {
  test("GET /health returns ok", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("GET /v1/models returns model list", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty("id");
    expect(body.data[0]).toHaveProperty("owned_by");
  });

  test("POST /v1/messages routes to messages handler", async () => {
    const client = createMockClient();
    const app = createApp({
      client,
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should be Anthropic response format
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
  });

  test("POST /v1/chat/completions routes to chat handler", async () => {
    const client = createMockClient();
    const app = createApp({
      client,
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should be OpenAI response format (passthrough)
    expect(body.id).toBe("chatcmpl-123");
    expect(body.choices).toBeDefined();
  });

  test("GET /api/stats/overview returns stats", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("total_requests");
  });

  test("GET /api/requests returns paginated results", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/api/requests");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("has_more");
  });

  test("GET /unknown returns 404", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// API key middleware (delegates to middleware.ts apiKeyAuth)
// ===========================================================================

describe("API key middleware", () => {
  test("rejects requests without API key when configured", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    // Should use structured error from apiKeyAuth, not plain string
    expect(body.error).toHaveProperty("type");
    expect(body.error.type).toBe("authentication_error");
  });

  test("accepts requests with correct API key", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
  });

  test("health endpoint bypasses API key check", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "test-github-token",
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  test("/api/* requires API key (no bypass)", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "test-github-token",
    });

    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(401);
  });

  test("/api/* accepts correct API key", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "test-github-token",
    });

    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
  });

  test("no API key configured → accepts all requests", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "test-github-token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
  });
});
