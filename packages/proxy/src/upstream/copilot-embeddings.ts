/**
 * Phase E.6 — copilot Embeddings port.
 *
 * Same wire behaviour as services/copilot/create-embeddings.ts.
 * Wire types remain canonical here; legacy file becomes a shim re-exporting them.
 */

import { copilotBaseUrl, copilotHeaders } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import type { UpstreamClient, UpstreamResult } from "./interface"

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

export interface CopilotEmbeddingsConfig {
  getToken(): string
  getBaseUrl(): string
  getHeaders(): Record<string, string>
  getProxyUrl(): string | undefined
}

export class CopilotEmbeddingsClient
  implements UpstreamClient<EmbeddingRequest, EmbeddingResponse>
{
  constructor(private readonly config: CopilotEmbeddingsConfig) {}

  async send(payload: EmbeddingRequest): Promise<UpstreamResult<EmbeddingResponse>> {
    this.config.getToken()

    const proxyUrl = this.config.getProxyUrl()
    const response = await fetch(`${this.config.getBaseUrl()}/embeddings`, {
      method: "POST",
      headers: this.config.getHeaders(),
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse("Failed to create embeddings", response)
    }

    return (await response.json()) as EmbeddingResponse
  }
}

export function defaultCopilotEmbeddingsConfig(): CopilotEmbeddingsConfig {
  return {
    getToken: () => {
      if (!state.copilotToken) throw new Error("Copilot token not found")
      return state.copilotToken
    },
    getBaseUrl: () => copilotBaseUrl(state),
    getHeaders: () => copilotHeaders(state),
    getProxyUrl: () => getProxyUrl("copilot", state),
  }
}

export function createDefaultCopilotEmbeddingsClient(): CopilotEmbeddingsClient {
  return new CopilotEmbeddingsClient(defaultCopilotEmbeddingsConfig())
}
