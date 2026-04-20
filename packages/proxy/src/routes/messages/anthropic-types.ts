// Anthropic API Types

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system: string | Array<AnthropicTextBlock> | null
  metadata: {
    user_id: string | null
  } | null
  stop_sequences: Array<string> | null
  stream: boolean | null
  temperature: number | null
  top_p: number | null
  top_k: number | null
  tools: Array<AnthropicTool> | null
  tool_choice: {
    type: "auto" | "any" | "tool" | "none"
    name: string | null
  } | null
  thinking: {
    type: "enabled"
    budget_tokens: number | null
  } | null
  service_tier: "auto" | "standard_only" | null
  /**
   * Output configuration for reasoning effort.
   * Used by Copilot native path for Claude models with adaptive thinking.
   */
  output_config?: {
    effort?: "max" | "xhigh" | "high" | "medium" | "low"
  } | null
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error: boolean | null
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicWebSearchResult {
  type: "web_search_result"
  url: string
  title: string
  encrypted_content: string
  page_age?: string
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: AnthropicWebSearchResult[]
}

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

export interface AnthropicTool {
  name: string
  description: string | null
  input_schema: Record<string, unknown>
  type?: string  // e.g. "custom", "web_search_20260209", "code_execution_20250522"
}

/**
 * Server-side tools have a type suffix like "web_search_20260209".
 * Custom tools have type "custom" or no type field at all.
 */
const SERVER_SIDE_TOOL_TYPE_RE = /^\w+_\d{8}$/

export function isServerSideTool(tool: AnthropicTool): boolean {
  return tool.type !== undefined &&
    tool.type !== "custom" &&
    SERVER_SIDE_TOOL_TYPE_RE.test(tool.type)
}

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
    service_tier: "standard" | "priority" | "batch" | null
    server_tool_use?: {
      web_search_requests: number
    } | null
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason: AnthropicResponse["stop_reason"] | null
    stop_sequence: string | null
  }
  usage: {
    input_tokens: number | null
    output_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
  } | null
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
}
