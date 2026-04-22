/**
 * Legacy facade — delegates to the canonical upstream/copilot-native client.
 * Removed by Phase E.10 once all importers move to the upstream registry.
 *
 * Re-exports the wire types so existing importers still resolve.
 */

import {
  CopilotNativeClient,
  defaultCopilotNativeConfig,
  type NativeMessagesOptions as ClientNativeMessagesOptions,
} from "../../upstream/copilot-native"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../protocols/anthropic/types"
import type { ServerSentEvent } from "../../util/sse"

export type NativeMessagesOptions = ClientNativeMessagesOptions

export async function createNativeMessages(
  payload: AnthropicMessagesPayload,
  options: NativeMessagesOptions,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  const client = new CopilotNativeClient(defaultCopilotNativeConfig())
  return client.send({ payload, options })
}
