import type { ProviderRecord } from "~/db/providers"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { events, type ServerSentEvent } from "~/util/sse"
import { HTTPError } from "~/lib/error"

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
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.api_key}`,
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
