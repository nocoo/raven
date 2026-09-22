/**
 * Custom Anthropic-compatible upstream client.
 */

import type { UpstreamRecord } from "../core/routing-types"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../protocols/anthropic/types"
import { events, type ServerSentEvent } from "../util/sse"
import { HTTPError } from "../lib/error"
import { buildProviderAuthHeaders } from "../lib/auth-headers"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"
import { joinCustomApiUrl } from "./api-url"
import { modelFetch, type ModelHttpConfig } from "./model-http"

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
  provider: UpstreamRecord
  payload: AnthropicMessagesPayload
}

export interface CustomAnthropicConfig extends ModelHttpConfig {
  getProxyUrl(provider: UpstreamRecord): string | undefined
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
    const url = joinCustomApiUrl(provider.base_url, "messages")
    const proxyUrl = this.config.getProxyUrl(provider)
    const requestBody = sanitizeAnthropicPayload(payload)
    const response = await modelFetch(this.config)(url, {
      method: "POST",
      signal,
      headers: buildProviderAuthHeaders({
        format: provider.format ?? "anthropic_messages",
        api_key: provider.api_key,
        auth_style: provider.auth_style,
      }),
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
