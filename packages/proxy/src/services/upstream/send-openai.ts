import type { ProviderRecord } from "./../../db/providers"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "./../../services/copilot/create-chat-completions"
import { events, type ServerSentEvent } from "./../../util/sse"
import { HTTPError } from "./../../lib/error"
import { getProxyUrl } from "./../../lib/socks5-bridge"
import { state } from "./../../lib/state"

/**
 * Send an OpenAI-format payload to a custom OpenAI-compatible upstream.
 * Returns:
 *   - Non-streaming: ChatCompletionResponse (parsed JSON)
 *   - Streaming: AsyncGenerator<ServerSentEvent> (SSE events)
 */
export async function sendOpenAIDirect(
  provider: ProviderRecord,
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEvent>> {
  const url = `${provider.base_url.replace(/\/$/, "")}/v1/chat/completions`
  const proxyUrl = getProxyUrl(provider, state)
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

  return payload.stream ? events(response) : await response.json()
}
