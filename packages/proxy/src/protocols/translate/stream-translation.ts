import { type ChatCompletionChunk } from "../../upstream/copilot-openai"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "../anthropic/types"
import { mapOpenAIStopReasonToAnthropic } from "./stop-reason"

export interface StreamTranslateOptions {
  /** When true, drop whitespace-only content deltas that produce blank lines in some clients. */
  filterWhitespaceChunks?: boolean
}

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  // Optimized: iterate without creating intermediate array
  for (const key in state.toolCalls) {
    if (state.toolCalls[key]!.anthropicBlockIndex === state.contentBlockIndex) {
      return true
    }
  }
  return false
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
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          cache_creation_input_tokens: null,
          cache_read_input_tokens: chunk.usage?.prompt_tokens_details?.cached_tokens ?? null,
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
      if (isToolBlockOpen(state)) {
        // A tool block was open, so close it before starting a text block.
        events.push({
          type: "content_block_stop",
          index: state.contentBlockIndex,
        })
        state.contentBlockIndex++
        state.contentBlockOpen = false
      }

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
      if (toolCall && toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall && toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: chunk.usage?.prompt_tokens_details?.cached_tokens ?? null,
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
