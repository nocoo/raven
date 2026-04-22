/**
 * Legacy facade — delegates to the canonical upstream/copilot-responses client.
 * Removed by Phase E.10 once all importers move to the upstream registry.
 *
 * Re-exports the wire types and pure helpers so existing importers still resolve.
 */

import {
  CopilotResponsesClient,
  defaultCopilotResponsesConfig,
  type ResponsesPayload as ClientResponsesPayload,
} from "../../upstream/copilot-responses"
import type { ServerSentEvent } from "../../util/sse"

export type ResponsesPayload = ClientResponsesPayload

export {
  hasVisionContent,
  hasAgentHistory,
} from "../../upstream/copilot-responses"

export const createResponses = async (
  payload: ResponsesPayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | AsyncGenerator<ServerSentEvent>> => {
  const client = new CopilotResponsesClient(defaultCopilotResponsesConfig())
  return client.send(payload)
}
