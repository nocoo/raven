import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { CopilotClient } from "../copilot/client.ts";
import type {
  AnthropicRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
} from "../translate/types.ts";
import { translateRequest } from "../translate/anthropic-to-openai.ts";
import { translateResponse } from "../translate/openai-to-anthropic.ts";
import { createStreamTranslator } from "../translate/stream.ts";
import { parseSSEStream } from "../util/sse.ts";
import { insertRequest, type RequestRecord } from "../db/requests.ts";
import { logger } from "../util/logger.ts";

// ---------------------------------------------------------------------------
// ULID-like ID generator (timestamp-sortable, no external deps)
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

export interface MessagesRouteOptions {
  client: CopilotClient;
  copilotJwt: string | (() => string);
  db?: Database;
}

/**
 * Create the /v1/messages route that accepts Anthropic format requests,
 * translates to OpenAI format, forwards to Copilot, and translates back.
 */
export function createMessagesRoute(
  clientOrOpts: CopilotClient | MessagesRouteOptions,
  copilotJwtArg?: string,
): Hono {
  // Support both old signature and new options object
  const opts: MessagesRouteOptions =
    "chatCompletion" in clientOrOpts
      ? { client: clientOrOpts, copilotJwt: copilotJwtArg! }
      : clientOrOpts;

  const { client, copilotJwt: copilotJwtOrGetter, db } = opts;
  const getJwt =
    typeof copilotJwtOrGetter === "function"
      ? copilotJwtOrGetter
      : () => copilotJwtOrGetter;
  const route = new Hono();

  route.post("/messages", async (c) => {
    const startTime = performance.now();
    const requestId = generateId();

    // Parse incoming Anthropic request
    const anthropicReq = (await c.req.json()) as AnthropicRequest;

    // Translate to OpenAI format
    const openAIReq = translateRequest(anthropicReq);

    logger.debug("messages request", {
      model: anthropicReq.model,
      stream: anthropicReq.stream ?? false,
      messageCount: anthropicReq.messages.length,
      toolCount: anthropicReq.tools?.length ?? 0,
      translatedModel: openAIReq.model,
    });

    // Resolve JWT at request time (not route creation time)
    const copilotJwt = getJwt();

    // Forward to Copilot API
    let upstream: Response;
    try {
      upstream = await client.chatCompletion(openAIReq, copilotJwt);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      if (db) {
        logRequest(db, {
          id: requestId,
          startTime,
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          stream: anthropicReq.stream ? 1 : 0,
          latencyMs,
          status: "error",
          statusCode: 502,
          upstreamStatus: null,
          errorMessage: err instanceof Error ? err.message : "upstream error",
        });
      }
      return c.json({ error: "upstream connection failed" }, 502);
    }

    // Handle upstream errors
    if (!upstream.ok) {
      const body = await upstream.text();
      const latencyMs = Math.round(performance.now() - startTime);
      if (db) {
        logRequest(db, {
          id: requestId,
          startTime,
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          stream: anthropicReq.stream ? 1 : 0,
          latencyMs,
          status: "error",
          statusCode: upstream.status,
          upstreamStatus: upstream.status,
          errorMessage: body.slice(0, 500),
        });
      }
      return c.body(body, upstream.status as 429);
    }

    // Non-streaming response
    if (!anthropicReq.stream) {
      const openAIRes = (await upstream.json()) as OpenAIResponse;
      const anthropicRes = translateResponse(openAIRes);
      const latencyMs = Math.round(performance.now() - startTime);

      if (db) {
        logRequest(db, {
          id: requestId,
          startTime,
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          resolvedModel: openAIRes.model,
          stream: 0,
          inputTokens: anthropicRes.usage.input_tokens,
          outputTokens: anthropicRes.usage.output_tokens,
          latencyMs,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
        });
      }

      return c.json(anthropicRes);
    }

    // Streaming response
    return handleStreamResponse(c, upstream, openAIReq.model, {
      db,
      requestId,
      startTime,
      anthropicModel: anthropicReq.model,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------

interface StreamContext {
  db?: Database;
  requestId: string;
  startTime: number;
  anthropicModel: string;
}

async function handleStreamResponse(
  c: {
    header: (key: string, value: string) => void;
    body: (stream: ReadableStream) => Response;
  },
  upstream: Response,
  model: string,
  ctx: StreamContext,
): Promise<Response> {
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return c.body(new ReadableStream());
  }

  // Metrics collected during streaming
  let resolvedModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  let ttftMs: number | null = null;
  let firstContentSeen = false;
  let streamError: string | null = null;

  const outputStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let translator: ReturnType<typeof createStreamTranslator> | null = null;

      try {
        for await (const data of parseSSEStream(upstreamBody)) {
          // null = [DONE] marker
          if (data === null) break;

          const chunk = JSON.parse(data) as OpenAIStreamChunk;

          // Debug: log upstream chunk structure (tool calls, finish reason)
          if (chunk.choices[0]?.delta?.tool_calls) {
            logger.debug("upstream chunk: tool_calls", {
              toolCalls: chunk.choices[0].delta.tool_calls.map((tc) => ({
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                argsLen: tc.function?.arguments?.length ?? 0,
              })),
            });
          }
          if (chunk.choices[0]?.finish_reason) {
            logger.debug("upstream chunk: finish", {
              finishReason: chunk.choices[0].finish_reason,
            });
          }

          // Track resolved model
          if (chunk.model) resolvedModel = chunk.model;

          // Track usage from chunks
          if (chunk.usage) {
            inputTokens =
              chunk.usage.prompt_tokens -
              (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0);
            outputTokens = chunk.usage.completion_tokens;
          }

          // Track TTFT
          if (
            !firstContentSeen &&
            chunk.choices[0]?.delta?.content
          ) {
            firstContentSeen = true;
            ttftMs = Math.round(performance.now() - ctx.startTime);
          }

          // Lazily create translator with first chunk's id
          if (!translator) {
            translator = createStreamTranslator(chunk.id, model);
          }

          const events = translator.processChunk(chunk);
          for (const event of events) {
            // Debug: log translated Anthropic events with tool context
            if (
              event.type === "content_block_start" ||
              event.type === "content_block_stop" ||
              event.type === "message_delta"
            ) {
              logger.debug("anthropic event", {
                type: event.type,
                index: "index" in event ? event.index : undefined,
                ...(event.type === "content_block_start" && {
                  blockType: event.content_block.type,
                  ...("id" in event.content_block && {
                    toolId: event.content_block.id,
                    toolName: (event.content_block as { name: string }).name,
                  }),
                }),
              });
            }
            const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(line));
          }
        }
      } catch (err) {
        streamError =
          err instanceof Error ? `stream error: ${err.message}` : "stream error";
        // Emit error event to client before closing
        try {
          const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "stream_error", message: streamError } })}\n\n`;
          controller.enqueue(new TextEncoder().encode(errorEvent));
        } catch {
          // Controller may already be closed
        }
      } finally {
        controller.close();

        // Log after stream completes — use error status if stream failed
        if (ctx.db) {
          const latencyMs = Math.round(performance.now() - ctx.startTime);
          logRequest(ctx.db, {
            id: ctx.requestId,
            startTime: ctx.startTime,
            path: "/v1/messages",
            format: "anthropic",
            model: ctx.anthropicModel,
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
  startTime: number;
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
