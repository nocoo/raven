import type {
  OpenAIStreamChunk,
  AnthropicStreamEvent,
  AnthropicResponse,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

interface ToolCallInfo {
  id: string;
  name: string;
  blockIndex: number;
}

interface StreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  currentBlockType: "text" | "tool_use" | null;
  toolCalls: Map<number, ToolCallInfo>; // OpenAI tool_call index → info
  inputTokens: number; // captured from first chunk for final usage
  cacheReadInputTokens: number;
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(
  finishReason: string | null,
): AnthropicResponse["stop_reason"] {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return null;
  }
}

// ===========================================================================
// StreamTranslator
// ===========================================================================

export interface StreamTranslator {
  processChunk(chunk: OpenAIStreamChunk): AnthropicStreamEvent[];
}

export function createStreamTranslator(
  responseId: string,
  model: string,
): StreamTranslator {
  const state: StreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    toolCalls: new Map(),
    inputTokens: 0,
    cacheReadInputTokens: 0,
  };

  return {
    processChunk(chunk: OpenAIStreamChunk): AnthropicStreamEvent[] {
      const events: AnthropicStreamEvent[] = [];
      const choice = chunk.choices[0];
      if (!choice) return events;

      const { delta, finish_reason } = choice;

      // ---------------------------------------------------------------
      // 1. message_start (emitted once on first chunk)
      // ---------------------------------------------------------------
      if (!state.messageStartSent) {
        const cachedTokens =
          chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const promptTokens = chunk.usage?.prompt_tokens ?? 0;

        events.push({
          type: "message_start",
          message: {
            id: responseId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: promptTokens - cachedTokens,
              output_tokens: 0,
              ...(cachedTokens > 0 && {
                cache_read_input_tokens: cachedTokens,
              }),
            },
          },
        });
        state.inputTokens = promptTokens - cachedTokens;
        state.cacheReadInputTokens = cachedTokens;
        state.messageStartSent = true;
      }

      // ---------------------------------------------------------------
      // 2. Text content delta
      // ---------------------------------------------------------------
      if (delta.content) {
        if (
          !state.contentBlockOpen ||
          state.currentBlockType !== "text"
        ) {
          // Close previous block if open
          if (state.contentBlockOpen) {
            events.push({
              type: "content_block_stop",
              index: state.contentBlockIndex,
            });
            state.contentBlockIndex++;
          }

          // Open new text block
          events.push({
            type: "content_block_start",
            index: state.contentBlockIndex,
            content_block: { type: "text", text: "" } as const,
          });
          state.contentBlockOpen = true;
          state.currentBlockType = "text";
        }

        events.push({
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // ---------------------------------------------------------------
      // 3. Tool call deltas
      // ---------------------------------------------------------------
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const isNew = tc.id !== undefined && !state.toolCalls.has(tc.index);

          if (isNew) {
            // Close previous block if open
            if (state.contentBlockOpen) {
              events.push({
                type: "content_block_stop",
                index: state.contentBlockIndex,
              });
              state.contentBlockIndex++;
            }

            // Register new tool call
            const info: ToolCallInfo = {
              id: tc.id!,
              name: tc.function?.name ?? "",
              blockIndex: state.contentBlockIndex,
            };
            state.toolCalls.set(tc.index, info);

            // Open tool_use block
            events.push({
              type: "content_block_start",
              index: state.contentBlockIndex,
              content_block: {
                type: "tool_use",
                id: info.id,
                name: info.name,
                input: "",
              } as const,
            });
            state.contentBlockOpen = true;
            state.currentBlockType = "tool_use";
          }

          // Emit input_json_delta
          const args = tc.function?.arguments;
          if (args) {
            const info = state.toolCalls.get(tc.index);
            if (info) {
              events.push({
                type: "content_block_delta",
                index: info.blockIndex,
                delta: { type: "input_json_delta", partial_json: args },
              });
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // 5. finish_reason → close block + message_delta + message_stop
      // ---------------------------------------------------------------
      if (finish_reason) {
        if (state.contentBlockOpen) {
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          });
          state.contentBlockOpen = false;
        }

        const outputTokens = chunk.usage?.completion_tokens ?? 0;

        events.push({
          type: "message_delta",
          delta: {
            stop_reason: mapStopReason(finish_reason),
            stop_sequence: null,
          },
          usage: {
            output_tokens: outputTokens,
            input_tokens: state.inputTokens,
            ...(state.cacheReadInputTokens > 0 && {
              cache_read_input_tokens: state.cacheReadInputTokens,
            }),
          },
        });

        events.push({ type: "message_stop" });
      }

      return events;
    },
  };
}
