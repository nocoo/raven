import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { logEmitter } from "~/util/log-emitter"
import { generateRequestId } from "~/util/id"
import { deriveClientIdentity } from "~/util/client-identity"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const model = anthropicPayload.model
  const stream = !!anthropicPayload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const userId = anthropicPayload.metadata?.user_id ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(userId, userAgent, accountName, null)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/messages ${model}`,
    data: {
      path: "/v1/messages", format: "anthropic", model, stream,
      messageCount: anthropicPayload.messages?.length ?? 0,
      toolCount: anthropicPayload.tools?.length ?? 0,
      accountName, sessionId, clientName, clientVersion,
    },
  })

  // ---------------------------------------------------------------------------
  // Web Search interception — Tavily
  //
  // Claude Code sends a dedicated sub-request for web search with a server tool
  // ({type: "web_search_20250305"}) in the tools array.  The Copilot upstream
  // does not support Anthropic server tools, so the request would fail silently.
  //
  // When TAVILY_API_KEY is configured we short-circuit the request here: call
  // Tavily for search results and return an Anthropic-native response containing
  // server_tool_use + web_search_tool_result blocks that Claude Code expects.
  // ---------------------------------------------------------------------------
  const webSearchServerTool = (anthropicPayload as Record<string, unknown>).tools
    ? (anthropicPayload.tools as Array<Record<string, unknown>>)?.find(
        (t) => typeof t.type === "string" && (t.type as string).startsWith("web_search_"),
      )
    : undefined

  if (webSearchServerTool && process.env.TAVILY_API_KEY) {
    // Extract the search query from the first user message.
    // Claude Code sends: "Perform a web search for the query: <query>"
    const firstMsg = anthropicPayload.messages[0]
    const rawContent =
      typeof firstMsg?.content === "string"
        ? firstMsg.content
        : Array.isArray(firstMsg?.content)
          ? firstMsg.content
              .filter((b) => "text" in b && b.type === "text")
              .map((b) => ("text" in b ? (b as { text: string }).text : ""))
              .join(" ")
          : ""
    const query =
      rawContent.replace(/^Perform a web search for the query:\s*/i, "").trim() || rawContent

    // Call Tavily
    let searchResults: Array<{ url: string; title: string; content: string }> = []
    try {
      const tavilyResp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({ query, max_results: 5 }),
      })
      const tavilyData = (await tavilyResp.json()) as {
        results?: Array<{ url: string; title: string; content: string }>
      }
      searchResults = tavilyData.results ?? []
    } catch {
      // Tavily unavailable — we'll return empty results below
    }

    // Build Anthropic-native response blocks
    const srvId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const webResults = searchResults.map((r) => ({
      type: "web_search_result" as const,
      url: r.url,
      title: r.title,
      encrypted_content: "" as const,
      page_age: null as null,
    }))
    const summaryText = searchResults.length
      ? searchResults.map((r) => `${r.title}\n${r.url}\n${r.content}`).join("\n\n---\n\n")
      : "No results found."

    const contentBlocks = [
      { type: "server_tool_use" as const, id: srvId, name: "web_search", input: { query } },
      { type: "web_search_tool_result" as const, tool_use_id: srvId, content: webResults },
      { type: "text" as const, text: summaryText },
    ]
    const responseBody = {
      id: `msg_${requestId}`,
      type: "message" as const,
      role: "assistant" as const,
      model,
      content: contentBlocks,
      stop_reason: "end_turn" as const,
      stop_sequence: null as null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }

    const latencyMs = Math.round(performance.now() - startTime)
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 web_search (tavily) ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model,
        latencyMs, stream, status: "success", statusCode: 200,
        accountName, sessionId, clientName, clientVersion,
      },
    })

    if (!stream) {
      return c.json(responseBody)
    }

    // Streaming: emit SSE events matching the Anthropic streaming protocol.
    // Claude Code parses server_tool_use via content_block_start, reads the
    // query from input_json_delta, and reads results from content_block_start
    // of web_search_tool_result.
    return streamSSE(c, async (sseStream) => {
      const emit = (event: string, data: unknown) =>
        sseStream.writeSSE({ event, data: JSON.stringify(data) })

      await emit("message_start", {
        type: "message_start",
        message: { ...responseBody, content: [], stop_reason: null },
      })

      for (let i = 0; i < contentBlocks.length; i++) {
        await emit("content_block_start", {
          type: "content_block_start",
          index: i,
          content_block: contentBlocks[i],
        })
        // Claude Code extracts the search query from input_json_delta events
        if (contentBlocks[i].type === "server_tool_use") {
          await emit("content_block_delta", {
            type: "content_block_delta",
            index: i,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(contentBlocks[i].input),
            },
          })
        }
        await emit("content_block_stop", { type: "content_block_stop", index: i })
      }

      await emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      })
      await emit("message_stop", { type: "message_stop" })
    })
  }
  // --- End Web Search interception ---

  const openAIPayload = translateToOpenAI(anthropicPayload)

  try {
    const response = await createChatCompletions(openAIPayload)

    if (isNonStreaming(response)) {
      const anthropicResponse = translateToAnthropic(response)
      const latencyMs = Math.round(performance.now() - startTime)
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (response.usage?.prompt_tokens ?? 0) - cachedTokens
      const outputTokens = response.usage?.completion_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages", format: "anthropic", model,
          resolvedModel: response.model,
          translatedModel: openAIPayload.model,
          inputTokens, outputTokens, latencyMs,
          ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(anthropicResponse)
    }

    // Streaming
    let resolvedModel = model
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null

    return streamSSE(c, async (sseStream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }

      try {
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") break
          if (!rawEvent.data) continue

          if (firstChunkTime === null) firstChunkTime = performance.now()

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

          // Extract metrics
          if (chunk.model) resolvedModel = chunk.model
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
            outputTokens = chunk.usage.completion_tokens ?? 0
          }

          const events = translateChunkToAnthropicEvents(chunk, streamState)

          for (const event of events) {
            await sseStream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"

        // Send Anthropic error event so the client knows the stream failed
        try {
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await sseStream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
        } catch {
          // Best-effort — connection may already be closed
        }
      } finally {
        const endTime = performance.now()
        const latencyMs = Math.round(endTime - startTime)
        const ttftMs = firstChunkTime !== null ? Math.round(firstChunkTime - startTime) : null
        const processingMs = firstChunkTime !== null ? Math.round(endTime - firstChunkTime) : null
        logEmitter.emitLog({
          ts: Date.now(), level: streamError ? "error" : "info",
          type: "request_end", requestId,
          msg: `${streamError ? "error" : "200"} ${model} ${latencyMs}ms`,
          data: {
            path: "/v1/messages", format: "anthropic", model,
            resolvedModel, translatedModel: openAIPayload.model,
            inputTokens, outputTokens, latencyMs, ttftMs, processingMs,
            stream: true, status: streamError ? "error" : "success",
            statusCode: streamError ? 502 : 200,
            upstreamStatus: streamError ? null : 200,
            accountName, sessionId, clientName, clientVersion,
            ...(streamError && { error: streamError }),
          },
        })
      }
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `502 ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        latencyMs, status: "error", statusCode: 502,
        upstreamStatus: null, error: errorMsg, accountName,
        sessionId, clientName, clientVersion,
      },
    })
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
