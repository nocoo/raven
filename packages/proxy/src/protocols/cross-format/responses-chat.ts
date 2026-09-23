import type { SSEMessage } from "hono/streaming"

import { ClientInputError } from "../../lib/error"
import { responsesJsonToChatCompletion } from "../chat-responses/response"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "../../upstream/copilot-openai"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import { rejectUnsupportedResponses } from "./reject"

export function responsesRequestToChat(payload: ResponsesPayload): ChatCompletionsPayload {
  rejectUnsupportedResponses(payload)
  const messages: Message[] = []
  const items = typeof payload.input === "string"
    ? [{ role: "user", content: payload.input }]
    : (payload.input as unknown[] | undefined) ?? []
  for (const item of items) {
    appendResponsesItem(messages, item)
  }
  const chat: ChatCompletionsPayload = { model: payload.model, messages }
  if (payload.stream === true) chat.stream = true
  if (typeof payload.max_output_tokens === "number") chat.max_tokens = payload.max_output_tokens
  if (typeof payload.temperature === "number") chat.temperature = payload.temperature
  if (typeof payload.top_p === "number") chat.top_p = payload.top_p
  if (typeof payload.user === "string") chat.user = payload.user
  const tools = responsesTools(payload.tools)
  if (tools) chat.tools = tools
  const toolChoice = responsesToolChoice(payload.tool_choice)
  if (toolChoice !== undefined) chat.tool_choice = toolChoice
  return chat
}

export function chatJsonToResponses(body: ChatCompletionResponse): Record<string, unknown> {
  const choice = body.choices[0]
  const output: unknown[] = []
  const text = choice?.message.content
  if (typeof text === "string" && text.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    })
  }
  for (const call of choice?.message.tool_calls ?? []) {
    output.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })
  }
  const cached = body.usage?.prompt_tokens_details?.cached_tokens
  return {
    id: body.id,
    object: "response",
    model: body.model,
    status: "completed",
    output,
    usage: body.usage
      ? {
          input_tokens: body.usage.prompt_tokens,
          output_tokens: body.usage.completion_tokens,
          total_tokens: body.usage.total_tokens,
          ...(cached != null ? { input_tokens_details: { cached_tokens: cached } } : {}),
        }
      : null,
  }
}

export function responsesJsonToChat(body: unknown, fallbackModel: string): ChatCompletionResponse {
  return responsesJsonToChatCompletion(body, fallbackModel)
}

export interface ChatToResponsesStreamState {
  id: string
  model: string
  created: number
  sequence: number
  text: string
  textIndex: number | null
  tools: Map<number, { id: string; name: string; arguments: string; itemId: string; outputIndex: number; opened: boolean }>
  itemSeq: number
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"]
  done: boolean
  finalized: boolean
  inlineFailed: boolean
  usage: ChatCompletionChunk["usage"]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export function initChatToResponsesStreamState(model: string): ChatToResponsesStreamState {
  return {
    id: "",
    model,
    created: Math.floor(Date.now() / 1000),
    sequence: 0,
    text: "",
    textIndex: null,
    tools: new Map(),
    itemSeq: 0,
    finishReason: null,
    done: false,
    finalized: false,
    inlineFailed: false,
    usage: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  }
}

export function adaptChatChunkToResponsesSse(
  chunk: ChatCompletionChunk,
  state: ChatToResponsesStreamState,
): SSEMessage[] {
  if (state.finalized || state.inlineFailed) return []
  if (isChatErrorChunk(chunk)) {
    state.inlineFailed = true
    return [responsesEvent(state, "error", { message: chatErrorMessage(chunk) })]
  }
  if (chunk.usage) {
    state.usage = chunk.usage
    state.inputTokens = chunk.usage.prompt_tokens
    state.outputTokens = chunk.usage.completion_tokens
    state.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
  }
  if (state.done) return []
  const out: SSEMessage[] = []
  if (!state.id) {
    state.id = chunk.id || "resp_pending"
    state.model = chunk.model || state.model
    state.created = chunk.created ?? state.created
    const response = streamResponse(state, "in_progress", [])
    out.push(responsesEvent(state, "response.created", { response }))
    out.push(responsesEvent(state, "response.in_progress", { response }))
  }
  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    if (state.textIndex === null) {
      state.textIndex = state.itemSeq++
      out.push(responsesEvent(state, "response.output_item.added", {
        output_index: state.textIndex, item: messageItem(state, "in_progress", []),
      }))
      out.push(responsesEvent(state, "response.content_part.added", {
        ...textLocation(state), part: textPart(""),
      }))
    }
    state.text += delta.content
    out.push(responsesEvent(state, "response.output_text.delta", {
      ...textLocation(state), delta: delta.content, logprobs: [],
    }))
  }
  for (const call of delta?.tool_calls ?? []) {
    if (!call) continue
    const index = call.index ?? state.tools.size
    let tool = state.tools.get(index)
    if (!tool) {
      tool = {
        id: "",
        name: "",
        arguments: "",
        itemId: `fc_${state.id}_${state.itemSeq}`,
        outputIndex: state.itemSeq++,
        opened: false,
      }
      state.tools.set(index, tool)
    }
    if (!tool.opened) {
      if (call.id) tool.id = call.id
      if (call.function?.name) tool.name += call.function.name
    }
    const argumentsDelta = call.function?.arguments ?? ""
    tool.arguments += argumentsDelta
    if (!tool.opened && tool.id && tool.name) {
      tool.opened = true
      out.push(responsesEvent(state, "response.output_item.added", {
        output_index: tool.outputIndex,
        item: {
          id: tool.itemId,
          type: "function_call",
          call_id: tool.id,
          name: tool.name,
          arguments: "",
          status: "in_progress",
        },
      }))
      if (tool.arguments) out.push(responsesEvent(state, "response.function_call_arguments.delta", {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: tool.arguments,
      }))
    } else if (tool.opened && argumentsDelta) {
      out.push(responsesEvent(state, "response.function_call_arguments.delta", {
        item_id: tool.itemId, output_index: tool.outputIndex, delta: argumentsDelta,
      }))
    }
  }
  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason
    state.done = true
  }
  return out
}

function textPart(text: string) {
  return { type: "output_text", text, annotations: [], logprobs: [] }
}

function textLocation(state: ChatToResponsesStreamState) {
  return { item_id: `msg_${state.id}`, output_index: state.textIndex, content_index: 0 }
}

function messageItem(state: ChatToResponsesStreamState, status: string, content: unknown[]) {
  return { id: `msg_${state.id}`, type: "message", role: "assistant", status, content }
}

function streamResponse(state: ChatToResponsesStreamState, status: string, output: unknown[]) {
  const usage = state.usage
  return {
    id: state.id, object: "response", created_at: state.created, model: state.model, status, output,
    error: null,
    incomplete_details: status === "incomplete" ? { reason: state.finishReason === "length" ? "max_output_tokens" : "content_filter" } : null,
    usage: usage ? {
      input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    } : null,
  }
}

export function finalizeChatToResponsesStream(state: ChatToResponsesStreamState): SSEMessage[] {
  if (state.finalized || state.inlineFailed) return []
  assertResponsesStreamCompleted(state)
  if ([...state.tools.values()].some(tool => !tool.opened)) throw new Error("Incomplete tool metadata in Chat stream")
  const status = state.finishReason === "length" || state.finishReason === "content_filter" ? "incomplete" : "completed"
  const out: SSEMessage[] = []
  const output: unknown[] = []
  if (state.textIndex !== null) {
    const part = textPart(state.text)
    const item = messageItem(state, status, [part])
    out.push(responsesEvent(state, "response.output_text.done", { ...textLocation(state), text: state.text, logprobs: [] }))
    out.push(responsesEvent(state, "response.content_part.done", { ...textLocation(state), part }))
    out.push(responsesEvent(state, "response.output_item.done", { output_index: state.textIndex, item }))
    output[state.textIndex] = item
  }
  for (const tool of state.tools.values()) {
    const item = { id: tool.itemId, type: "function_call", call_id: tool.id, name: tool.name, arguments: tool.arguments, status }
    out.push(responsesEvent(state, "response.function_call_arguments.done", {
      item_id: tool.itemId, output_index: tool.outputIndex, arguments: tool.arguments,
    }))
    out.push(responsesEvent(state, "response.output_item.done", { output_index: tool.outputIndex, item }))
    output[tool.outputIndex] = item
  }
  out.push(responsesEvent(state, `response.${status}`, { response: streamResponse(state, status, output) }))
  state.finalized = true
  return out
}

export function assertResponsesStreamCompleted(state: ChatToResponsesStreamState): void {
  if (state.inlineFailed) return
  if (!state.done) {
    throw new Error("Truncated stream: terminal response event was not received")
  }
}

function isChatErrorChunk(chunk: ChatCompletionChunk): boolean {
  return "error" in chunk && (chunk as { error?: unknown }).error != null
}

function chatErrorMessage(chunk: ChatCompletionChunk): string {
  const error = (chunk as { error?: { message?: unknown } }).error
  return typeof error?.message === "string" ? error.message : "Upstream stream failed"
}

function responsesEvent(state: ChatToResponsesStreamState, event: string, body: Record<string, unknown>): SSEMessage {
  return { event, data: JSON.stringify({ type: event, sequence_number: state.sequence++, ...body }) }
}

function appendResponsesItem(messages: Message[], item: unknown): void {
  if (typeof item === "string") {
    messages.push({ role: "user", content: item })
    return
  }
  const record = item as Record<string, unknown>
  if (record.type === "function_call") {
    const call: ToolCall = {
      id: String(record.call_id ?? ""),
      type: "function",
      function: {
        name: String(record.name ?? ""),
        arguments: typeof record.arguments === "string"
          ? record.arguments
          : JSON.stringify(record.arguments ?? {}),
      },
    }
    const last = messages[messages.length - 1]
    if (last?.role === "assistant") {
      last.tool_calls = [...(last.tool_calls ?? []), call]
      return
    }
    messages.push({ role: "assistant", content: null, tool_calls: [call] })
    return
  }
  if (record.type === "function_call_output") {
    messages.push({
      role: "tool",
      tool_call_id: String(record.call_id ?? ""),
      content: typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? ""),
    })
    return
  }
  const role = record.role === "assistant" || record.role === "system" || record.role === "developer"
    ? record.role
    : "user"
  messages.push({ role, content: responsesContent(record.content) })
}

function responsesContent(content: unknown): Message["content"] {
  if (typeof content === "string" || content == null) return content ?? ""
  if (!Array.isArray(content)) {
    throw new ClientInputError("responses message content is not supported on this conversion")
  }
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>
    if (record.type === "input_image" && typeof record.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: record.image_url } })
      continue
    }
    const text = typeof record.text === "string" ? record.text : ""
    parts.push({ type: "text", text })
  }
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text
  return parts
}

function responsesTools(tools: unknown): ChatCompletionsPayload["tools"] {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => {
    const record = tool as Record<string, unknown>
    const fn = (record.function && typeof record.function === "object"
      ? record.function
      : record) as Record<string, unknown>
    return {
      type: "function" as const,
      function: {
        name: String(fn.name ?? record.name ?? ""),
        description: typeof fn.description === "string" ? fn.description : null,
        parameters: (fn.parameters as Record<string, unknown>) ?? {},
      },
    }
  })
}

function responsesToolChoice(choice: unknown): ChatCompletionsPayload["tool_choice"] {
  if (choice == null) return undefined
  if (choice === "auto" || choice === "none" || choice === "required") return choice
  if (typeof choice === "object") {
    const record = choice as { type?: string; name?: string; function?: { name?: string } }
    if (record.type === "function") {
      const name = record.function?.name ?? record.name
      if (!name) throw new ClientInputError("tool_choice function requires a name")
      return { type: "function", function: { name } }
    }
  }
  return undefined
}

export function parseChatChunk(data: string): ChatCompletionChunk | null {
  if (!data || data === "[DONE]") return null
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
