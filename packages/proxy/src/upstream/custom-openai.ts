/**
 * Custom OpenAI-compatible upstream client.
 */

import type { UpstreamRecord } from "../core/routing-types"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "./copilot-openai"
import { events, type ServerSentEvent } from "../util/sse"
import { HTTPError } from "../lib/error"
import { buildProviderAuthHeaders } from "../lib/auth-headers"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"
import { joinCustomApiUrl } from "./api-url"
import { modelFetch, type ModelHttpConfig } from "./model-http"

export interface CustomOpenAIRequest {
  provider: UpstreamRecord
  payload: ChatCompletionsPayload
}

export interface CustomOpenAIConfig extends ModelHttpConfig {
  getProxyUrl(provider: UpstreamRecord): string | undefined
}

export class CustomOpenAIClient
  implements UpstreamClient<CustomOpenAIRequest, ChatCompletionResponse>
{
  constructor(private readonly config: CustomOpenAIConfig) {}

  async send(
    req: CustomOpenAIRequest,
    signal?: AbortSignal,
  ): Promise<UpstreamResult<ChatCompletionResponse>> {
    signal?.throwIfAborted()
    const { provider, payload } = req
    const url = joinCustomApiUrl(provider.base_url, "chat/completions")
    const proxyUrl = this.config.getProxyUrl(provider)
    const response = await modelFetch(this.config)(url, {
      method: "POST",
      signal,
      headers: buildProviderAuthHeaders({
        format: provider.format ?? "chat_completions",
        api_key: provider.api_key,
        auth_style: provider.auth_style,
      }),
      body: JSON.stringify(payload.stream
        ? { ...payload, stream_options: { ...payload.stream_options, include_usage: true } }
        : payload),
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
      : ((await response.json()) as ChatCompletionResponse)
  }
}

export function defaultCustomOpenAIConfig(): CustomOpenAIConfig {
  return {
    getProxyUrl: (provider) => getProxyUrl(provider, state),
  }
}

export function createDefaultCustomOpenAIClient(): CustomOpenAIClient {
  return new CustomOpenAIClient(defaultCustomOpenAIConfig())
}
