import type { UpstreamOperationDetails } from "../core/routing-types"
import { HTTPError } from "./error"

const MAX_RESPONSE_BODY = 8192
const SECRET_FIELD = /^(?:authorization|proxyauthorization|apikey|accesskey|token|accesstoken|refreshtoken|password|secret|clientsecret|cookie|setcookie)$/i

function isSecretField(value: string): boolean {
  return SECRET_FIELD.test(value.replace(/[-_]/g, ""))
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return "[invalid URL]"
  }
}

export function redactUpstreamText(value: string, secrets: readonly string[]): string {
  let text = value
  const variants = new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[REDACTED]")
  return text
    .replace(/https?:\/\/[^\s<>"']+/g, safeUrl)
    .replace(/\b(Bearer|Basic|token)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
    .replace(/((?:api[_-]?key|authorization|proxy[_-]?authorization|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}<]+)/gi, "$1\"[REDACTED]\"")
}

function responseDetails(details: UpstreamOperationDetails, body: string, secrets: readonly string[]): void {
  let safeBody: string
  try {
    const value = JSON.parse(body, (key, item: unknown) => isSecretField(key)
      ? "[REDACTED]"
      : typeof item === "string" ? redactUpstreamText(item, secrets) : item) as unknown
    safeBody = JSON.stringify(value, null, 2)
    if (value && typeof value === "object") {
      const response = value as {
        status?: unknown
        stop_reason?: unknown
        incomplete_details?: { reason?: unknown } | null
        choices?: { finish_reason?: unknown }[]
      }
      const finish = response.stop_reason ?? response.choices?.[0]?.finish_reason ?? response.incomplete_details?.reason
      if (typeof finish === "string") details.finish_reason = finish.slice(0, 256)
      if (typeof response.status === "string") details.response_status = response.status.slice(0, 256)
    }
  } catch {
    safeBody = redactUpstreamText(body, secrets)
  }
  details.response_body = safeBody.slice(0, MAX_RESPONSE_BODY)
  details.response_body_truncated = safeBody.length > MAX_RESPONSE_BODY
}

export function captureOperationFetch(
  details: UpstreamOperationDetails,
  secrets: string[],
  send: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const capture = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null
    const rawUrl = request?.url ?? String(input)
    try {
      const url = new URL(rawUrl)
      secrets.push(decodeURIComponent(url.username), decodeURIComponent(url.password), ...url.searchParams.values())
    } catch { /* Malformed URLs are reported by the transport without exposing their contents. */ }
    const headers = new Headers(init?.headers ?? request?.headers)
    for (const [key, value] of headers) {
      if (!isSecretField(key)) continue
      secrets.push(value, value.replace(/^(?:Bearer|Basic|token)\s+/i, ""))
    }
    details.method = init?.method ?? request?.method ?? "GET"
    details.url = redactUpstreamText(safeUrl(rawUrl), secrets)
    const response = await send(input, init)
    details.upstream_status = response.status
    const contentType = response.headers.get("content-type")
    if (contentType) details.content_type = redactUpstreamText(contentType, secrets).slice(0, 256)
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
    if (!details.request_id && requestId) details.request_id = redactUpstreamText(requestId, secrets).slice(0, 256)
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") {
      await response.body?.cancel().catch(() => undefined)
      throw new HTTPError(details.operation === "generation_test" ? "The diagnostic returned an unexpected stream" : "Model discovery returned an unexpected stream", response.ok ? 502 : response.status, "", details)
    }
    const readText = response.text.bind(response)
    const text = async () => {
      const body = await readText()
      responseDetails(details, body, secrets)
      return body
    }
    // Capture only when the existing client consumes the body; do not pre-read or clone it.
    return Object.assign(response, { text, json: async () => JSON.parse(await text()) as unknown })
  }
  return Object.assign(capture, { preconnect: send.preconnect }) as typeof globalThis.fetch
}
