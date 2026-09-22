import { state } from "../../lib/state"

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
