import type { SSEMessage } from "hono/streaming"

import type { ServerSentEvent } from "../../util/sse"
import {
  extractResolvedModel,
  extractUsage,
} from "../responses/stream-state"
import type { ChatFinishReason, ChatViaResponsesStreamState } from "./types"

export function initChatViaResponsesStreamState(opts: {
  model: string
  includeUsage: boolean
}): ChatViaResponsesStreamState {
  return {
    id: "",
    model: opts.model,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    toolCallIndexByItemId: new Map(),
    callIdByItemId: new Map(),
    nextToolIndex: 0,
    finishReason: null,
    includeUsage: opts.includeUsage,
    inputTokens: 0,
    outputTokens: 0,
    done: false,
    failed: false,
  }
}

export class ResponsesStreamFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesStreamFailedError"
  }
}

/**
 * Convert one Responses SSE event into zero or more Chat Completions SSE messages.
 * Throws on failure events so Runner invokes adaptStreamError.
 */
export function adaptResponsesEventToChatChunks(
  chunk: ServerSentEvent,
  st: ChatViaResponsesStreamState,
): SSEMessage[] {
  if (st.done || st.failed) return []

  const eventName = chunk.event ?? parseType(chunk.data)
  const data = chunk.data ?? ""

  if (eventName === "error" || eventName === "response.failed") {
    st.failed = true
    const msg = extractErrorMessage(data) || "Responses stream failed"
    throw new ResponsesStreamFailedError(msg)
  }

  // Also treat typed failed inside data without event field
  const typed = parseType(data)
  if (typed === "response.failed" || typed === "error") {
    st.failed = true
    throw new ResponsesStreamFailedError(
      extractErrorMessage(data) || "Responses stream failed",
    )
  }

  const out: SSEMessage[] = []

  if (eventName === "response.created" || typed === "response.created") {
    applyCreated(data, st)
    if (!st.roleSent) {
      out.push(...emitRoleChunk(st))
    }
    return out
  }

  if (
    eventName === "response.output_text.delta" ||
    typed === "response.output_text.delta"
  ) {
    ensureMeta(st, data)
    if (!st.roleSent) out.push(...emitRoleChunk(st))
    const delta = extractDeltaText(data)
    if (delta) {
      out.push(chatChunk(st, { content: delta }))
    }
    return out
  }

  if (
    eventName === "response.output_item.added" ||
    typed === "response.output_item.added"
  ) {
    ensureMeta(st, data)
    const item = extractItem(data)
    if (item?.type === "function_call") {
      if (!st.roleSent) out.push(...emitRoleChunk(st))
      const itemId = item.id ?? `item_${st.nextToolIndex}`
      const callId = item.call_id
      if (!callId) {
        st.failed = true
        throw new ResponsesStreamFailedError(
          "function_call item missing call_id",
        )
      }
      const index = st.nextToolIndex++
      st.toolCallIndexByItemId.set(itemId, index)
      st.callIdByItemId.set(itemId, callId)
      st.finishReason = "tool_calls"
      out.push(
        chatChunk(st, {
          tool_calls: [
            {
              index,
              id: callId,
              type: "function",
              function: {
                name: item.name ?? "",
                arguments: "",
              },
            },
          ],
        }),
      )
    }
    return out
  }

  if (
    eventName === "response.function_call_arguments.delta" ||
    typed === "response.function_call_arguments.delta"
  ) {
    ensureMeta(st, data)
    const itemId = extractItemId(data)
    const delta = extractDeltaText(data) || extractArgsDelta(data)
    if (itemId != null && delta) {
      const index = st.toolCallIndexByItemId.get(itemId)
      if (index === undefined) {
        // Must not invent incomplete tool_calls (missing id/type/name) or
        // substitute item id for call_id — violates call_id invariant.
        st.failed = true
        throw new ResponsesStreamFailedError(
          "function_call_arguments.delta before output_item.added with call_id",
        )
      }
      st.finishReason = "tool_calls"
      if (!st.roleSent) out.push(...emitRoleChunk(st))
      out.push(
        chatChunk(st, {
          tool_calls: [
            {
              index,
              function: { arguments: delta },
            },
          ],
        }),
      )
    }
    return out
  }

  if (
    eventName === "response.refusal.delta" ||
    typed === "response.refusal.delta"
  ) {
    ensureMeta(st, data)
    if (!st.roleSent) out.push(...emitRoleChunk(st))
    const delta = extractDeltaText(data)
    if (delta) {
      out.push(chatChunk(st, { refusal: delta }))
    }
    return out
  }

  if (
    eventName === "response.completed" ||
    eventName === "response.incomplete" ||
    eventName === "response.done" ||
    typed === "response.completed" ||
    typed === "response.incomplete" ||
    typed === "response.done"
  ) {
    ensureMeta(st, data)
    applyUsage(data, st)
    applyTerminalFinishReason(eventName || typed || "", data, st)
    if (!st.roleSent) out.push(...emitRoleChunk(st))
    out.push(chatChunk(st, {}, st.finishReason ?? "stop"))
    if (st.includeUsage) {
      out.push(usageChunk(st))
    }
    out.push({ data: "[DONE]" })
    st.done = true
    return out
  }

  // Ignore other events (reasoning, etc.)
  return out
}

function emitRoleChunk(st: ChatViaResponsesStreamState): SSEMessage[] {
  st.roleSent = true
  return [chatChunk(st, { role: "assistant", content: "" })]
}

function chatChunk(
  st: ChatViaResponsesStreamState,
  delta: Record<string, unknown>,
  finish_reason: ChatFinishReason | null = null,
): SSEMessage {
  return {
    data: JSON.stringify({
      id: st.id || "chatcmpl-pending",
      object: "chat.completion.chunk",
      created: st.created,
      model: st.model,
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          delta,
          logprobs: null,
          finish_reason,
        },
      ],
    }),
  }
}

function usageChunk(st: ChatViaResponsesStreamState): SSEMessage {
  const prompt_tokens = st.inputTokens
  const completion_tokens = st.outputTokens
  return {
    data: JSON.stringify({
      id: st.id || "chatcmpl-pending",
      object: "chat.completion.chunk",
      created: st.created,
      model: st.model,
      system_fingerprint: null,
      choices: [],
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      },
    }),
  }
}

function parseType(data: string): string | null {
  if (!data || data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as { type?: unknown }
    return typeof parsed.type === "string" ? parsed.type : null
  } catch {
    return null
  }
}

function applyCreated(data: string, st: ChatViaResponsesStreamState): void {
  try {
    const parsed = JSON.parse(data) as {
      response?: { id?: string; model?: string; created_at?: number }
      id?: string
      model?: string
      created_at?: number
    }
    const resp = parsed.response ?? parsed
    if (typeof resp.id === "string") st.id = resp.id
    if (typeof resp.model === "string") st.model = resp.model
    if (typeof resp.created_at === "number") st.created = Math.floor(resp.created_at)
  } catch {
    // ignore
  }
  const m = extractResolvedModel(data)
  if (m) st.model = m
}

function ensureMeta(st: ChatViaResponsesStreamState, data: string): void {
  if (!st.id) {
    try {
      const parsed = JSON.parse(data) as {
        response?: { id?: string; model?: string }
        item_id?: string
      }
      if (parsed.response?.id) st.id = parsed.response.id
      if (parsed.response?.model) st.model = parsed.response.model
    } catch {
      // ignore
    }
  }
  const m = extractResolvedModel(data)
  if (m) st.model = m
}

function extractDeltaText(data: string): string {
  try {
    const parsed = JSON.parse(data) as { delta?: unknown }
    return typeof parsed.delta === "string" ? parsed.delta : ""
  } catch {
    return ""
  }
}

function extractArgsDelta(data: string): string {
  try {
    const parsed = JSON.parse(data) as { delta?: unknown; arguments?: unknown }
    if (typeof parsed.delta === "string") return parsed.delta
    if (typeof parsed.arguments === "string") return parsed.arguments
    return ""
  } catch {
    return ""
  }
}

function extractItem(data: string): {
  type?: string
  id?: string
  call_id?: string
  name?: string
} | null {
  try {
    const parsed = JSON.parse(data) as { item?: Record<string, unknown> }
    const item = parsed.item
    if (!item || typeof item !== "object") return null
    const out: {
      type?: string
      id?: string
      call_id?: string
      name?: string
    } = {}
    if (typeof item.type === "string") out.type = item.type
    if (typeof item.id === "string") out.id = item.id
    if (typeof item.call_id === "string") out.call_id = item.call_id
    if (typeof item.name === "string") out.name = item.name
    return out
  } catch {
    return null
  }
}

function extractItemId(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { item_id?: unknown; item?: { id?: string } }
    if (typeof parsed.item_id === "string") return parsed.item_id
    if (typeof parsed.item?.id === "string") return parsed.item.id
    return null
  } catch {
    return null
  }
}


function applyUsage(data: string, st: ChatViaResponsesStreamState): void {
  const usage = extractUsage(data)
  if (usage) {
    st.inputTokens = usage.inputTokens
    st.outputTokens = usage.outputTokens
    return
  }
  try {
    const parsed = JSON.parse(data) as {
      response?: {
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const u = parsed.response?.usage ?? parsed.usage
    if (u) {
      st.inputTokens = u.input_tokens ?? st.inputTokens
      st.outputTokens = u.output_tokens ?? st.outputTokens
    }
  } catch {
    // ignore
  }
}

function applyTerminalFinishReason(
  eventName: string,
  data: string,
  st: ChatViaResponsesStreamState,
): void {
  if (st.finishReason === "tool_calls") return
  if (eventName.includes("incomplete") || parseType(data) === "response.incomplete") {
    try {
      const parsed = JSON.parse(data) as {
        response?: { incomplete_details?: { reason?: string } }
        incomplete_details?: { reason?: string }
      }
      const reason = (
        parsed.response?.incomplete_details?.reason ??
        parsed.incomplete_details?.reason ??
        ""
      ).toLowerCase()
      if (reason.includes("max_output") || reason.includes("max_token") || reason === "length") {
        st.finishReason = "length"
        return
      }
      if (reason.includes("content_filter")) {
        st.finishReason = "content_filter"
        return
      }
    } catch {
      // ignore
    }
    st.finishReason = "length"
    return
  }
  st.finishReason = st.finishReason ?? "stop"
}

function extractErrorMessage(data: string): string {
  try {
    const parsed = JSON.parse(data) as {
      error?: { message?: string } | string
      message?: string
      response?: { error?: { message?: string } }
    }
    if (typeof parsed.error === "string") return parsed.error
    if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
      return parsed.error.message
    }
    if (parsed.response?.error?.message) return parsed.response.error.message
    if (typeof parsed.message === "string") return parsed.message
  } catch {
    // ignore
  }
  return ""
}
