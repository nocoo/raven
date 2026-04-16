import { copilotHeaders, copilotBaseUrl } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import { getProxyUrl } from "./../../lib/socks5-bridge"
import { state } from "./../../lib/state"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const proxyUrl = getProxyUrl("copilot", state)
  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(payload),
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)

  if (!response.ok) throw await HTTPError.fromResponse("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
