// ---------------------------------------------------------------------------
// core/stream-runner.ts (G.4) — pure SSE helpers shared by Runner (G.5)
// and the strategies that mutate stream-state. Intentionally has zero
// dependencies on hono/streaming, state, or logEmitter; this file is part
// of the §3.7 "core may not depend on side effects beyond log/io" rule.
//
// G.4 lands the helpers only. G.5 wires them into Runner; G.6+ ports the
// handler branches. The helpers cover:
//   - parseSseData: tolerant JSON parse for "data: {…}" frames
//   - computeStreamTimings: latency / ttft / processing math
//   - openAIUsageFrom: prompt - cached, completion (the most-duplicated
//     extraction in today's handlers)
// ---------------------------------------------------------------------------

export interface StreamTimings {
  /** Always set: ms from request entry to "now". */
  latencyMs: number
  /** ms from request entry to first SSE chunk; null if no chunk arrived. */
  ttftMs: number | null
  /** ms from first chunk to "now"; null if no chunk arrived. */
  processingMs: number | null
}

/**
 * Parse the JSON payload of an SSE `data:` line. Returns:
 *   - null for `[DONE]` (the OpenAI terminator)
 *   - null for empty / whitespace-only payloads
 *   - null on JSON parse failure (callers must not break the stream
 *     just because one chunk failed to parse — matches today's handler
 *     `try JSON.parse catch don't break stream` patterns)
 *   - parsed object otherwise
 */
export function parseSseData(data: string | undefined | null): unknown | null {
  if (!data) return null
  const trimmed = data.trim()
  if (trimmed === "" || trimmed === "[DONE]") return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * Compute latency / TTFT / processing in one shot. `firstChunkTime` may be
 * null when the stream errored before any chunk arrived; in that case TTFT
 * and processing are reported as null (matches today's handler behaviour).
 */
export function computeStreamTimings(
  startTime: number,
  firstChunkTime: number | null,
  endTime: number = performance.now(),
): StreamTimings {
  const latencyMs = Math.round(endTime - startTime)
  const ttftMs = firstChunkTime !== null ? Math.round(firstChunkTime - startTime) : null
  const processingMs = firstChunkTime !== null ? Math.round(endTime - firstChunkTime) : null
  return { latencyMs, ttftMs, processingMs }
}

interface OpenAIUsageBlock {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface ExtractedUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * Normalise an OpenAI usage block into `{inputTokens, outputTokens}` with
 * cached tokens subtracted from the prompt count. Returns null if the
 * block is missing or has neither a prompt nor completion field. Mirrors
 * the duplicated `(prompt - cached, completion)` calculation in every
 * existing handler.
 */
export function openAIUsageFrom(usage: unknown): ExtractedUsage | null {
  if (!usage || typeof usage !== "object") return null
  const u = usage as OpenAIUsageBlock
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  const inputTokens = (u.prompt_tokens ?? 0) - cached
  const outputTokens = u.completion_tokens ?? 0
  if (inputTokens === 0 && outputTokens === 0 && u.prompt_tokens === undefined && u.completion_tokens === undefined) {
    return null
  }
  return { inputTokens, outputTokens }
}
