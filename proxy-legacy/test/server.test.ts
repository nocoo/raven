import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app.ts";
import { initDatabase } from "../src/db/requests.ts";
import { initApiKeys, createApiKey } from "../src/db/keys.ts";
import { invalidateKeyCountCache } from "../src/middleware.ts";
import type { CopilotClient } from "../src/copilot/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  initDatabase(db);
  initApiKeys(db);
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
    createEmbedding: mock(async () => {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
  invalidateKeyCountCache();
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
      githubToken: "gho_test_token",
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("GET /v1/models returns model list (dev mode)", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty("id");
    expect(body.data[0]).toHaveProperty("owned_by");
  });

  test("POST /v1/messages routes to messages handler (dev mode)", async () => {
    const client = createMockClient();
    const app = createApp({
      client,
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
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
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
  });

  test("POST /v1/chat/completions routes to chat handler (dev mode)", async () => {
    const client = createMockClient();
    const app = createApp({
      client,
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
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
    expect(body.id).toBe("chatcmpl-123");
    expect(body.choices).toBeDefined();
  });

  test("GET /api/stats/overview returns stats (dev mode)", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
    });

    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("total_requests");
  });

  test("GET /api/requests returns paginated results (dev mode)", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
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
      githubToken: "gho_test_token",
    });

    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// API key middleware (delegates to middleware.ts multiKeyAuth)
// ===========================================================================

describe("API key middleware", () => {
  test("env key set → rejects unauthenticated /v1/* requests", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toHaveProperty("type");
    expect(body.error.type).toBe("authentication_error");
  });

  test("env key set → accepts /v1/* with correct env key", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
  });

  test("env key set → rejects unauthenticated /api/* requests", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(401);
  });

  test("env key set → accepts /api/* with correct env key", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
  });

  test("health endpoint bypasses auth", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  test("DB key → accepts /v1/* with valid rk- key", async () => {
    const created = createApiKey(db, "test-key");

    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      apiKey: "secret-key",
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(200);
  });

  test("dev mode (no env key, no DB keys) → accepts all requests", async () => {
    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
  });

  test("DB key only (no env key) → rejects unauthenticated", async () => {
    createApiKey(db, "test-key");

    const app = createApp({
      client: createMockClient(),
      getJwt: () => "test-jwt",
      db,
      githubToken: "gho_test_token",
    });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
  });
});
