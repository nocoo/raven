/**
 * Custom Anthropic-compatible upstream client.
 */

import type { CompiledProvider } from "../db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../protocols/anthropic/types"
import { events, type ServerSentEvent } from "../util/sse"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"

type SanitizedOutputConfig = Exclude<AnthropicMessagesPayload["output_config"], undefined>

function sanitizeOutputConfig(
  outputConfig: AnthropicMessagesPayload["output_config"],
): SanitizedOutputConfig {
  if (!outputConfig || typeof outputConfig !== "object") return null
  return outputConfig.effort ? { effort: outputConfig.effort } : null
}

function sanitizeAnthropicPayload(payload: AnthropicMessagesPayload): Record<string, unknown> {
  const { context_management: _contextManagement, ...sanitizedPayload } =
    payload as AnthropicMessagesPayload & { context_management?: unknown }

  const requestBody: Record<string, unknown> = {
    ...sanitizedPayload,
    model: payload.model.toLowerCase(),
    output_config: sanitizeOutputConfig(payload.output_config),
  }
  if (requestBody.tools === null || requestBody.tools === undefined) {
    delete requestBody.tools
  }
  if (requestBody.tool_choice === null || requestBody.tool_choice === undefined) {
    delete requestBody.tool_choice
  }
  if (requestBody.output_config === null || requestBody.output_config === undefined) {
    delete requestBody.output_config
  }
  return requestBody
}

export interface CustomAnthropicRequest {
  provider: CompiledProvider
  payload: AnthropicMessagesPayload
}

export interface CustomAnthropicConfig {
  getProxyUrl(provider: CompiledProvider): string | undefined
}

export class CustomAnthropicClient
  implements UpstreamClient<CustomAnthropicRequest, AnthropicResponse>
{
  constructor(private readonly config: CustomAnthropicConfig) {}

  async send(
    req: CustomAnthropicRequest,
    signal?: AbortSignal,
  ): Promise<UpstreamResult<AnthropicResponse>> {
    signal?.throwIfAborted()
    const { provider, payload } = req
    const url = `${provider.base_url.replace(/\/+$/, "")}/v1/messages`
    const proxyUrl = this.config.getProxyUrl(provider)
    const requestBody = sanitizeAnthropicPayload(payload)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    }
    // auth_style: explicit bearer/x-api-key, null = unknown so send both.
    // Standard Anthropic endpoints accept x-api-key; Manifest et al. require
    // Authorization: Bearer. Dual-header is safe — endpoints ignore unknown headers.
    if (provider.auth_style === "bearer") {
      headers.Authorization = `Bearer ${provider.api_key}`
    } else if (provider.auth_style === "x-api-key") {
      headers["x-api-key"] = provider.api_key
    } else {
      headers["x-api-key"] = provider.api_key
      headers.Authorization = `Bearer ${provider.api_key}`
    }
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(requestBody),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse(
        `Upstream ${provider.name} returned ${response.status}`,
        response,
      )
    }

    return payload.stream
      ? (events(response, signal) as AsyncGenerator<ServerSentEvent>)
      : ((await response.json()) as AnthropicResponse)
  }
}

export function defaultCustomAnthropicConfig(): CustomAnthropicConfig {
  return {
    getProxyUrl: (provider) => getProxyUrl(provider, state),
  }
}

export function createDefaultCustomAnthropicClient(): CustomAnthropicClient {
  return new CustomAnthropicClient(defaultCustomAnthropicConfig())
}
