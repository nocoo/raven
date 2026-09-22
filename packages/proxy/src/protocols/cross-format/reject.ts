import { ClientInputError } from "../../lib/error"
import { isServerSideTool, type AnthropicMessagesPayload } from "../anthropic/types"
import { UNSUPPORTED_CONTENT_TYPES } from "../translate/non-stream-translation"
import type { ChatCompletionsPayload } from "../../upstream/copilot-openai"
import type { ResponsesPayload } from "../../upstream/copilot-responses"

const MESSAGE_BLOCKS = new Set([
  "text",
  "image",
  "tool_use",
  "tool_result",
  "thinking",
])

const RESPONSES_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
])

const RESPONSES_PART_TYPES = new Set(["input_text", "output_text", "input_image"])

export function rejectUnsupportedMessages(
  payload: AnthropicMessagesPayload,
): void {
  if (payload.top_k != null) {
    throw new ClientInputError("top_k is not supported on this conversion")
  }
  if (payload.service_tier != null) {
    throw new ClientInputError("service_tier is not supported on this conversion")
  }
  if (payload.tools) {
    for (const tool of payload.tools) {
      if (isServerSideTool(tool) || (tool.type != null && tool.type !== "custom")) {
        throw new ClientInputError(
          `tool type ${tool.type ?? "unknown"} is not supported on this conversion`,
        )
      }
    }
  }
  for (const message of payload.messages) {
    if (typeof message.content === "string") continue
    for (const block of message.content) {
      if (UNSUPPORTED_CONTENT_TYPES.has(block.type) || !MESSAGE_BLOCKS.has(block.type)) {
        throw new ClientInputError(
          `content block ${block.type} is not supported on this conversion`,
        )
      }
    }
  }
}

export function rejectUnsupportedChat(payload: ChatCompletionsPayload): void {
  const extra = payload as ChatCompletionsPayload & {
    n?: number | null
    modalities?: unknown
    audio?: unknown
    prediction?: unknown
    store?: unknown
    previous_response_id?: unknown
  }
  if (extra.n != null && extra.n !== 1) {
    throw new ClientInputError("n is not supported on this conversion")
  }
  if (extra.modalities != null || extra.audio != null || extra.prediction != null) {
    throw new ClientInputError("audio and prediction fields are not supported on this conversion")
  }
  if (extra.store != null || extra.previous_response_id != null) {
    throw new ClientInputError("stateful chat fields are not supported on this conversion")
  }
  if (payload.response_format != null) {
    throw new ClientInputError(
      "response_format is not supported on this conversion",
    )
  }
  if (payload.tools) {
    for (const tool of payload.tools) {
      const type = (tool as { type?: string }).type
      if (type != null && type !== "function") {
        throw new ClientInputError(`tool type ${type} is not supported on this conversion`)
      }
    }
  }
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const type = (part as { type?: string }).type
      if (type !== "text" && type !== "image_url") {
        throw new ClientInputError(
          `content part ${type ?? "unknown"} is not supported on this conversion`,
        )
      }
    }
  }
}

export function rejectUnsupportedResponses(payload: ResponsesPayload): void {
  if (payload.previous_response_id != null || payload.conversation != null || payload.prompt != null) {
    throw new ClientInputError(
      "previous_response_id, conversation and prompt are not supported on this conversion",
    )
  }
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!tool || typeof tool !== "object") continue
      const type = (tool as { type?: unknown }).type
      if (type != null && type !== "function") {
        throw new ClientInputError(`tool type ${String(type)} is not supported on this conversion`)
      }
    }
  }
  if (typeof payload.input === "string" || payload.input == null) return
  if (!Array.isArray(payload.input)) {
    throw new ClientInputError("responses input must be a string or item list")
  }
  for (const item of payload.input) {
    if (typeof item === "string") continue
    if (!item || typeof item !== "object") {
      throw new ClientInputError("responses input item is not supported on this conversion")
    }
    const record = item as Record<string, unknown>
    if (record.encrypted_content != null) {
      throw new ClientInputError("encrypted reasoning is not supported on this conversion")
    }
    const type = typeof record.type === "string" ? record.type : "message"
    if (record.role != null && type === "message") {
      rejectResponsesContent(record.content)
      continue
    }
    if (!RESPONSES_ITEM_TYPES.has(type)) {
      throw new ClientInputError(`responses item ${type} is not supported on this conversion`)
    }
    if (type === "message") rejectResponsesContent(record.content)
  }
}

function rejectResponsesContent(content: unknown): void {
  if (typeof content === "string" || content == null) return
  if (!Array.isArray(content)) {
    throw new ClientInputError("responses message content is not supported on this conversion")
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      throw new ClientInputError("responses content part is not supported on this conversion")
    }
    const record = part as Record<string, unknown>
    if (record.encrypted_content != null) {
      throw new ClientInputError("encrypted reasoning is not supported on this conversion")
    }
    const type = typeof record.type === "string" ? record.type : "input_text"
    if (!RESPONSES_PART_TYPES.has(type)) {
      throw new ClientInputError(`responses content ${type} is not supported on this conversion`)
    }
  }
}
