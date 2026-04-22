/**
 * Phase E.8 — custom Anthropic-compatible upstream port.
 *
 * Same wire behaviour as services/upstream/send-anthropic.ts.
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
  const requestBody: Record<string, unknown> = {
    ...payload,
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
  ): Promise<UpstreamResult<AnthropicResponse>> {
    const { provider, payload } = req
    const url = `${provider.base_url.replace(/\/$/, "")}/v1/messages`
    const proxyUrl = this.config.getProxyUrl(provider)
    const requestBody = sanitizeAnthropicPayload(payload)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.api_key,
        "anthropic-version": "2023-06-01",
      },
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
      ? (events(response) as AsyncGenerator<ServerSentEvent>)
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
