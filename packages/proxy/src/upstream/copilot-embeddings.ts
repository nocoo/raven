/**
 * Copilot Embeddings upstream client.
 */

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotHeadersForToken,
} from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { refreshNow, noteLlm401 } from "../lib/token-sentinel"
import { tokenSignal, isTokenExpiredBody } from "../lib/token-signal"
import type { UpstreamClient, UpstreamResult } from "./interface"
import { modelFetch, replayAllowed, type ModelHttpConfig } from "./model-http"

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

export interface CopilotEmbeddingsConfig extends ModelHttpConfig {
  getToken(): string
  getBaseUrl(): string
  getHeaders(): Record<string, string>
  getProxyUrl(): string | undefined
  snapshotAuth(): { token: string; headers: Record<string, string> }
}

export class CopilotEmbeddingsClient
  implements UpstreamClient<EmbeddingRequest, EmbeddingResponse>
{
  constructor(private readonly config: CopilotEmbeddingsConfig) {}

  async send(
    payload: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<UpstreamResult<EmbeddingResponse>> {
    signal?.throwIfAborted()
    this.config.getToken()

    const url = `${this.config.getBaseUrl()}/embeddings`
    const proxyUrl = this.config.getProxyUrl()
    const body = JSON.stringify(payload)

    const callOnce = async (): Promise<{ response: Response; usedToken: string }> => {
      signal?.throwIfAborted()
      const { token, headers } = this.config.snapshotAuth()
      const response = await modelFetch(this.config)(url, {
        method: "POST",
        signal,
        headers,
        body,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as RequestInit)
      return { response, usedToken: token }
    }

    const first = await callOnce()
    let response = first.response

    if (response.status === 401 && replayAllowed(this.config)) {
      const respBody = await response.text().catch(() => "")
      signal?.throwIfAborted()
      const tokenExpired = isTokenExpiredBody(401, respBody)
      tokenSignal.reportAuthFailure(tokenExpired ? "token-expired" : "other-401")
      noteLlm401(tokenExpired ? "token-expired" : "other-401")

      if (!tokenExpired) {
        throw new HTTPError("Failed to create embeddings", 401, respBody)
      }

      const result = await refreshNow("llm-401", first.usedToken)
      signal?.throwIfAborted()
      if (!result.ok || !result.tokenWasUpdated) {
        throw new HTTPError("Failed to create embeddings", 401, respBody)
      }

      response = (await callOnce()).response
    }

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
    snapshotAuth: () => {
      const token = state.copilotToken
      if (!token) throw new Error("Copilot token not found")
      return { token, headers: copilotHeadersForToken(state, token, false) }
    },
  }
}

export function createDefaultCopilotEmbeddingsClient(): CopilotEmbeddingsClient {
  return new CopilotEmbeddingsClient(defaultCopilotEmbeddingsConfig())
}
