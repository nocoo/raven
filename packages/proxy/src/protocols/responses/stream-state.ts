/**
 * Pure parsers for OpenAI Responses-format SSE streams.
 *
 * Extracted from routes/responses/handler.ts so the handler only orchestrates
 * I/O and these helpers can be unit-tested without Hono/state.
 */

const TERMINAL_RESPONSE_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
])

export interface ParsedUsage {
  inputTokens: number
  outputTokens: number
}

/** True if the given SSE event name is a terminal Responses event carrying usage. */
export function isTerminalResponseEvent(event: string | null | undefined): boolean {
  return typeof event === "string" && TERMINAL_RESPONSE_EVENTS.has(event)
}

/**
 * Extract `response.model` from a `response.created` event's JSON data.
 * Returns `null` when the data cannot be parsed or the field is missing.
 */
export function extractResolvedModel(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { response?: { model?: unknown } }
    const model = parsed.response?.model
    return typeof model === "string" ? model : null
  } catch {
    return null
  }
}

/**
 * Extract `response.usage.{input_tokens,output_tokens}` from a terminal event's
 * JSON data. Missing fields default to 0. Returns `null` on parse failure or
 * when `response.usage` is absent.
 */
export function extractUsage(data: string): ParsedUsage | null {
  try {
    const parsed = JSON.parse(data) as {
      response?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } }
    }
    const usage = parsed.response?.usage
    if (!usage) return null
    return {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    }
  } catch {
    return null
  }
}

/**
 * Pull resolved model + usage from a non-streaming Responses JSON body.
 */
export function extractNonStreamingMeta(
  response: unknown,
  fallbackModel: string,
): { resolvedModel: string; inputTokens: number; outputTokens: number } {
  const resp = (response ?? {}) as {
    model?: unknown
    usage?: { input_tokens?: unknown; output_tokens?: unknown }
  }
  const resolvedModel = typeof resp.model === "string" ? resp.model : fallbackModel
  const usage = resp.usage
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
  const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0
  return { resolvedModel, inputTokens, outputTokens }
}
