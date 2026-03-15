import { Hono } from "hono";
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
import { startKeepalive } from "../util/keepalive.ts";
import { generateRequestId } from "../util/id.ts";
import { logEmitter } from "../util/log-emitter.ts";

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface MessagesRouteOptions {
  client: CopilotClient;
  copilotJwt: string | (() => string);
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

  const { client, copilotJwt: copilotJwtOrGetter } = opts;
  const getJwt =
    typeof copilotJwtOrGetter === "function"
      ? copilotJwtOrGetter
      : () => copilotJwtOrGetter;
  const route = new Hono();

  route.post("/messages", async (c) => {
    const startTime = performance.now();
    const requestId = generateRequestId();
    const accountName = c.get("keyName") ?? "default";

    // Parse incoming Anthropic request
    const anthropicReq = (await c.req.json()) as AnthropicRequest;

    // Translate to OpenAI format
    const openAIReq = translateRequest(anthropicReq);

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_start",
      requestId,
      msg: `POST /v1/messages ${anthropicReq.model}`,
      data: {
        path: "/v1/messages",
        format: "anthropic",
        model: anthropicReq.model,
        stream: anthropicReq.stream ?? false,
        messageCount: anthropicReq.messages.length,
        toolCount: anthropicReq.tools?.length ?? 0,
        translatedModel: openAIReq.model,
        accountName,
      },
    });

    // Resolve JWT at request time (not route creation time)
    const copilotJwt = getJwt();

    // Forward to Copilot API
    let upstream: Response;
    try {
      upstream = await client.chatCompletion(openAIReq, copilotJwt);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      const errorMsg = err instanceof Error ? err.message : "upstream error";
      logEmitter.emitLog({
        ts: Date.now(),
        level: "error",
        type: "upstream_error",
        requestId,
        msg: `upstream connection failed for ${anthropicReq.model}`,
        data: { error: errorMsg, latencyMs },
      });
      logEmitter.emitLog({
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId,
        msg: `502 ${anthropicReq.model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          stream: anthropicReq.stream ?? false,
          latencyMs,
          status: "error",
          statusCode: 502,
          upstreamStatus: null,
          error: errorMsg,
          accountName,
        },
      });
      return c.json({ error: "upstream connection failed" }, 502);
    }

    // Handle upstream errors
    if (!upstream.ok) {
      const body = await upstream.text();
      const latencyMs = Math.round(performance.now() - startTime);
      logEmitter.emitLog({
        ts: Date.now(),
        level: "error",
        type: "upstream_error",
        requestId,
        msg: `upstream ${upstream.status} for ${anthropicReq.model}`,
        data: { statusCode: upstream.status, body: body.slice(0, 500), latencyMs },
      });
      logEmitter.emitLog({
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId,
        msg: `${upstream.status} ${anthropicReq.model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          stream: anthropicReq.stream ?? false,
          latencyMs,
          status: "error",
          statusCode: upstream.status,
          upstreamStatus: upstream.status,
          error: body.slice(0, 500),
          accountName,
        },
      });
      return c.body(body, upstream.status as 429);
    }

    // Non-streaming response
    if (!anthropicReq.stream) {
      const openAIRes = (await upstream.json()) as OpenAIResponse;
      const anthropicRes = translateResponse(openAIRes);
      const latencyMs = Math.round(performance.now() - startTime);

      logEmitter.emitLog({
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId,
        msg: `200 ${anthropicReq.model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: anthropicReq.model,
          resolvedModel: openAIRes.model,
          inputTokens: anthropicRes.usage.input_tokens,
          outputTokens: anthropicRes.usage.output_tokens,
          latencyMs,
          stream: false,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
          accountName,
        },
      });

      return c.json(anthropicRes);
    }

    // Streaming response
    return handleStreamResponse(c, upstream, openAIReq.model, {
      requestId,
      startTime,
      anthropicModel: anthropicReq.model,
      accountName,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------

interface StreamContext {
  requestId: string;
  startTime: number;
  anthropicModel: string;
  accountName?: string;
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
      const ka = startKeepalive(controller);

      try {
        for await (const data of parseSSEStream(upstreamBody)) {
          // null = [DONE] marker
          if (data === null) break;

          const chunk = JSON.parse(data) as OpenAIStreamChunk;

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
            // Debug: emit sse_chunk events for key stream lifecycle moments
            if (
              event.type === "content_block_start" ||
              event.type === "content_block_stop" ||
              event.type === "message_delta"
            ) {
              logEmitter.emitLog({
                ts: Date.now(),
                level: "debug",
                type: "sse_chunk",
                requestId: ctx.requestId,
                msg: `anthropic event: ${event.type}`,
                data: {
                  eventType: event.type,
                  index: "index" in event ? event.index : undefined,
                  ...(event.type === "content_block_start" && {
                    blockType: event.content_block.type,
                    ...("id" in event.content_block && {
                      toolId: event.content_block.id,
                      toolName: (event.content_block as { name: string }).name,
                    }),
                  }),
                },
              });
            }
            const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(line));
          }
          ka.ping();
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
        ka.stop();
        controller.close();

        const latencyMs = Math.round(performance.now() - ctx.startTime);

        // Emit request_end — the DB sink will persist this
        logEmitter.emitLog({
          ts: Date.now(),
          level: streamError ? "error" : "info",
          type: "request_end",
          requestId: ctx.requestId,
          msg: `${streamError ? "error" : "200"} ${ctx.anthropicModel} ${latencyMs}ms`,
          data: {
            path: "/v1/messages",
            format: "anthropic",
            model: ctx.anthropicModel,
            resolvedModel,
            inputTokens,
            outputTokens,
            latencyMs,
            ttftMs,
            stream: true,
            status: streamError ? "error" : "success",
            statusCode: streamError ? 502 : 200,
            upstreamStatus: streamError ? null : 200,
            accountName: ctx.accountName,
            ...(streamError && { error: streamError }),
          },
        });
      }
    },
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return c.body(outputStream);
}
