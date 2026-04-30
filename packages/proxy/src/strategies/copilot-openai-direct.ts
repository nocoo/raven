// ---------------------------------------------------------------------------
// strategies/copilot-openai-direct.ts (H.2)
//
// First strategy promoted from a Phase-G route shim onto the canonical
// 7-method `Strategy` interface. Mirrors `routes/chat-completions/handler.ts`
// `copilotOpenAIDirectShim` byte-for-byte, with one structural change to
// satisfy §3.7's "strategies/*.ts may not import infra/state": the
// `optToolCallDebug` flag is supplied via factory deps. The composition root
// (H.3) is the only module that reads `state` and threads the flag in.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { logEmitter } from "../util/log-emitter"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../upstream/copilot-openai"
import type { CopilotOpenAIClient } from "../upstream/copilot-openai"

export interface CopilotOpenAIDirectDeps {
  /** Pre-built upstream client (composition wires `buildUpstreamClient("copilot-openai")`). */
  client: CopilotOpenAIClient
  /** When true, emit `tool_call_start` debug events as new tool calls arrive in the stream. */
  toolCallDebug: boolean
}

export interface CopilotDirectStreamState {
  model: string
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  toolCallIds: Set<string>
}

const isNonStreaming = (
  response: ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

export function makeCopilotOpenAIDirect(deps: CopilotOpenAIDirectDeps): Strategy<
  ChatCompletionsPayload,
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionResponse,
  ServerSentEvent,
  SSEMessage,
  CopilotDirectStreamState
> {
  return {
    name: "copilot-openai-direct",

    prepare: (req) => req,

    dispatch: async (up) => {
      const response = await deps.client.send(up)
      if (isNonStreaming(response)) {
        return { kind: "json", body: response }
      }
      return { kind: "stream", chunks: response }
    },

    adaptJson: (resp) => resp,

    initStreamState: (req) => ({
      model: req.model,
      resolvedModel: req.model,
      inputTokens: 0,
      outputTokens: 0,
      toolCallIds: new Set<string>(),
    }),

    adaptChunk: (chunk, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })

      if (chunk.data && chunk.data !== "[DONE]") {
        try {
          const parsed = JSON.parse(chunk.data)
          if (parsed.model) st.resolvedModel = parsed.model
          if (parsed.usage) {
            const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
            st.inputTokens = (parsed.usage.prompt_tokens ?? 0) - cached
            st.outputTokens = parsed.usage.completion_tokens ?? 0
          }

          if (deps.toolCallDebug && parsed.choices?.[0]?.delta?.tool_calls) {
            for (const tc of parsed.choices[0].delta.tool_calls as Array<{
              id?: string; function?: { name?: string }; index?: number
            }>) {
              if (tc.id && tc.function?.name && !st.toolCallIds.has(tc.id)) {
                st.toolCallIds.add(tc.id)
                logEmitter.emitLog({
                  ts: Date.now(), level: "debug", type: "sse_chunk", requestId: ctx.requestId,
                  msg: `tool_call started: ${tc.function.name}`,
                  data: {
                    eventType: "tool_call_start",
                    toolName: tc.function.name,
                    toolId: tc.id,
                    index: tc.index,
                  },
                })
              }
            }
          }
        } catch {
          // Parse error for metrics — don't break stream
        }
      }

      return [chunk as SSEMessage]
    },

    adaptStreamError: () => [
      {
        data: JSON.stringify({
          error: {
            message: "An upstream error occurred during streaming.",
            type: "server_error",
            code: "stream_error",
          },
        }),
      },
    ],

    describeEndLog: (result) => {
      if (result.kind === "json") {
        const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
        const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
        const outputTokens = result.resp.usage?.completion_tokens ?? 0
        return {
          model: result.resp.model,
          resolvedModel: result.resp.model,
          inputTokens,
          outputTokens,
        }
      }
      if (result.kind === "stream") {
        const toolCallCount = result.state.toolCallIds.size
        const debugExtras = deps.toolCallDebug
          ? { toolCallNames: Array.from(result.state.toolCallIds) }
          : {}
        return {
          model: result.state.model,
          resolvedModel: result.state.resolvedModel,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          stopReason: toolCallCount > 0 ? "tool_calls" : "stop",
          toolCallCount,
          ...debugExtras,
        }
      }
      if (result.kind === "error") {
        return { model: result.req.model }
      }
      return {}
    },
  }
}
