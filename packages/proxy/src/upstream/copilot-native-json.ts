import { copilotHeadersForToken } from "../lib/api-config"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { redactUpstreamText } from "../lib/upstream-operation"
import type { ImageEndpoint, NativeJsonPayload } from "../protocols/native-json"
import { modelFetch, type ModelHttpConfig } from "./model-http"

export interface CopilotNativeJsonConfig extends ModelHttpConfig {
  getBaseUrl(): string
  getProxyUrl(): string | undefined
  snapshotAuth(): { token: string; headers: Record<string, string> }
}

export interface CopilotNativeJsonSpec {
  path: "/v1/decisions" | ImageEndpoint
  label: "decisions" | "images"
  failed(value: unknown): boolean
}

export interface CopilotNativeJsonResult {
  status: number
  contentType: string
  text: string
  data: unknown
  failed: boolean
}

export class CopilotNativeJsonUpstreamError extends Error {
  override name = "CopilotNativeJsonUpstreamError"
}

export class CopilotNativeJsonClient {
  constructor(
    private readonly config: CopilotNativeJsonConfig,
    private readonly spec: CopilotNativeJsonSpec,
  ) {}

  async send(payload: NativeJsonPayload, signal?: AbortSignal): Promise<CopilotNativeJsonResult> {
    signal?.throwIfAborted()
    const { token, headers } = this.config.snapshotAuth()
    const requestHeaders = new Headers(headers)
    let body: BodyInit
    if (this.spec.path === "/v1/images/edits") {
      if (!(payload.form instanceof FormData)) throw new Error("Image edits requires a multipart payload")
      const form = new FormData()
      for (const [name, value] of payload.form) form.append(name, name === "model" ? payload.model : value)
      body = form
      // Fetch must supply the boundary matching its multipart encoder.
      requestHeaders.delete("content-type")
    } else {
      body = JSON.stringify(payload)
    }
    const proxy = this.config.getProxyUrl()
    const url = `${this.config.getBaseUrl()}${this.spec.path}`
    let response: Response
    try {
      response = await modelFetch(this.config)(url, {
        method: "POST", headers: requestHeaders, signal, redirect: "manual", body,
        ...(proxy ? { proxy } : {}),
      } as RequestInit)
    } catch {
      signal?.throwIfAborted()
      throw new CopilotNativeJsonUpstreamError(`Copilot ${this.spec.label} transport failed`)
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const json = contentType === "application/json" || contentType?.endsWith("+json") === true
    if (contentType === "text/event-stream" || (response.ok && !json)) {
      await response.body?.cancel()
      if (!response.ok) throw new HTTPError(`Copilot ${this.spec.label} did not return JSON`, response.status)
      throw new CopilotNativeJsonUpstreamError(`Copilot ${this.spec.label} did not return JSON`)
    }

    let raw: string
    try { raw = await response.text() } catch {
      signal?.throwIfAborted()
      throw new CopilotNativeJsonUpstreamError(`Copilot ${this.spec.label} response read failed`)
    }

    let data: unknown = null
    try { data = JSON.parse(raw) } catch {
      if (response.ok && json) throw new CopilotNativeJsonUpstreamError(`Copilot ${this.spec.label} returned invalid JSON`)
    }
    const failed = !response.ok || (json && this.spec.failed(data))
    const text = failed ? redactUpstreamText(raw, [token]).slice(0, 8192) : raw
    if (failed) {
      try { data = JSON.parse(text) } catch { data = null }
    }
    return {
      status: response.status,
      contentType: json ? "application/json" : "text/plain",
      text,
      data,
      failed,
    }
  }
}

export function defaultCopilotNativeJsonConfig(): CopilotNativeJsonConfig {
  return {
    getBaseUrl: () => {
      if (!state.copilotApiBaseUrl) throw new Error("Copilot token has no API endpoint for native JSON")
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
