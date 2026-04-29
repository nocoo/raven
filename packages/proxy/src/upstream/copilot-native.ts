/**
 * Copilot native Anthropic Messages upstream client.
 *
 * Constructor-injected config; default factory binds to the state singleton.
 */

import { events, type ServerSentEvent } from "../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { getModelCapabilities } from "../strategies/support/model-capabilities"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../protocols/anthropic/types"
import type { UpstreamClient, UpstreamResult } from "./interface"

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const EFFORT_PRIORITY = ["max", "xhigh", "high", "medium", "low"] as const
type Effort = (typeof EFFORT_PRIORITY)[number]
type SanitizedOutputConfig = Exclude<AnthropicMessagesPayload["output_config"], undefined>

export interface NativeMessagesOptions {
  copilotModel: string
  anthropicBeta?: string | null
}

export interface CopilotNativeConfig {
  getToken(): string
  getBaseUrl(): string
  getHeaders(): Record<string, string>
  getProxyUrl(): string | undefined
}

export interface CopilotNativeRequest {
  payload: AnthropicMessagesPayload
  options: NativeMessagesOptions
}

export class CopilotNativeClient
  implements UpstreamClient<CopilotNativeRequest, AnthropicResponse>
{
  constructor(private readonly config: CopilotNativeConfig) {}

  async send(req: CopilotNativeRequest): Promise<UpstreamResult<AnthropicResponse>> {
    this.config.getToken()

    const normalizedPayload = normalizeNativeThinkingPayload(req.payload, req.options.copilotModel)

    const headers: Record<string, string> = {
      ...this.config.getHeaders(),
      "anthropic-version": "2023-06-01",
    }

    const anthropicBeta = buildNativeAnthropicBeta(normalizedPayload, req.options.anthropicBeta ?? null)
    if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta

    if (checkForVision(normalizedPayload)) {
      headers["copilot-vision-request"] = "true"
    }

    const isAgentCall = normalizedPayload.messages.some(
      (msg) => msg.role === "assistant" || hasToolResultContent(msg),
    )
    headers["X-Initiator"] = isAgentCall ? "agent" : "user"

    const requestBody: Record<string, unknown> = {
      ...sanitizeNativeMessagesPayload(normalizedPayload),
      model: req.options.copilotModel,
    }

    if (requestBody.tools === null || requestBody.tools === undefined) delete requestBody.tools
    if (requestBody.tool_choice === null || requestBody.tool_choice === undefined) {
      delete requestBody.tool_choice
    }
    if (requestBody.output_config === null || requestBody.output_config === undefined) {
      delete requestBody.output_config
    }

    const proxyUrl = this.config.getProxyUrl()
    const response = await fetch(`${this.config.getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse("Failed to create native messages", response)
    }

    if (normalizedPayload.stream) {
      return events(response) as AsyncGenerator<ServerSentEvent>
    }

    return (await response.json()) as AnthropicResponse
  }
}

export function defaultCopilotNativeConfig(): CopilotNativeConfig {
  return {
    getToken: () => {
      if (!state.copilotToken) throw new Error("Copilot token not found")
      return state.copilotToken
    },
    getBaseUrl: () => copilotBaseUrl(state),
    getHeaders: () => copilotHeaders(state),
    getProxyUrl: () => getProxyUrl("copilot", state),
  }
}

export function createDefaultCopilotNativeClient(): CopilotNativeClient {
  return new CopilotNativeClient(defaultCopilotNativeConfig())
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function checkForVision(payload: AnthropicMessagesPayload): boolean {
  for (const msg of payload.messages) {
    if (typeof msg.content === "string") continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === "image") return true
    }
  }
  return false
}

function hasToolResultContent(msg: { content: unknown }): boolean {
  if (typeof msg.content === "string") return false
  if (!Array.isArray(msg.content)) return false
  return msg.content.some((block: { type: string }) => block.type === "tool_result")
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
  if (payload.thinking?.type !== "enabled") return payload

  const capabilities = getModelCapabilities(copilotModel)
  if (!capabilities?.supports?.adaptive_thinking) return payload

  const requestedEffort =
    payload.output_config?.effort
    ?? mapThinkingBudgetToEffort(payload.thinking.budget_tokens)
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
    system: stripSystem(payload.system),
    tools: stripToolDefinitions(payload.tools),
    messages: payload.messages.map((message) => {
      const stripped = stripMessageBlocks(message)
      if (stripped.role !== "assistant" || !Array.isArray(stripped.content)) return stripped
      return {
        ...stripped,
        content: stripped.content.filter((block) => {
          if (block.type !== "thinking") return true
          const thinking = block.thinking.trim()
          return thinking.length > 0 && thinking !== "Thinking..."
        }),
      }
    }),
  }
}

function stripMessageBlocks(message: AnthropicMessagesPayload["messages"][number]) {
  if (typeof message.content === "string" || !Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((block) => stripAnthropicMetadata(block)),
  } as AnthropicMessagesPayload["messages"][number]
}

function stripSystem(
  system: AnthropicMessagesPayload["system"],
): AnthropicMessagesPayload["system"] {
  if (system === null || typeof system === "string") return system
  if (!Array.isArray(system)) return system
  return system.map((block) => stripAnthropicMetadata(block)) as typeof system
}

function stripToolDefinitions(
  tools: AnthropicMessagesPayload["tools"],
): AnthropicMessagesPayload["tools"] {
  if (!tools) return tools
  return tools.map((tool) => stripToolDefinition(tool))
}

function stripToolDefinition<T extends object>(tool: T): T {
  const { cache_control: _cc, defer_loading: _dl, eager_input_streaming: _es, ...rest } =
    tool as Record<string, unknown>
  void _cc
  void _dl
  void _es
  return rest as T
}

function stripAnthropicMetadata<T extends object>(block: T): T {
  const { cache_control: _cc, citations: _ci, ...rest } = block as Record<string, unknown>
  void _cc
  void _ci
  return rest as T
}

function mapThinkingBudgetToEffort(budgetTokens: number | null | undefined): Effort {
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
