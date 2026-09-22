import type { SSEMessage } from "hono/streaming"

import { ClientInputError } from "../../lib/error"
import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTool,
} from "../anthropic/types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "../../upstream/copilot-openai"
import { rejectUnsupportedChat } from "./reject"

/** Anthropic requires max_tokens. Used only when the caller omitted every output cap. */
const DEFAULT_MESSAGES_MAX_TOKENS = 1024

export function chatRequestToMessages(
  chat: ChatCompletionsPayload,
): AnthropicMessagesPayload {
  rejectUnsupportedChat(chat)
  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens ?? DEFAULT_MESSAGES_MAX_TOKENS
  const messages: AnthropicMessage[] = []
  const systemParts: string[] = []
  for (const message of chat.messages) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push(textOf(message.content))
      continue
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: textOf(message.content),
          is_error: null,
        }],
      })
      continue
    }
    if (message.role === "assistant") {
      const blocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = []
      const text = textOf(message.content)
      if (text) blocks.push({ type: "text", text })
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        })
      }
      messages.push({ role: "assistant", content: blocks })
      continue
    }
    messages.push({ role: "user", content: userContent(message) })
  }
  return {
    model: chat.model,
    messages,
    max_tokens: maxTokens,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    metadata: chat.user ? { user_id: chat.user } : null,
    stop_sequences: stopOf(chat.stop),
    stream: chat.stream ?? null,
    temperature: chat.temperature ?? null,
    top_p: chat.top_p ?? null,
    top_k: null,
    tools: chat.tools && chat.tools.length > 0 ? chat.tools.map(toAnthropicTool) : null,
    tool_choice: toAnthropicToolChoice(chat.tool_choice),
    thinking: null,
    service_tier: null,
  }
}

export function anthropicResponseToChat(
  response: AnthropicResponse,
): ChatCompletionResponse {
  const text: string[] = []
  const toolCalls: ToolCall[] = []
  for (const block of response.content) {
    if (block.type === "text") text.push(block.text)
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const cacheRead = response.usage.cache_read_input_tokens ?? 0
  const prompt = response.usage.input_tokens + cacheRead
  const completion = response.usage.output_tokens
  const finish = anthropicStopToChat(response.stop_reason, toolCalls.length > 0)
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    system_fingerprint: null,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text.length > 0 ? text.join("") : null,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
      },
      logprobs: null,
      finish_reason: finish,
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: response.usage.cache_read_input_tokens == null
        ? null
        : { cached_tokens: cacheRead },
    },
  }
}

export interface AnthropicToChatStreamState {
  id: string
  model: string
  created: number
  roleSent: boolean
  toolIndex: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  finishReason: ChatCompletionResponse["choices"][0]["finish_reason"] | null
  inlineFailed: boolean
}

export function initAnthropicToChatStreamState(model: string): AnthropicToChatStreamState {
  return {
    id: "",
    model,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    toolIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    finishReason: null,
    inlineFailed: false,
  }
}

export function adaptAnthropicEventToChatSse(
  event: AnthropicStreamEventData,
  state: AnthropicToChatStreamState,
): SSEMessage[] {
  if (event.type === "message_start") {
    state.id = event.message.id
    state.model = event.message.model || state.model
    state.inputTokens = event.message.usage.input_tokens
    state.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0
    state.cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0
    state.roleSent = true
    return [chatChunk(state, { role: "assistant", content: "" })]
  }
  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    const index = state.toolIndex
    state.toolIndex += 1
    state.finishReason = "tool_calls"
    return [chatChunk(state, {
      tool_calls: [{
        index,
        id: event.content_block.id,
        type: "function",
        function: { name: event.content_block.name, arguments: "" },
      }],
    })]
  }
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    return [chatChunk(state, { content: event.delta.text })]
  }
  if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
    const index = Math.max(0, state.toolIndex - 1)
    return [chatChunk(state, {
      tool_calls: [{ index, function: { arguments: event.delta.partial_json } }],
    })]
  }
  if (event.type === "message_delta") {
    state.outputTokens = event.usage?.output_tokens ?? state.outputTokens
    if (event.usage?.cache_read_input_tokens != null) {
      state.cacheReadTokens = event.usage.cache_read_input_tokens
    }
    if (event.usage?.cache_creation_input_tokens != null) {
      state.cacheCreationTokens = event.usage.cache_creation_input_tokens
    }
    const reason = anthropicStopToChat(event.delta.stop_reason, state.finishReason === "tool_calls")
    state.finishReason = reason
    return [chatChunk(state, {}, reason)]
  }
  if (event.type === "error") {
    state.inlineFailed = true
    return [{
      data: JSON.stringify({
        error: { message: event.error.message, type: event.error.type, code: "stream_error" },
      }),
    }]
  }
  return []
}

export function finalizeAnthropicToChatStream(state: AnthropicToChatStreamState): SSEMessage[] {
  if (state.inlineFailed) return []
  if (!state.finishReason) {
    throw new Error("Truncated stream: message_delta was not received")
  }
  const out: SSEMessage[] = []
  const prompt = state.inputTokens + state.cacheReadTokens
  out.push({
    data: JSON.stringify({
      id: state.id || "chatcmpl-pending",
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: state.outputTokens,
        total_tokens: prompt + state.outputTokens,
        prompt_tokens_details: { cached_tokens: state.cacheReadTokens },
      },
    }),
  })
  out.push({ data: "[DONE]" })
  return out
}

function toAnthropicTool(tool: NonNullable<ChatCompletionsPayload["tools"]>[number]): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? null,
    input_schema: tool.function.parameters ?? {},
    type: "custom",
  }
}

function toAnthropicToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): AnthropicMessagesPayload["tool_choice"] {
  if (choice == null) return null
  if (choice === "auto" || choice === "none") return { type: choice }
  if (choice === "required") return { type: "any" }
  if (typeof choice === "object" && choice.type === "function") {
    if (!choice.function?.name) {
      throw new ClientInputError("tool_choice function requires a name")
    }
    return { type: "tool", name: choice.function.name }
  }
  return null
}

function userContent(message: Message): Extract<AnthropicMessage, { role: "user" }>["content"] {
  if (typeof message.content === "string" || message.content == null) {
    return message.content ?? ""
  }
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text }
    const url = part.image_url.url
    const dataUrl = /^data:([^;]+);base64,(.+)$/.exec(url)
    if (!dataUrl) {
      throw new ClientInputError("only base64 image urls are supported on chat-to-messages")
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: dataUrl[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: dataUrl[2] ?? "",
      },
    }
  })
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((part) => part.type === "text").map((part) => part.text).join("")
}

function stopOf(stop: ChatCompletionsPayload["stop"]): string[] | null {
  if (stop == null) return null
  return Array.isArray(stop) ? stop : [stop]
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    throw new ClientInputError("tool call arguments must be a JSON object")
  }
  throw new ClientInputError("tool call arguments must be a JSON object")
}

function anthropicStopToChat(
  reason: AnthropicResponse["stop_reason"],
  hasTools: boolean,
): ChatCompletionResponse["choices"][0]["finish_reason"] {
  if (hasTools || reason === "tool_use") return "tool_calls"
  if (reason === "max_tokens") return "length"
  if (reason === "refusal") return "content_filter"
  return "stop"
}

function chatChunk(
  state: AnthropicToChatStreamState,
  delta: Record<string, unknown>,
  finish: ChatCompletionResponse["choices"][0]["finish_reason"] | null = null,
): SSEMessage {
  return {
    data: JSON.stringify({
      id: state.id || "chatcmpl-pending",
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }),
  }
}

export function parseAnthropicSseData(data: string): AnthropicStreamEventData | null {
  if (!data || data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null
    return parsed
  } catch {
    return null
  }
}
