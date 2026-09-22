import type { UpstreamRecord } from "../core/routing-types"
import type { ResponsesPayload } from "./copilot-responses"
import { HTTPError } from "../lib/error"
import { buildProviderAuthHeaders } from "../lib/auth-headers"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { events, type ServerSentEvent } from "../util/sse"
import type { UpstreamClient, UpstreamResult } from "./interface"
import { joinCustomApiUrl } from "./api-url"
import { modelFetch, type ModelHttpConfig } from "./model-http"

export interface CustomResponsesRequest {
  target: UpstreamRecord
  payload: ResponsesPayload
}

export interface CustomResponsesConfig extends ModelHttpConfig {
  getProxyUrl(target: UpstreamRecord): string | undefined
}

export class CustomResponsesClient
  implements UpstreamClient<CustomResponsesRequest, unknown>
{
  constructor(private readonly config: CustomResponsesConfig) {}

  async send(
    req: CustomResponsesRequest,
    signal?: AbortSignal,
  ): Promise<UpstreamResult<unknown>> {
    signal?.throwIfAborted()
    const { target, payload } = req
    const url = joinCustomApiUrl(target.base_url, "responses")
    const proxyUrl = this.config.getProxyUrl(target)
    const response = await modelFetch(this.config)(url, {
      method: "POST",
      signal,
      headers: buildProviderAuthHeaders({
        format: target.format ?? "responses",
        api_key: target.api_key,
        auth_style: target.auth_style,
      }),
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse(
        `Upstream ${target.name} returned ${response.status}`,
        response,
      )
    }

    return payload.stream
      ? (events(response, signal) as AsyncGenerator<ServerSentEvent>)
      : await response.json()
  }
}

export function defaultCustomResponsesConfig(): CustomResponsesConfig {
  return {
    getProxyUrl: (target) => getProxyUrl(target, state),
  }
}

export function createDefaultCustomResponsesClient(): CustomResponsesClient {
  return new CustomResponsesClient(defaultCustomResponsesConfig())
}
