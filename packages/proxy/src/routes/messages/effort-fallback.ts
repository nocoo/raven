/**
 * Reasoning effort fallback utilities.
 *
 * Copilot models support different reasoning effort levels. When a requested
 * effort is not supported, we automatically retry with a fallback effort.
 */

import { logEmitter } from "../../util/log-emitter"
import { getModelCapabilities } from "./model-capabilities"
import type { AnthropicMessagesPayload } from "./anthropic-types"

// Effort priority order (from highest to lowest)
const EFFORT_PRIORITY = ["max", "xhigh", "high", "medium", "low"] as const
type Effort = (typeof EFFORT_PRIORITY)[number]

/**
 * Check if a value is a valid effort level.
 */
export function isValidEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORT_PRIORITY.includes(value as Effort)
}

/**
 * Pick the best supported effort, falling back from the requested effort.
 *
 * Strategy: From the requested effort, search downward (toward lower priority)
 * for the first supported value. If none found, return null (remove output_config).
 *
 * @param requested - The requested effort level
 * @param supported - Array of supported effort levels from model capabilities
 * @returns The best supported effort, or null if none are supported
 */
export function pickSupportedEffort(
  requested: Effort,
  supported: string[],
): Effort | null {
  const requestedIndex = EFFORT_PRIORITY.indexOf(requested)
  if (requestedIndex === -1) return null

  const supportedSet = new Set(supported)

  // Search from requested effort downward (lower priority = more likely to be supported)
  for (let i = requestedIndex; i < EFFORT_PRIORITY.length; i++) {
    const effort = EFFORT_PRIORITY[i]!
    if (supportedSet.has(effort)) {
      return effort
    }
  }

  return null
}

/**
 * Parse Copilot error response for invalid_reasoning_effort.
 *
 * Error format:
 * ```json
 * {
 *   "error": {
 *     "message": "output_config.effort \"xhigh\" is not supported by model claude-opus-4.7; supported values: [medium]",
 *     "code": "invalid_reasoning_effort"
 *   }
 * }
 * ```
 *
 * @returns Parsed error info or null if not a reasoning effort error
 */
export function parseReasoningEffortError(
  errorBody: unknown,
): { requestedEffort: Effort; supportedEfforts: Effort[] } | null {
  if (typeof errorBody !== "object" || errorBody === null) return null

  const error = (errorBody as { error?: { code?: string; message?: string } }).error
  if (error?.code !== "invalid_reasoning_effort") return null

  const message = error.message
  if (typeof message !== "string") return null

  // Parse: output_config.effort "xhigh" is not supported by model ...; supported values: [medium]
  const requestedMatch = message.match(/effort "(\w+)" is not supported/)
  const supportedMatch = message.match(/supported values: \[([^\]]+)\]/)

  if (!requestedMatch?.[1]) return null

  const requestedEffort = requestedMatch[1]
  if (!isValidEffort(requestedEffort)) return null

  const supportedEfforts: Effort[] = []
  if (supportedMatch?.[1]) {
    const parsed = supportedMatch[1].split(",").map((s) => s.trim())
    for (const e of parsed) {
      if (isValidEffort(e)) {
        supportedEfforts.push(e)
      }
    }
  }

  return { requestedEffort, supportedEfforts }
}

/**
 * Get supported reasoning efforts for a model from cached capabilities.
 *
 * @param copilotModel - Normalized Copilot model name
 * @returns Array of supported effort levels, or null if unknown
 */
export function getSupportedEfforts(copilotModel: string): Effort[] | null {
  const capabilities = getModelCapabilities(copilotModel)
  if (!capabilities?.supports?.reasoning_effort) return null

  return capabilities.supports.reasoning_effort.filter(isValidEffort)
}

/**
 * Adjust payload's output_config.effort if needed for fallback.
 *
 * @param payload - Original payload
 * @param fallbackEffort - The fallback effort to use
 * @returns Modified payload with adjusted effort
 */
export function adjustEffortInPayload(
  payload: AnthropicMessagesPayload,
  fallbackEffort: Effort | null,
): AnthropicMessagesPayload {
  if (fallbackEffort === null) {
    // Remove output_config entirely
    const { output_config: _, ...rest } = payload
    return rest as AnthropicMessagesPayload
  }

  return {
    ...payload,
    output_config: {
      ...payload.output_config,
      effort: fallbackEffort,
    },
  }
}

/**
 * Log a reasoning effort fallback event.
 */
export function logEffortFallback(
  requestId: string,
  copilotModel: string,
  originalEffort: Effort,
  fallbackEffort: Effort | null,
): void {
  logEmitter.emitLog({
    ts: Date.now(),
    level: "warn",
    type: "system",
    requestId,
    msg: `reasoning effort fallback: ${originalEffort} → ${fallbackEffort ?? "removed"}`,
    data: {
      model: copilotModel,
      originalEffort,
      fallbackEffort,
    },
  })
}
