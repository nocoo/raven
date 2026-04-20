/**
 * Model capability utilities for native message routing.
 *
 * These functions check if a model supports native Anthropic /v1/messages
 * based on the cached Copilot models data.
 */

import { state } from "../../lib/state"

/**
 * Check if a model supports native /v1/messages endpoint.
 *
 * Uses the cached models from state.models to check supported_endpoints.
 * Returns false if model is not found or endpoints are not specified.
 *
 * @param copilotModel - Normalized Copilot model name (e.g., "claude-opus-4.6")
 */
export function supportsNativeMessages(copilotModel: string): boolean {
  if (!state.models?.data) {
    return false
  }

  const model = state.models.data.find((m) => m.id === copilotModel)
  if (!model?.supported_endpoints) {
    return false
  }

  return model.supported_endpoints.includes("/v1/messages")
}

/**
 * Get the model capabilities for a given model.
 *
 * Returns null if model is not found.
 *
 * @param copilotModel - Normalized Copilot model name
 */
export function getModelCapabilities(copilotModel: string): {
  supports?: {
    reasoning_effort?: string[]
    adaptive_thinking?: boolean
    max_thinking_budget?: number
  }
  limits?: {
    max_context_window_tokens?: number | null
    max_output_tokens?: number | null
  }
} | null {
  if (!state.models?.data) {
    return null
  }

  const model = state.models.data.find((m) => m.id === copilotModel)
  if (!model?.capabilities) {
    return null
  }

  return model.capabilities
}
