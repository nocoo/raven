/**
 * Copilot Native Anthropic Messages Service
 *
 * Sends requests to Copilot's /v1/messages endpoint (Anthropic protocol).
 * This is used for Claude models that support native passthrough.
 */

import { events } from "../../util/sse"
import { copilotHeaders, copilotBaseUrl } from "../../lib/api-config"
import { HTTPError } from "../../lib/error"
import { getProxyUrl } from "../../lib/socks5-bridge"
import { state } from "../../lib/state"
import { getModelCapabilities } from "../../routes/messages/model-capabilities"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../routes/messages/anthropic-types"
import type { ServerSentEvent } from "../../util/sse"

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const EFFORT_PRIORITY = ["max", "xhigh", "high", "medium", "low"] as const
type Effort = (typeof EFFORT_PRIORITY)[number]
type SanitizedOutputConfig = Exclude<AnthropicMessagesPayload["output_config"], undefined>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeMessagesOptions {
  /** Copilot-normalized model name (e.g., "claude-opus-4.6") */
  copilotModel: string
  /** Filtered anthropic-beta header (only allowed betas) */
  anthropicBeta?: string | null
}

// ---------------------------------------------------------------------------
// Main Service Function
// ---------------------------------------------------------------------------

/**
 * Send a request to Copilot's native /v1/messages endpoint.
 *
 * @param payload - Anthropic messages payload
 * @param options - Options including copilotModel and anthropicBeta
 * @returns Response or SSE stream
 */
export async function createNativeMessages(
  payload: AnthropicMessagesPayload,
  options: NativeMessagesOptions,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found")
  }

  const normalizedPayload = normalizeNativeThinkingPayload(payload, options.copilotModel)

  // Build headers
  const headers: Record<string, string> = {
    ...copilotHeaders(state),
    // Anthropic-specific headers
    "anthropic-version": "2023-06-01",
  }

  const anthropicBeta = buildNativeAnthropicBeta(normalizedPayload, options.anthropicBeta ?? null)
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  // Check for vision (base64 images in messages)
  const hasVision = checkForVision(normalizedPayload)
  if (hasVision) {
    headers["copilot-vision-request"] = "true"
  }

  // Agent/user detection for X-Initiator header
  const isAgentCall = normalizedPayload.messages.some((msg) =>
    msg.role === "assistant" || hasToolResultContent(msg),
  )
  headers["X-Initiator"] = isAgentCall ? "agent" : "user"

  // Build request body with copilotModel
  // Remove null/undefined fields that Anthropic API doesn't accept
  const requestBody: Record<string, unknown> = {
    ...sanitizeNativeMessagesPayload(normalizedPayload),
    model: options.copilotModel,
  }

  // Clean up null fields that shouldn't be sent to Anthropic
  if (requestBody.tools === null || requestBody.tools === undefined) {
    delete requestBody.tools
  }
  if (requestBody.tool_choice === null || requestBody.tool_choice === undefined) {
    delete requestBody.tool_choice
  }
  if (requestBody.output_config === null || requestBody.output_config === undefined) {
    delete requestBody.output_config
  }

  const proxyUrl = getProxyUrl("copilot", state)
  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to create native messages", response)
  }

  // Handle streaming vs non-streaming
  if (normalizedPayload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Check if the payload contains base64 images (vision request).
 */
function checkForVision(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") continue
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      if (block.type === "image") {
        return true
      }
    }
  }
  return false
}

/**
 * Check if a message contains tool_result content blocks.
 */
function hasToolResultContent(msg: { content: unknown }): boolean {
  if (typeof msg.content === "string") return false
  if (!Array.isArray(msg.content)) return false

  return msg.content.some(
    (block: { type: string }) => block.type === "tool_result",
  )
}

function buildNativeAnthropicBeta(
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | null,
): string | null {
  const betas = anthropicBeta
    ?.split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0) ?? []

  if (payload.thinking?.type === "enabled" && payload.thinking.budget_tokens) {
    betas.push(INTERLEAVED_THINKING_BETA)
  }

  if (betas.length === 0) return null
  return [...new Set(betas)].join(",")
}

function normalizeNativeThinkingPayload(
  payload: AnthropicMessagesPayload,
  copilotModel: string,
): AnthropicMessagesPayload {
  if (payload.thinking?.type !== "enabled") {
    return payload
  }

  const capabilities = getModelCapabilities(copilotModel)
  if (!capabilities?.supports?.adaptive_thinking) {
    return payload
  }

  const requestedEffort =
    payload.output_config?.effort ??
    mapThinkingBudgetToEffort(payload.thinking.budget_tokens)
  const supportedEffort = pickClosestSupportedEffort(
    requestedEffort,
    capabilities.supports.reasoning_effort,
  )
  const sanitizedOutputConfig = sanitizeOutputConfig(payload.output_config)

  return {
    ...payload,
    thinking: { type: "adaptive" },
    output_config: supportedEffort
      ? {
          ...sanitizedOutputConfig,
          effort: supportedEffort,
        }
      : sanitizedOutputConfig,
  }
}

function sanitizeNativeMessagesPayload(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  return {
    ...payload,
    output_config: sanitizeOutputConfig(payload.output_config),
    messages: payload.messages.map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return message
      }

      return {
        ...message,
        content: message.content.filter((block) => {
          if (block.type !== "thinking") return true
          const thinking = block.thinking.trim()
          return thinking.length > 0 && thinking !== "Thinking..."
        }),
      }
    }),
  }
}

function mapThinkingBudgetToEffort(
  budgetTokens: number | null | undefined,
): Effort {
  if (!budgetTokens) return "high"
  if (budgetTokens <= 2048) return "low"
  if (budgetTokens <= 8192) return "medium"
  return "high"
}

function pickClosestSupportedEffort(
  requested: Effort,
  supported: string[] | undefined,
): Effort | null {
  if (!supported?.length) return requested

  const normalizedSupported = supported.filter(isEffort)
  if (normalizedSupported.length === 0) return requested
  if (normalizedSupported.includes(requested)) return requested

  const requestedIndex = EFFORT_PRIORITY.indexOf(requested)
  let best: Effort | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const effort of normalizedSupported) {
    const index = EFFORT_PRIORITY.indexOf(effort)
    if (index === -1) continue
    const distance = Math.abs(index - requestedIndex)
    if (distance < bestDistance) {
      best = effort
      bestDistance = distance
      continue
    }
    if (distance === bestDistance && best !== null && index > EFFORT_PRIORITY.indexOf(best)) {
      best = effort
    }
  }

  return best ?? requested
}

function isEffort(value: string): value is Effort {
  return EFFORT_PRIORITY.includes(value as Effort)
}

function sanitizeOutputConfig(
  outputConfig: AnthropicMessagesPayload["output_config"],
): SanitizedOutputConfig {
  if (!outputConfig || typeof outputConfig !== "object") return null
  return outputConfig.effort ? { effort: outputConfig.effort } : null
}
