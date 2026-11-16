import type { SSEMessage } from "hono/streaming"
import type { Strategy } from "../core/strategy"
import { normalizeUsage } from "../core/usage"
import { HTTPError } from "../lib/error"
import { geminiToChat, type GeminiPayload } from "../protocols/gemini/request"
import { chatToGemini, geminiError, GeminiUpstreamError, object } from "../protocols/gemini/response"
import { chatChunkToGemini, createGeminiStream, finishGeminiStream, type GeminiStreamState } from "../protocols/gemini/stream"
import type { ChatCompletionsPayload } from "../upstream/copilot-openai"
import type { UpstreamResult } from "../upstream/interface"
import type { ServerSentEvent } from "../util/sse"

interface GeminiUpstreamRequest { payload: ChatCompletionsPayload; includeThoughts: boolean }

export function makeGeminiChat(client: { send(payload: ChatCompletionsPayload, signal?: AbortSignal): Promise<UpstreamResult<unknown>> }): Strategy<GeminiPayload, GeminiUpstreamRequest, unknown, unknown, ServerSentEvent, SSEMessage, GeminiStreamState> {
  return {
    name: "gemini-chat",
    prepare: req => ({ payload: geminiToChat(req), includeThoughts: req.generationConfig?.thinkingConfig?.includeThoughts === true }),
    dispatch: async (req, ctx) => {
      let response: UpstreamResult<unknown>
      try { response = await client.send(req.payload, ctx.signal) } catch (error) {
        if (ctx.signal?.aborted || error instanceof Error && error.name === "TimeoutError") throw error
        if (error instanceof HTTPError) throw new HTTPError("Chat upstream request failed", error.status)
        throw new GeminiUpstreamError("Chat upstream transport or response failed")
      }
      const streaming = response != null && typeof response === "object" && Symbol.asyncIterator in response
      if (streaming !== req.payload.stream) throw new GeminiUpstreamError("Upstream response does not match the requested streaming mode")
      return streaming ? { kind: "stream", chunks: response as AsyncIterable<ServerSentEvent> } : { kind: "json", body: response }
    },
    adaptJson: (response, req) => chatToGemini(response, req.includeThoughts),
    initStreamState: req => createGeminiStream(req.payload.model, req.includeThoughts),
    adaptChunk: chatChunkToGemini,
    isStreamTerminal: (_chunk, state) => state.done || state.failed,
    streamOutcome: state => state.failed ? "error" : "success",
    finalizeStream: finishGeminiStream,
    adaptStreamError: () => [{ data: JSON.stringify(geminiError(502, "Upstream Gemini conversion failed")) }],
    describeEndLog: result => {
      const model = result.req.payload.model
      if (result.kind === "error") return { model }
      const response = result.kind === "json" ? object(result.resp) : { model: result.state.model, usage: result.state.usage }
      const usage = normalizeUsage("openai", response.usage)
      return { model, resolvedModel: response.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_tokens, cacheCreationTokens: usage.cache_write_tokens,
      }
    },
  }
}
