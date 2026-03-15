import { buildCopilotHeaders } from "./headers.ts";

/**
 * Fetch Copilot user/subscription info from GitHub API.
 * Uses the Copilot JWT (same as models endpoint), not the GitHub OAuth token.
 */
export async function fetchCopilotUser(
  copilotJwt: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const res = await fetchFn(
    "https://api.github.com/copilot_internal/user",
    {
      headers: buildCopilotHeaders(copilotJwt),
    },
  );

  if (!res.ok) {
    throw new Error(
      `Copilot user info fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  return res.json();
}
