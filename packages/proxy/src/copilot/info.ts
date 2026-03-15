/**
 * Fetch Copilot user/subscription info from GitHub API.
 */
export async function fetchCopilotUser(
  githubToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const res = await fetchFn(
    "https://api.github.com/copilot_internal/user",
    {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/json",
        "User-Agent": "GitHubCopilotChat/0.26.7",
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `Copilot user info fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  return res.json();
}
