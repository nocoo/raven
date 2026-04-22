/**
 * Legacy facade — delegates to the canonical upstream/custom-anthropic client.
 * Removed by Phase E.10 once all importers move to the upstream registry.
 */

import type { CompiledProvider } from "../../db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../protocols/anthropic/types"
import type { ServerSentEvent } from "../../util/sse"
import {
  CustomAnthropicClient,
  defaultCustomAnthropicConfig,
} from "../../upstream/custom-anthropic"

export async function sendAnthropicDirect(
  provider: CompiledProvider,
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  const client = new CustomAnthropicClient(defaultCustomAnthropicConfig())
  return client.send({ provider, payload })
}
