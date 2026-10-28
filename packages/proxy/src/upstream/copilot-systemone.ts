import { copilotHeadersForToken } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { redactUpstreamText } from "../lib/upstream-operation"
import { systemoneFailed, SystemoneUpstreamError, type SystemonePayload } from "../protocols/systemone"
import { modelFetch, type ModelHttpConfig } from "./model-http"

export interface CopilotSystemoneConfig extends ModelHttpConfig {
  getBaseUrl(): string
  getProxyUrl(): string | undefined
  snapshotAuth(): { token: string; headers: Record<string, string> }
}

export interface SystemoneResult {
  status: number
  contentType: string
  text: string
  data: unknown
  failed: boolean
}

export class CopilotSystemoneClient {
  constructor(private readonly config: CopilotSystemoneConfig) {}

  async send(payload: SystemonePayload, signal?: AbortSignal): Promise<SystemoneResult> {
    signal?.throwIfAborted()
    const { token, headers } = this.config.snapshotAuth()
    const proxy = this.config.getProxyUrl()
    const url = `${this.config.getBaseUrl()}/v1/systemone`
    let response: Response
    try {
      response = await modelFetch(this.config)(url, {
        method: "POST", headers, signal, redirect: "manual", body: JSON.stringify(payload),
        ...(proxy ? { proxy } : {}),
      } as RequestInit)
    } catch {
      signal?.throwIfAborted()
      throw new SystemoneUpstreamError("Copilot systemone transport failed")
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const json = contentType === "application/json" || contentType?.endsWith("+json") === true
    if ((response.ok && !json) || contentType === "text/event-stream") {
      await response.body?.cancel()
      if (!response.ok) throw new HTTPError("Copilot systemone did not return JSON", response.status)
      throw new SystemoneUpstreamError("Copilot systemone did not return JSON")
    }
    let raw: string
    try { raw = await response.text() } catch {
      signal?.throwIfAborted()
      throw new SystemoneUpstreamError("Copilot systemone response read failed")
    }
    let data: unknown = null
    try { data = JSON.parse(raw) } catch {
      if (response.ok) throw new SystemoneUpstreamError("Copilot systemone returned invalid JSON")
    }
    const failed = !response.ok || systemoneFailed(data)
    const text = failed ? redactUpstreamText(raw, [token]).slice(0, 8192) : raw
    if (failed) {
      try { data = JSON.parse(text) } catch { data = null }
    }
    return { status: response.status, contentType: json ? "application/json" : "text/plain", text, data, failed }
  }
}

export function defaultCopilotSystemoneConfig(): CopilotSystemoneConfig {
  return {
    getBaseUrl: () => {
      if (!state.copilotApiBaseUrl) throw new Error("Copilot token has no API endpoint for systemone")
      return state.copilotApiBaseUrl
    },
    getProxyUrl: () => getProxyUrl("copilot", state),
    snapshotAuth: () => {
      const token = state.copilotToken
      if (!token) throw new Error("Copilot token not found")
      return { token, headers: { ...copilotHeadersForToken(state, token), accept: "application/json", "X-Initiator": "user" } }
    },
  }
}
