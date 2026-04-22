/**
 * Phase E.3 — copilot OpenAI-format chat completions port.
 *
 * Same wire behaviour as the legacy `services/copilot/create-chat-completions.ts`
 * (verified against E.2 fixtures), but with constructor-injected config so
 * strategies (Phase H) can build per-request clients without reading the
 * `state` singleton.
 *
 * The default factory `createDefaultCopilotOpenAIClient()` reads from `state`
 * + ambient lib helpers — kept inside this file so the rest of the codebase
 * never sees the singleton, only the client instance.
 */

import { events, type ServerSentEvent } from "../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"

// ---------------------------------------------------------------------------
// Re-exported wire types (canonical home moves here in E.10).
// ---------------------------------------------------------------------------

export interface CopilotOpenAIConfig {
  /** Throws if the token is missing — callers guard against null at the boundary. */
  getToken(): string
  getBaseUrl(): string
  /** Build the headers excluding X-Initiator (which is request-shape dependent). */
  getHeaders(vision: boolean): Record<string, string>
  /** Resolve the SOCKS5 proxy URL for this request, or undefined for direct connect. */
  getProxyUrl(): string | undefined
}

// ---------------------------------------------------------------------------
// Wire types — same shapes as the legacy service.
// ---------------------------------------------------------------------------

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint: string | null
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: {
      cached_tokens: number
    } | null
    completion_tokens_details: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    } | null
  } | null
}

interface Delta {
  content: string | null
  role: "user" | "assistant" | "system" | "tool" | null
  tool_calls: Array<{
    index: number
    id: string | null
    type: "function" | null
    function: {
      name: string | null
      arguments: string | null
    } | null
  } | null>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint: string | null
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: {
      cached_tokens: number
    } | null
  } | null
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls: Array<ToolCall> | null
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description: string | null
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string | null
  tool_calls?: Array<ToolCall> | null
  tool_call_id?: string | null
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CopilotOpenAIClient
  implements UpstreamClient<ChatCompletionsPayload, ChatCompletionResponse>
{
  constructor(private readonly config: CopilotOpenAIConfig) {}

  async send(
    payload: ChatCompletionsPayload,
  ): Promise<UpstreamResult<ChatCompletionResponse>> {
    // Force token check at request time (matches legacy semantics).
    this.config.getToken()

    const enableVision = payload.messages.some(
      (x) =>
        typeof x.content !== "string"
        && x.content?.some((c) => c.type === "image_url"),
    )

    const isAgentCall = payload.messages.some((msg) =>
      ["assistant", "tool"].includes(msg.role),
    )

    const headers: Record<string, string> = {
      ...this.config.getHeaders(enableVision),
      "X-Initiator": isAgentCall ? "agent" : "user",
    }

    const proxyUrl = this.config.getProxyUrl()
    const response = await fetch(`${this.config.getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse("Failed to create chat completions", response)
    }

    if (payload.stream) {
      return events(response) as AsyncGenerator<ServerSentEvent>
    }

    return (await response.json()) as ChatCompletionResponse
  }
}

/** Default config bound to the global `state` singleton. */
export function defaultCopilotOpenAIConfig(): CopilotOpenAIConfig {
  return {
    getToken: () => {
      if (!state.copilotToken) throw new Error("Copilot token not found")
      return state.copilotToken
    },
    getBaseUrl: () => copilotBaseUrl(state),
    getHeaders: (vision: boolean) => copilotHeaders(state, vision),
    getProxyUrl: () => getProxyUrl("copilot", state),
  }
}

export function createDefaultCopilotOpenAIClient(): CopilotOpenAIClient {
  return new CopilotOpenAIClient(defaultCopilotOpenAIConfig())
}
