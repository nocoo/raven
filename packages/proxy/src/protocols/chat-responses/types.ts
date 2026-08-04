import type { ChatCompletionsPayload, Message } from "../../upstream/copilot-openai"
import type { ResponsesPayload } from "../../upstream/copilot-responses"

/** Strategy client request: OpenAI Chat wire superset used only by the shim. */
export interface ChatViaResponsesClientReq {
  model: string
  messages: Message[]
  stream?: boolean | null
  stream_options?: { include_usage?: boolean } | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  n?: number | null
  stop?: string | string[] | null
  temperature?: number | null
  top_p?: number | null
  user?: string | null
  tools?: Array<{
    type: "function"
    function: {
      name: string
      description?: string | null
      parameters?: Record<string, unknown>
      strict?: boolean
    }
  }> | null
  tool_choice?: ChatCompletionsPayload["tool_choice"]
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: Record<string, unknown> }
    | null
  reasoning_effort?: ChatCompletionsPayload["reasoning_effort"]
  [key: string]: unknown
}

/** Upstream request wrapper — includeUsage must never enter responsesPayload JSON. */
export interface ChatViaResponsesUpReq {
  originalChat: ChatViaResponsesClientReq
  includeUsage: boolean
  responsesPayload: ResponsesPayload
}

export type ChatFinishReason = "stop" | "length" | "tool_calls" | "content_filter"

export interface ChatViaResponsesStreamState {
  id: string
  model: string
  created: number
  roleSent: boolean
  toolCallIndexByItemId: Map<string, number>
  callIdByItemId: Map<string, string>
  nextToolIndex: number
  finishReason: ChatFinishReason | null
  includeUsage: boolean
  inputTokens: number
  outputTokens: number
  /** Cached prefix tokens; already included in `inputTokens` (OpenAI convention). */
  cacheReadTokens: number
  done: boolean
  failed: boolean
}
