/**
 * Custom OpenAI-compatible upstream client.
 */

import type { CompiledProvider } from "../db/providers"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "./copilot-openai"
import { events, type ServerSentEvent } from "../util/sse"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"

export interface CustomOpenAIRequest {
  provider: CompiledProvider
  payload: ChatCompletionsPayload
}

export interface CustomOpenAIConfig {
  getProxyUrl(provider: CompiledProvider): string | undefined
}

export class CustomOpenAIClient
  implements UpstreamClient<CustomOpenAIRequest, ChatCompletionResponse>
{
  constructor(private readonly config: CustomOpenAIConfig) {}

  async send(
    req: CustomOpenAIRequest,
  ): Promise<UpstreamResult<ChatCompletionResponse>> {
    const { provider, payload } = req
    const url = `${provider.base_url.replace(/\/$/, "")}/v1/chat/completions`
    const proxyUrl = this.config.getProxyUrl(provider)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse(
        `Upstream ${provider.name} returned ${response.status}`,
        response,
      )
    }

    return payload.stream
      ? (events(response) as AsyncGenerator<ServerSentEvent>)
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
