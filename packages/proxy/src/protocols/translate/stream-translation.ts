import type { ChatCompletionChunk } from "../../upstream/copilot-openai"

import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "../anthropic/types"
import { mapOpenAIStopReasonToAnthropic } from "./stop-reason"

export interface StreamTranslateOptions {
  /** When true, drop whitespace-only content deltas that produce blank lines in some clients. */
  filterWhitespaceChunks?: boolean
}

function recordToolFragment(
  state: AnthropicStreamState,
  toolCall: {
    index: number
    id: string | null
    function: { name: string | null; arguments: string | null } | null
  },
): void {
  let entry = state.toolCalls[toolCall.index]
  if (!entry) {
    entry = { id: "", name: "", anthropicBlockIndex: -1, fragments: [] }
    state.toolCalls[toolCall.index] = entry
  }
  if (toolCall.id && !entry.id) entry.id = toolCall.id
  if (toolCall.function?.name && !entry.name) entry.name = toolCall.function.name
  if (typeof toolCall.function?.arguments === "string") {
    entry.fragments.push(toolCall.function.arguments)
  }
}

function flushBufferedTools(
  state: AnthropicStreamState,
  events: AnthropicStreamEventData[],
): void {
  const indices = Object.keys(state.toolCalls)
    .map(Number)
    .sort((a, b) => a - b)
  const pending = indices.filter((openaiIndex) => state.toolCalls[openaiIndex]!.anthropicBlockIndex < 0)
  for (const openaiIndex of pending) {
    const tool = state.toolCalls[openaiIndex]!
    if (!tool.id || !tool.name) {
      throw new Error(`Incomplete tool_use metadata for OpenAI tool index ${openaiIndex}`)
    }
  }
  for (const openaiIndex of pending) {
    const tool = state.toolCalls[openaiIndex]!
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }
    tool.anthropicBlockIndex = state.contentBlockIndex
    events.push({
      type: "content_block_start",
      index: tool.anthropicBlockIndex,
      content_block: {
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: {},
      },
    })
    state.contentBlockOpen = true
    for (const fragment of tool.fragments) {
      events.push({
        type: "content_block_delta",
        index: tool.anthropicBlockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: fragment,
        },
      })
    }
    events.push({
      type: "content_block_stop",
      index: tool.anthropicBlockIndex,
    })
    state.contentBlockIndex++
    state.contentBlockOpen = false
    tool.fragments = []
  }
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  originalModel?: string,
  options?: StreamTranslateOptions,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  if (!choice) return events
  const { delta } = choice
  if (!delta) return events

  if (!state.messageStartSent) {
    const usage = chunk.usage
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? null
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: originalModel ?? chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: (usage?.prompt_tokens ?? 0) - (cached ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          cache_creation_input_tokens: null,
          cache_read_input_tokens: cached,
          service_tier: null,
        },
      },
    })
    state.messageStartSent = true
  }

  if (delta.content) {
    // OPT-3: Skip whitespace-only content chunks that cause blank lines in some clients
    const skipWhitespace =
      options?.filterWhitespaceChunks
      && delta.content.trim() === ""
      && !delta.tool_calls?.length
      && !choice.finish_reason

    if (!skipWhitespace) {
      if (!state.contentBlockOpen) {
        events.push({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: {
            type: "text",
            text: "",
          },
        })
        state.contentBlockOpen = true
      }

      events.push({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "text_delta",
          text: delta.content,
        },
      })
    }
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall) recordToolFragment(state, toolCall)
    }
  }

  if (choice.finish_reason) {
    flushBufferedTools(state, events)
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    const usage = chunk.usage
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? null
    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens: (usage?.prompt_tokens ?? 0) - (cached ?? 0),
          output_tokens: usage?.completion_tokens ?? 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: cached,
        },
      },
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
