/**
 * Legacy facade — delegates to the canonical upstream/custom-openai client.
 * Removed by Phase E.10 once all importers move to the upstream registry.
 */

import type { CompiledProvider } from "../../db/providers"
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "../../upstream/copilot-openai"
import type { ServerSentEvent } from "../../util/sse"
import {
  CustomOpenAIClient,
  defaultCustomOpenAIConfig,
} from "../../upstream/custom-openai"

export async function sendOpenAIDirect(
  provider: CompiledProvider,
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEvent>> {
  const client = new CustomOpenAIClient(defaultCustomOpenAIConfig())
  return client.send({ provider, payload })
}
