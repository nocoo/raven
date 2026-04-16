import { GITHUB_API_BASE_URL, standardHeaders } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import { getProxyUrl } from "./../../lib/socks5-bridge"
import { state } from "./../../lib/state"

export async function getGitHubUser() {
  const proxyUrl = getProxyUrl("github", state)
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${state.githubToken}`,
      ...standardHeaders(),
    },
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
