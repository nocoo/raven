import type { CompiledProvider } from "../db/providers"
import { HTTPError } from "../lib/error"
import type { ImageGenerationRequest } from "../protocols/images/request"

export interface CustomImagesConfig {
  getProxyUrl(provider: CompiledProvider): string | undefined
}

/** JSON-only image passthrough. Never logs bodies, URLs, or credentials. */
export class CustomImagesClient {
  constructor(private readonly config: CustomImagesConfig) {}

  async send(
    provider: CompiledProvider,
    payload: ImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const base = provider.base_url.replace(/\/+$/, "")
    const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/images/generations`
    const proxyUrl = this.config.getProxyUrl(provider)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(payload),
      // Never follow an upstream redirect to a different service with a paid request.
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)
    const body = await response.text()
    try {
      JSON.parse(body)
    } catch {
      throw new HTTPError("Image upstream returned a non-JSON response.", 502)
    }
    const headers = new Headers({ "Content-Type": "application/json" })
    const retryAfter = response.headers.get("retry-after")
    if (retryAfter) headers.set("Retry-After", retryAfter)
    // Preserve status, base64, URLs, revised prompts and usage byte-for-byte.
    // Do not forward upstream cookies, CORS, or authentication headers.
    return new Response(body, { status: response.status, headers })
  }
}
