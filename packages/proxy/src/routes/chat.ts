import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CopilotClient, ChatCompletionRequest } from "../copilot/client.ts";
import type { OpenAIResponse, OpenAIStreamChunk } from "../translate/types.ts";
import { parseSSEStream } from "../util/sse.ts";
import { insertRequest, type RequestRecord } from "../db/requests.ts";

// ---------------------------------------------------------------------------
// ULID-like ID generator
// ---------------------------------------------------------------------------

function generateId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  )
    .join("")
    .toUpperCase();
  return ts + rand;
}

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface ChatRouteOptions {
  client: CopilotClient;
  copilotJwt: string | (() => string);
  db?: Database;
}

/**
 * Create the /v1/chat/completions route that directly forwards
 * OpenAI format requests to the Copilot API.
 */
export function createChatRoute(opts: ChatRouteOptions): Hono {
  const { client, copilotJwt: copilotJwtOrGetter, db } = opts;
  const getJwt =
    typeof copilotJwtOrGetter === "function"
      ? copilotJwtOrGetter
      : () => copilotJwtOrGetter;
  const route = new Hono();

  route.post("/chat/completions", async (c) => {
    const startTime = performance.now();
    const requestId = generateId();
    const body = (await c.req.json()) as ChatCompletionRequest;

    // Resolve JWT at request time (not route creation time)
    const copilotJwt = getJwt();

    // Forward to Copilot
    let upstream: Response;
    try {
      upstream = await client.chatCompletion(body, copilotJwt);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      if (db) {
        logRequest(db, {
          id: requestId,
          path: "/v1/chat/completions",
          format: "openai",
          model: body.model,
          stream: body.stream ? 1 : 0,
          latencyMs,
          status: "error",
          statusCode: 502,
          upstreamStatus: null,
          errorMessage: err instanceof Error ? err.message : "upstream error",
        });
      }
      return c.json({ error: "upstream connection failed" }, 502);
    }

    // Error passthrough
    if (!upstream.ok) {
      const text = await upstream.text();
      const latencyMs = Math.round(performance.now() - startTime);
      if (db) {
        logRequest(db, {
          id: requestId,
          path: "/v1/chat/completions",
          format: "openai",
          model: body.model,
          stream: body.stream ? 1 : 0,
          latencyMs,
          status: "error",
          statusCode: upstream.status,
          upstreamStatus: upstream.status,
          errorMessage: text.slice(0, 500),
        });
      }
      return c.body(text, upstream.status as 429);
    }

    // Non-streaming
    if (!body.stream) {
      const res = (await upstream.json()) as OpenAIResponse;
      const latencyMs = Math.round(performance.now() - startTime);

      if (db) {
        const cachedTokens =
          res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        logRequest(db, {
          id: requestId,
          path: "/v1/chat/completions",
          format: "openai",
          model: body.model,
          resolvedModel: res.model,
          stream: 0,
          inputTokens: (res.usage?.prompt_tokens ?? 0) - cachedTokens,
          outputTokens: res.usage?.completion_tokens ?? 0,
          latencyMs,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
        });
      }

      return c.json(res);
    }

    // Streaming — passthrough with metrics collection
    return handleStreamPassthrough(c, upstream, {
      db,
      requestId,
      startTime,
      model: body.model,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Stream passthrough
// ---------------------------------------------------------------------------

interface StreamContext {
  db?: Database;
  requestId: string;
  startTime: number;
  model: string;
}

async function handleStreamPassthrough(
  c: {
    header: (key: string, value: string) => void;
    body: (stream: ReadableStream) => Response;
  },
  upstream: Response,
  ctx: StreamContext,
): Promise<Response> {
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return c.body(new ReadableStream());
  }

  let resolvedModel = ctx.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let ttftMs: number | null = null;
  let firstContentSeen = false;
  let streamError: string | null = null;

  const outputStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const data of parseSSEStream(upstreamBody)) {
          if (data === null) {
            // Forward [DONE]
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          }

          // Forward raw SSE data
          controller.enqueue(
            encoder.encode(`data: ${data}\n\n`),
          );

          // Parse for metrics collection
          try {
            const chunk = JSON.parse(data) as OpenAIStreamChunk;
            if (chunk.model) resolvedModel = chunk.model;
            if (chunk.usage) {
              inputTokens =
                chunk.usage.prompt_tokens -
                (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0);
              outputTokens = chunk.usage.completion_tokens;
            }
            if (!firstContentSeen && chunk.choices[0]?.delta?.content) {
              firstContentSeen = true;
              ttftMs = Math.round(performance.now() - ctx.startTime);
            }
          } catch {
            // Parse error for metrics — don't break stream
          }
        }
      } catch (err) {
        streamError =
          err instanceof Error ? `stream error: ${err.message}` : "stream error";
      } finally {
        controller.close();

        if (ctx.db) {
          const latencyMs = Math.round(performance.now() - ctx.startTime);
          logRequest(ctx.db, {
            id: ctx.requestId,
            path: "/v1/chat/completions",
            format: "openai",
            model: ctx.model,
            resolvedModel,
            stream: 1,
            inputTokens,
            outputTokens,
            latencyMs,
            ttftMs,
            status: streamError ? "error" : "success",
            statusCode: streamError ? 502 : 200,
            upstreamStatus: streamError ? null : 200,
            errorMessage: streamError ?? undefined,
          });
        }
      }
    },
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return c.body(outputStream);
}

// ---------------------------------------------------------------------------
// Log helper
// ---------------------------------------------------------------------------

interface LogParams {
  id: string;
  path: string;
  format: string;
  model: string;
  resolvedModel?: string;
  stream: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  ttftMs?: number | null;
  status: string;
  statusCode: number;
  upstreamStatus: number | null;
  errorMessage?: string;
}

function logRequest(db: Database, params: LogParams): void {
  const record: RequestRecord = {
    id: params.id,
    timestamp: Date.now(),
    path: params.path,
    client_format: params.format,
    model: params.model,
    resolved_model: params.resolvedModel ?? null,
    stream: params.stream,
    input_tokens: params.inputTokens ?? null,
    output_tokens: params.outputTokens ?? null,
    latency_ms: params.latencyMs,
    ttft_ms: params.ttftMs ?? null,
    status: params.status,
    status_code: params.statusCode,
    upstream_status: params.upstreamStatus,
    error_message: params.errorMessage ?? null,
    account_name: "default",
  };
  try {
    insertRequest(db, record);
  } catch {
    // Don't let logging failures break the request
  }
}
