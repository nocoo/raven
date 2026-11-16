export class GeminiUpstreamError extends Error {
  constructor(message: string) { super(message); this.name = "GeminiUpstreamError" }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GeminiUpstreamError("Expected an upstream object")
  return value as Record<string, unknown>
}

export function geminiError(code: number, message: string) {
  const statuses: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED", 499: "CANCELLED", 500: "INTERNAL", 502: "UNAVAILABLE", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED" }
  return { error: { code, message, status: statuses[code] ?? "UNKNOWN" } }
}

export function geminiUsage(value: unknown): Record<string, number> | undefined {
  if (value == null) return undefined
  const usage = object(value)
  const result: Record<string, number> = {}
  for (const [key, field] of [["prompt_tokens", "promptTokenCount"], ["completion_tokens", "candidatesTokenCount"], ["total_tokens", "totalTokenCount"]] as const) {
    const n = usage[key]
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[field] = n
  }
  const details = usage.prompt_tokens_details
  if (details && typeof details === "object") {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0) result.cachedContentTokenCount = cached
  }
  const completionDetails = usage.completion_tokens_details as { reasoning_tokens?: unknown } | null | undefined
  const thoughts = completionDetails?.reasoning_tokens ?? usage.reasoning_tokens
  if (typeof thoughts === "number" && Number.isSafeInteger(thoughts) && thoughts >= 0
    && (result.candidatesTokenCount === undefined || thoughts <= result.candidatesTokenCount)) {
    result.thoughtsTokenCount = thoughts
    if (result.candidatesTokenCount !== undefined) result.candidatesTokenCount -= thoughts
  }
  return Object.keys(result).length ? result : undefined
}

export function geminiFinish(value: unknown): string {
  if (value === "stop" || value === "tool_calls") return "STOP"
  if (value === "length") return "MAX_TOKENS"
  if (value === "content_filter") return "SAFETY"
  throw new GeminiUpstreamError("Unsupported upstream finish reason")
}

export function geminiFunctionCall(id: unknown, name: unknown, args: unknown) {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name || typeof args !== "string") throw new GeminiUpstreamError("Incomplete upstream function call")
  let parsed: unknown
  try { parsed = JSON.parse(args) } catch { throw new GeminiUpstreamError("Invalid upstream function arguments") }
  return { functionCall: { id, name, args: object(parsed) } }
}

export function geminiTextParts(message: Record<string, unknown>, includeThoughts: boolean) {
  const parts: Record<string, unknown>[] = []
  for (const field of ["reasoning_content", "content", "refusal"] as const) {
    const text = message[field]
    if (text == null) continue
    if (typeof text !== "string") throw new GeminiUpstreamError("Unsupported upstream content")
    if (field === "reasoning_content" && !includeThoughts) continue
    if (text) parts.push({ text, ...(field === "reasoning_content" ? { thought: true } : {}) })
  }
  return parts
}

export function chatToGemini(value: unknown, includeThoughts: boolean) {
  const response = object(value)
  if (response.error) throw new GeminiUpstreamError("Upstream returned an error response")
  if (!Array.isArray(response.choices) || !response.choices.length) throw new GeminiUpstreamError("Upstream returned no choices")
  const candidates = response.choices.map(raw => {
    const choice = object(raw)
    if (!Number.isSafeInteger(choice.index) || Number(choice.index) < 0) throw new GeminiUpstreamError("Invalid upstream choice index")
    const message = object(choice.message)
    const parts = geminiTextParts(message, includeThoughts)
    const finishReason = message.refusal ? "SAFETY" : geminiFinish(choice.finish_reason)
    if (finishReason === "STOP" && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw new GeminiUpstreamError("Invalid upstream tool calls")
      for (const rawCall of message.tool_calls) {
        const call = object(rawCall)
        if (call.type !== "function") throw new GeminiUpstreamError("Unsupported upstream tool type")
        const fn = object(call.function)
        parts.push(geminiFunctionCall(call.id, fn.name, fn.arguments))
      }
    }
    return { index: choice.index, content: { role: "model", parts }, finishReason }
  })
  const usageMetadata = geminiUsage(response.usage)
  return { candidates, ...(typeof response.model === "string" ? { modelVersion: response.model } : {}),
    ...(typeof response.id === "string" ? { responseId: response.id } : {}), ...(usageMetadata ? { usageMetadata } : {}),
  }
}
