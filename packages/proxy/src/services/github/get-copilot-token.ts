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
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit,
  )

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
