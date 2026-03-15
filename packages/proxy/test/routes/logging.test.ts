import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createMessagesRoute } from "../../src/routes/messages.ts";
import { createChatRoute } from "../../src/routes/chat.ts";
import { initDatabase } from "../../src/db/requests.ts";
import { startRequestSink } from "../../src/db/request-sink.ts";
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
// Messages route DB logging (via DB sink)
// ===========================================================================

describe("messages route DB logging", () => {
  let db: Database;
  let stopSink: () => void;

  beforeEach(() => {
    db = createTestDb();
    stopSink = startRequestSink(db);
  });

  afterEach(() => {
    stopSink();
    db.close();
  });

  test("non-streaming success → logs to DB", async () => {
    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route("/v1", createMessagesRoute({ client, copilotJwt: "jwt" }));

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
  });

  test("upstream error → logs error to DB", async () => {
    const client = createMockClient(
      { error: "rate limited" },
      { status: 429 },
    );
    const app = new Hono();
    app.route("/v1", createMessagesRoute({ client, copilotJwt: "jwt" }));

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
  });

  test("streaming → logs after stream completes", async () => {
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
    app.route("/v1", createMessagesRoute({ client, copilotJwt: "jwt" }));

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
  });
});

// ===========================================================================
// Chat route DB logging (via DB sink)
// ===========================================================================

describe("chat route DB logging", () => {
  let db: Database;
  let stopSink: () => void;

  beforeEach(() => {
    db = createTestDb();
    stopSink = startRequestSink(db);
  });

  afterEach(() => {
    stopSink();
    db.close();
  });

  test("non-streaming success → logs to DB", async () => {
    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route("/v1", createChatRoute({ client, copilotJwt: "jwt" }));

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
  });

  test("streaming passthrough → logs after completion", async () => {
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
    app.route("/v1", createChatRoute({ client, copilotJwt: "jwt" }));

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
  });

  test("no db sink → still works without logging", async () => {
    // Stop the sink so there's no DB listener
    stopSink();

    const client = createMockClient(OPENAI_RESPONSE);
    const app = new Hono();
    app.route("/v1", createChatRoute({ client, copilotJwt: "jwt" }));

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
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
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
          controller.error(new Error("upstream connection reset"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
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

describe("messages route stream error logging", () => {
  let db: Database;
  let stopSink: () => void;

  beforeEach(() => {
    db = createTestDb();
    stopSink = startRequestSink(db);
  });

  afterEach(() => {
    stopSink();
    db.close();
  });

  test("stream error → logs error status to DB", async () => {
    const client = createErrorStreamClient();
    const app = new Hono();
    app.route("/v1", createMessagesRoute({ client, copilotJwt: "jwt" }));

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

    await res.text().catch(() => {});

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].status_code).toBe(502);
    expect(rows[0].error_message).toContain("stream");
  });
});

describe("chat route stream error logging", () => {
  let db: Database;
  let stopSink: () => void;

  beforeEach(() => {
    db = createTestDb();
    stopSink = startRequestSink(db);
  });

  afterEach(() => {
    stopSink();
    db.close();
  });

  test("stream error → logs error status to DB", async () => {
    const client = createErrorStreamClient();
    const app = new Hono();
    app.route("/v1", createChatRoute({ client, copilotJwt: "jwt" }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    await res.text().catch(() => {});

    const rows = db.query("SELECT * FROM requests").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].status_code).toBe(502);
    expect(rows[0].error_message).toContain("stream");
  });
});

// ===========================================================================
// JWT getter (live token refresh)
// ===========================================================================

describe("messages route JWT getter", () => {
  test("uses getter function to get fresh JWT per request", async () => {
    let currentJwt = "jwt-v1";
    const jwtGetter = () => currentJwt;

    const client: CopilotClient = {
      chatCompletion: mock(async (_req, _jwt) => {
        return new Response(JSON.stringify(OPENAI_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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

    const app = new Hono();
    app.route("/v1", createMessagesRoute({ client, copilotJwt: jwtGetter }));

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const fn = client.chatCompletion as ReturnType<typeof mock>;
    expect(fn.mock.calls[0][1]).toBe("jwt-v1");

    currentJwt = "jwt-v2";

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(fn.mock.calls[1][1]).toBe("jwt-v2");
  });
});

describe("chat route JWT getter", () => {
  test("uses getter function to get fresh JWT per request", async () => {
    let currentJwt = "jwt-v1";
    const jwtGetter = () => currentJwt;

    const client: CopilotClient = {
      chatCompletion: mock(async (_req, _jwt) => {
        return new Response(JSON.stringify(OPENAI_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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

    const app = new Hono();
    app.route("/v1", createChatRoute({ client, copilotJwt: jwtGetter }));

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const fn = client.chatCompletion as ReturnType<typeof mock>;
    expect(fn.mock.calls[0][1]).toBe("jwt-v1");

    currentJwt = "jwt-v2";

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(fn.mock.calls[1][1]).toBe("jwt-v2");
  });
});
