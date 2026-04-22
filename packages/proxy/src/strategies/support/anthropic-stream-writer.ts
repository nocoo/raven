/**
 * Stream a pre-built `AnthropicResponse` as the Anthropic SSE event
 * sequence (`message_start` → content blocks → `message_delta` →
 * `message_stop`). Used whenever we already have a resolved
 * non-streaming response (e.g., produced by the server-tool loop) but
 * the client asked for `stream: true` and expects the Anthropic event
 * vocabulary.
 *
 * Handles the block types that pre-built responses actually contain:
 *   - `text` (with optional `text_delta`)
 *   - `server_tool_use` (emits a single `input_json_delta` with the
 *     full input JSON)
 *   - `web_search_tool_result` (full `content` array on block_start)
 *
 * Other Anthropic block types (e.g. `tool_use`, `thinking`) never
 * appear here because this writer only runs on responses assembled by
 * `handlePureServerSideTools`.
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AnthropicResponse } from "../../protocols/anthropic/types"

export function streamAnthropicResponse(c: Context, resp: AnthropicResponse) {
  return streamSSE(c, async (sseStream) => {
    await sseStream.writeSSE({
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: resp.id,
          type: "message",
          role: "assistant",
          content: [],
          model: resp.model,
          stop_reason: null,
          stop_sequence: null,
          usage: resp.usage,
        },
      }),
    })

    for (let i = 0; i < resp.content.length; i++) {
      const block = resp.content[i]!

      if (block.type === "server_tool_use") {
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: {
              type: "server_tool_use",
              id: block.id,
              name: block.name,
            },
          }),
        })

        await sseStream.writeSSE({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          }),
        })
      } else if (block.type === "web_search_tool_result") {
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
            },
          }),
        })
      } else if (block.type === "text") {
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" },
          }),
        })

        if (block.text) {
          await sseStream.writeSSE({
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "text_delta", text: block.text },
            }),
          })
        }
      }

      await sseStream.writeSSE({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: i }),
      })
    }

    await sseStream.writeSSE({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: resp.stop_reason,
          stop_sequence: resp.stop_sequence,
        },
        usage: {
          input_tokens: null,
          output_tokens: resp.usage.output_tokens,
          cache_creation_input_tokens: resp.usage.cache_creation_input_tokens,
          cache_read_input_tokens: resp.usage.cache_read_input_tokens,
        },
      }),
    })

    await sseStream.writeSSE({
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop" }),
    })
  })
}
