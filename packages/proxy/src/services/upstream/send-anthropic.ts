import type { ProviderRecord } from "./../../db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "./../../routes/messages/anthropic-types"
import { events, type ServerSentEvent } from "./../../util/sse"
import { HTTPError } from "./../../lib/error"

/**
 * Send an Anthropic-format payload to a custom Anthropic-compatible upstream.
 * Returns:
 *   - Non-streaming: AnthropicResponse (parsed JSON)
 *   - Streaming: AsyncGenerator<ServerSentEvent> (SSE events for passthrough)
 */
export async function sendAnthropicDirect(
  provider: ProviderRecord,
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  const url = `${provider.base_url.replace(/\/$/, "")}/v1/messages`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.api_key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new HTTPError(
      `Upstream ${provider.name} returned ${response.status}`,
      response,
    )
  }

  return payload.stream ? events(response) : await response.json()
}
