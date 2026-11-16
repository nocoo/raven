import type { ServerSentEvent } from "../../util/sse"
import { GeminiUpstreamError, geminiError, geminiFinish, geminiFunctionCall, geminiTextParts, geminiUsage, object } from "./response"

export interface GeminiStreamState {
  model: string
  responseId?: string
  includeThoughts: boolean
  done: boolean
  failed: boolean
  usage?: unknown
  choices: Map<number, { finished: boolean; refused: boolean; calls: Map<number, { id: string; name: string; args: string }> }>
}

export function createGeminiStream(model: string, includeThoughts: boolean): GeminiStreamState {
  return { model, includeThoughts, done: false, failed: false, choices: new Map() }
}

export function chatChunkToGemini(chunk: ServerSentEvent, state: GeminiStreamState): { data: string }[] {
  if (state.done || state.failed) return []
  if (chunk.data === "[DONE]") {
    if (!state.choices.size || [...state.choices.values()].some(choice => !choice.finished)) throw new GeminiUpstreamError("Truncated upstream choices")
    state.done = true
    return []
  }
  if (!chunk.data) return []
  let value: unknown
  try { value = JSON.parse(chunk.data) } catch { throw new GeminiUpstreamError("Malformed upstream stream JSON") }
  const body = object(value)
  if (chunk.event === "error" || body.error) {
    state.failed = true
    return [{ data: JSON.stringify(geminiError(502, "Upstream stream failed")) }]
  }
  if (typeof body.model === "string") state.model = body.model
  if (typeof body.id === "string") state.responseId = body.id
  if (body.usage != null) state.usage = body.usage
  if (!Array.isArray(body.choices)) throw new GeminiUpstreamError("Upstream stream omitted choices")
  const candidates: Record<string, unknown>[] = []
  for (const raw of body.choices) {
    const choice = object(raw)
    if (!Number.isSafeInteger(choice.index) || Number(choice.index) < 0) throw new GeminiUpstreamError("Invalid upstream choice index")
    const index = choice.index as number
    let accumulated = state.choices.get(index)
    if (!accumulated) {
      accumulated = { finished: false, refused: false, calls: new Map() }
      state.choices.set(index, accumulated)
    }
    if (accumulated.finished) throw new GeminiUpstreamError("Upstream content followed a finished choice")
    const delta = object(choice.delta)
    accumulated.refused ||= typeof delta.refusal === "string" && delta.refusal.length > 0
    const parts = geminiTextParts(delta, state.includeThoughts)
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) throw new GeminiUpstreamError("Invalid streamed tool calls")
      for (const rawCall of delta.tool_calls) {
        const call = object(rawCall)
        if (call.type != null && call.type !== "function") throw new GeminiUpstreamError("Unsupported streamed tool type")
        if (!Number.isSafeInteger(call.index) || Number(call.index) < 0) throw new GeminiUpstreamError("Invalid streamed tool index")
        const toolIndex = call.index as number
        const tool = accumulated.calls.get(toolIndex) ?? { id: "", name: "", args: "" }
        if (call.id != null) {
          if (typeof call.id !== "string" || (tool.id && tool.id !== call.id)) throw new GeminiUpstreamError("Unstable streamed tool ID")
          tool.id = call.id
        }
        if (call.function != null) {
          const fn = object(call.function)
          if (fn.name != null) {
            if (typeof fn.name !== "string") throw new GeminiUpstreamError("Invalid streamed function name")
            tool.name += fn.name
          }
          if (fn.arguments != null) {
            if (typeof fn.arguments !== "string") throw new GeminiUpstreamError("Invalid streamed function arguments")
            tool.args += fn.arguments
          }
        }
        accumulated.calls.set(toolIndex, tool)
      }
    }
    let finishReason: string | undefined
    if (choice.finish_reason != null) {
      finishReason = accumulated.refused ? "SAFETY" : geminiFinish(choice.finish_reason)
      if (finishReason === "STOP") {
        for (const call of accumulated.calls.values()) parts.push(geminiFunctionCall(call.id, call.name, call.args))
      }
      accumulated.finished = true
    }
    if (parts.length || finishReason) candidates.push({ index, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) })
  }
  const usageMetadata = geminiUsage(body.usage)
  if (!candidates.length && !usageMetadata) return []
  return [{ data: JSON.stringify({ candidates, modelVersion: state.model,
    ...(state.responseId ? { responseId: state.responseId } : {}), ...(usageMetadata ? { usageMetadata } : {}),
  }) }]
}

export function finishGeminiStream(state: GeminiStreamState): { data: string }[] {
  if (!state.done && !state.failed) throw new GeminiUpstreamError("Truncated upstream stream: missing terminator")
  return []
}
