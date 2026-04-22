/**
 * Legacy facade — delegates to the canonical upstream/copilot-embeddings client.
 * Removed by Phase E.10 once all importers move to the upstream registry.
 */

import {
  CopilotEmbeddingsClient,
  defaultCopilotEmbeddingsConfig,
} from "../../upstream/copilot-embeddings"

export type {
  EmbeddingRequest,
  Embedding,
  EmbeddingResponse,
} from "../../upstream/copilot-embeddings"

import type { EmbeddingRequest, EmbeddingResponse } from "../../upstream/copilot-embeddings"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
): Promise<EmbeddingResponse> => {
  const client = new CopilotEmbeddingsClient(defaultCopilotEmbeddingsConfig())
  return (await client.send(payload)) as EmbeddingResponse
}
