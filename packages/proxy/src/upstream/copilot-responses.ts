/**
 * Copilot Responses upstream client.
 *
 * Pure helpers `hasVisionContent` / `hasAgentHistory` are exported for use
 * by tests and adjacent modules.
 */

import { events, type ServerSentEvent } from "../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"

export interface ResponsesPayload {
  model: string
  input: unknown
  stream?: boolean
  [key: string]: unknown
}

export interface CopilotResponsesConfig {
  getToken(): string
  getBaseUrl(): string
  getHeaders(vision: boolean): Record<string, string>
  getProxyUrl(): string | undefined
}

export class CopilotResponsesClient
  implements UpstreamClient<ResponsesPayload, unknown>
{
  constructor(private readonly config: CopilotResponsesConfig) {}

  async send(payload: ResponsesPayload): Promise<UpstreamResult<unknown>> {
    this.config.getToken()

    const enableVision = hasVisionContent(payload)
    const isAgentCall = hasAgentHistory(payload)

    const headers: Record<string, string> = {
      ...this.config.getHeaders(enableVision),
      "X-Initiator": isAgentCall ? "agent" : "user",
    }

    const proxyUrl = this.config.getProxyUrl()
    const response = await fetch(`${this.config.getBaseUrl()}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse("Failed to create responses", response)
    }

    if (payload.stream) {
      return events(response) as AsyncGenerator<ServerSentEvent>
    }

    return await response.json()
  }
}

export function defaultCopilotResponsesConfig(): CopilotResponsesConfig {
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

export function createDefaultCopilotResponsesClient(): CopilotResponsesClient {
  return new CopilotResponsesClient(defaultCopilotResponsesConfig())
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for back-compat re-export from the legacy shim).
// ---------------------------------------------------------------------------

export function hasVisionContent(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return false
    return content.some((part: unknown) => {
      if (typeof part !== "object" || part === null) return false
      return (part as Record<string, unknown>).type === "input_image"
    })
  })
}

export function hasAgentHistory(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const role = (item as Record<string, unknown>).role
    const type = (item as Record<string, unknown>).type
    return role === "assistant" || type === "function_call" || type === "function_call_output"
  })
}
