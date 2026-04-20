import type { CompiledProvider } from "./../../db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "./../../routes/messages/anthropic-types"
import { events, type ServerSentEvent } from "./../../util/sse"
import { HTTPError } from "./../../lib/error"
import { getProxyUrl } from "./../../lib/socks5-bridge"
import { state } from "./../../lib/state"

/**
 * Clean null/undefined fields from payload that Anthropic API doesn't accept.
 * Returns a new object, does not mutate the input.
 */
function sanitizeAnthropicPayload(payload: AnthropicMessagesPayload): Record<string, unknown> {
  const requestBody: Record<string, unknown> = { ...payload }

  // Remove null/undefined fields that Anthropic API rejects
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

/**
 * Send an Anthropic-format payload to a custom Anthropic-compatible upstream.
 * Returns:
 *   - Non-streaming: AnthropicResponse (parsed JSON)
 *   - Streaming: AsyncGenerator<ServerSentEvent> (SSE events for passthrough)
 */
export async function sendAnthropicDirect(
  provider: CompiledProvider,
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  const url = `${provider.base_url.replace(/\/$/, "")}/v1/messages`
  const proxyUrl = getProxyUrl(provider, state)

  // Sanitize payload to remove null fields that Anthropic API rejects
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

  return payload.stream ? events(response) : await response.json()
}
