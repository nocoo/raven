import { copilotBaseUrl, copilotHeaders } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import { state } from "./../../lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens: number | null
  max_output_tokens: number | null
  max_prompt_tokens: number | null
  max_inputs: number | null
}

interface ModelSupports {
  tool_calls: boolean | null
  parallel_tool_calls: boolean | null
  dimensions: boolean | null
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy: {
    state: string
    terms: string
  } | null
}
