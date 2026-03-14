import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createMessagesRoute } from "../../src/routes/messages.ts";
import { createChatRoute } from "../../src/routes/chat.ts";
import { initDatabase } from "../../src/db/requests.ts";
import type { CopilotClient } from "../../src/copilot/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(
  responseBody: unknown,
  options: { stream?: boolean; status?: number } = {},
): CopilotClient {
  return {
    chatCompletion: mock(async () => {
      if (options.stream) {
        const body = responseBody as string;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        });
        return new Response(stream, {
          status: options.status ?? 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(responseBody), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  initDatabase(db);
  return db;
}

const OPENAI_RESPONSE = {
  id: "chatcmpl-123",
  object: "chat.completion",
  created: 1700000000,
  model: "claude-sonnet-4",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi!" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
};

// ===========================================================================
// Messages route DB logging
// ===========================================================================

describe("messages route DB logging", () => {
  test("non-streaming success → logs to DB", async () => {
    const db = createTestDb();
    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route(
      "/v1",
      createMessagesRoute({ client, copilotJwt: "jwt", db }),
    );

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/v1/messages");
    expect(rows[0].client_format).toBe("anthropic");
    expect(rows[0].model).toBe("claude-sonnet-4-20250514");
    expect(rows[0].status).toBe("success");
    expect(rows[0].input_tokens).toBe(10);
    expect(rows[0].output_tokens).toBe(5);
    db.close();
  });

  test("upstream error → logs error to DB", async () => {
    const db = createTestDb();
    const client = createMockClient(
      { error: "rate limited" },
      { status: 429 },
    );
    const app = new Hono();
    app.route(
      "/v1",
      createMessagesRoute({ client, copilotJwt: "jwt", db }),
    );

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].status_code).toBe(429);
    db.close();
  });

  test("streaming → logs after stream completes", async () => {
    const db = createTestDb();
    const sseBody = [
      `data: ${JSON.stringify({
        id: "s1", object: "chat.completion.chunk", created: 0, model: "claude-sonnet-4",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "s1", object: "chat.completion.chunk", created: 0, model: "claude-sonnet-4",
        choices: [{ index: 0, delta: { content: "Hello!" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "s1", object: "chat.completion.chunk", created: 0, model: "claude-sonnet-4",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const client = createMockClient(sseBody, { stream: true });
    const app = new Hono();
    app.route(
      "/v1",
      createMessagesRoute({ client, copilotJwt: "jwt", db }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    // Consume the stream to trigger logging
    await res.text();

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].stream).toBe(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].output_tokens).toBe(3);
    expect(rows[0].ttft_ms).toBeDefined();
    db.close();
  });
});

// ===========================================================================
// Chat route DB logging
// ===========================================================================

describe("chat route DB logging", () => {
  test("non-streaming success → logs to DB", async () => {
    const db = createTestDb();
    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route(
      "/v1",
      createChatRoute({ client, copilotJwt: "jwt", db }),
    );

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/v1/chat/completions");
    expect(rows[0].client_format).toBe("openai");
    expect(rows[0].model).toBe("gpt-4o");
    expect(rows[0].status).toBe("success");
    db.close();
  });

  test("streaming passthrough → logs after completion", async () => {
    const db = createTestDb();
    const sseBody = [
      `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const client = createMockClient(sseBody, { stream: true });
    const app = new Hono();
    app.route(
      "/v1",
      createChatRoute({ client, copilotJwt: "jwt", db }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    await res.text();

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].stream).toBe(1);
    expect(rows[0].status).toBe("success");
    db.close();
  });

  test("no db → still works without logging", async () => {
    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route(
      "/v1",
      createChatRoute({ client, copilotJwt: "jwt" }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Stream error logging
// ===========================================================================

function createErrorStreamClient(): CopilotClient {
  return {
    chatCompletion: mock(async () => {
      // Stream that errors mid-way
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Send one valid chunk, then error
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "err1",
                object: "chat.completion.chunk",
                created: 0,
                model: "claude-sonnet-4",
                choices: [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null },
                ],
              })}\n\n`,
            ),
          );
          // Simulate upstream error mid-stream
          controller.error(new Error("upstream connection reset"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  };
}

describe("messages route stream error logging", () => {
  test("stream error → logs error status to DB", async () => {
    const db = createTestDb();
    const client = createErrorStreamClient();
    const app = new Hono();
    app.route(
      "/v1",
      createMessagesRoute({ client, copilotJwt: "jwt", db }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    // Consume the stream to trigger finally block
    await res.text().catch(() => {});

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].status_code).toBe(502);
    expect(rows[0].error_message).toContain("stream");
    db.close();
  });
});

describe("chat route stream error logging", () => {
  test("stream error → logs error status to DB", async () => {
    const db = createTestDb();
    const client = createErrorStreamClient();
    const app = new Hono();
    app.route(
      "/v1",
      createChatRoute({ client, copilotJwt: "jwt", db }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    // Consume the stream to trigger finally block
    await res.text().catch(() => {});

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].status_code).toBe(502);
    expect(rows[0].error_message).toContain("stream");
    db.close();
  });
});
