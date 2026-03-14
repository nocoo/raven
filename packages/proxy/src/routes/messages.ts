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

/**
 * Create the /v1/messages route that accepts Anthropic format requests,
 * translates to OpenAI format, forwards to Copilot, and translates back.
 */
export function createMessagesRoute(
  client: CopilotClient,
  copilotJwt: string,
): Hono {
  const route = new Hono();

  route.post("/messages", async (c) => {
    // Parse incoming Anthropic request
    const anthropicReq = (await c.req.json()) as AnthropicRequest;

    // Translate to OpenAI format
    const openAIReq = translateRequest(anthropicReq);

    // Forward to Copilot API
    const upstream = await client.chatCompletion(openAIReq, copilotJwt);

    // Handle upstream errors
    if (!upstream.ok) {
      const body = await upstream.text();
      return c.body(body, upstream.status as 429);
    }

    // Non-streaming response
    if (!anthropicReq.stream) {
      const openAIRes = (await upstream.json()) as OpenAIResponse;
      const anthropicRes = translateResponse(openAIRes);
      return c.json(anthropicRes);
    }

    // Streaming response
    return handleStreamResponse(c, upstream, openAIReq.model);
  });

  return route;
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------

async function handleStreamResponse(
  c: { header: (key: string, value: string) => void; body: (stream: ReadableStream) => Response },
  upstream: Response,
  model: string,
): Promise<Response> {
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return c.body(new ReadableStream());
  }

  const outputStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let translator: ReturnType<typeof createStreamTranslator> | null = null;

      try {
        for await (const data of parseSSEStream(upstreamBody)) {
          // null = [DONE] marker
          if (data === null) break;

          const chunk = JSON.parse(data) as OpenAIStreamChunk;

          // Lazily create translator with first chunk's id
          if (!translator) {
            translator = createStreamTranslator(chunk.id, model);
          }

          const events = translator.processChunk(chunk);
          for (const event of events) {
            const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(line));
          }
        }
      } catch {
        // Stream error — close gracefully
      } finally {
        controller.close();
      }
    },
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return c.body(outputStream);
}
