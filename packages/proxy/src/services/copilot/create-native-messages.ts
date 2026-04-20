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
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../routes/messages/anthropic-types"
import type { ServerSentEvent } from "../../util/sse"

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

  // Build headers
  const headers: Record<string, string> = {
    ...copilotHeaders(state),
    // Anthropic-specific headers
    "anthropic-version": "2023-06-01",
  }

  // Add filtered beta header if present
  if (options.anthropicBeta) {
    headers["anthropic-beta"] = options.anthropicBeta
  }

  // Check for vision (base64 images in messages)
  const hasVision = checkForVision(payload)
  if (hasVision) {
    headers["copilot-vision-request"] = "true"
  }

  // Agent/user detection for X-Initiator header
  const isAgentCall = payload.messages.some((msg) =>
    msg.role === "assistant" || hasToolResultContent(msg),
  )
  headers["X-Initiator"] = isAgentCall ? "agent" : "user"

  // Build request body with copilotModel
  // Remove null/undefined fields that Anthropic API doesn't accept
  const requestBody: Record<string, unknown> = {
    ...payload,
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
  if (payload.stream) {
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
