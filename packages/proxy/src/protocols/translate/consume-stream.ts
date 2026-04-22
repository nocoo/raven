/**
 * Consume a Copilot streaming response and reassemble it into a
 * non-streaming ChatCompletionResponse.
 *
 * Copilot's non-streaming API does not include tool_calls data. By
 * consuming the stream internally we can extract tool-call information
 * from the incremental delta chunks and reconstruct a coherent
 * response object for non-streaming callers.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "../../services/copilot/create-chat-completions"
import type { ServerSentEvent } from "../../util/sse"

export async function consumeStreamToResponse(
  stream: AsyncGenerator<ServerSentEvent>,
): Promise<ChatCompletionResponse> {
  let id = ""
  let model = ""
  let created = 0
  let content = ""
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"

  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()

  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0

  for await (const event of stream) {
    if (event.data === "[DONE]") break
    if (!event.data) continue

    const chunk = JSON.parse(event.data) as ChatCompletionChunk

    if (!id && chunk.id) id = chunk.id
    if (!model && chunk.model) model = chunk.model
    if (!created && chunk.created) created = chunk.created

    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0
      completionTokens = chunk.usage.completion_tokens ?? 0
      totalTokens = chunk.usage.total_tokens ?? 0
      cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
    }

    const choice = chunk.choices[0]
    if (!choice) continue

    if (choice.delta?.content) {
      content += choice.delta.content
    }

    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (!tc) continue
        const existing = toolCallMap.get(tc.index)
        if (tc.id && tc.function?.name) {
          toolCallMap.set(tc.index, {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? "",
          })
        } else if (existing && tc.function?.arguments) {
          existing.arguments += tc.function.arguments
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  const toolCalls: ToolCall[] = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }))

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    system_fingerprint: null,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  }
}
