import { GITHUB_API_BASE_URL, githubHeaders } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import { getProxyUrl } from "./../../lib/socks5-bridge"
import { state } from "./../../lib/state"

export const getCopilotToken = async () => {
  const proxyUrl = getProxyUrl("github", state)
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
      redirect: "manual",
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit,
  )

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get Copilot token", response)

  const grant = (await response.json()) as GetCopilotTokenResponse
  return { ...grant, api_base_url: parseCopilotApiBaseUrl(grant.endpoints?.api) }
}

export function parseCopilotApiBaseUrl(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === "string") {
    try {
      const url = new URL(value)
      if (url.protocol === "https:" && /^api(?:\.[a-z0-9-]+)*\.githubcopilot\.com$/.test(url.hostname)
        && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash) return url.origin
    } catch { /* Reject malformed credential destinations without echoing them. */ }
  }
  throw new Error("Invalid Copilot API endpoint in token response")
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: { api?: string }
}
