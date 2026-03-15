import { logger } from "../util/logger.ts";

export interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
}

/**
 * Fetch a short-lived Copilot session JWT from GitHub API.
 */
export async function fetchCopilotToken(
  githubToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CopilotTokenResponse> {
  const res = await fetchFn(
    "https://api.github.com/copilot_internal/v2/token",
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
      `Copilot token fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  return res.json();
}

/**
 * Manages the dual-layer token system:
 * - Layer 1: GitHub OAuth token (persistent, handled by auth.ts)
 * - Layer 2: Copilot session JWT (in-memory, auto-refreshed)
 */
export class TokenManager {
  private copilotToken: CopilotTokenResponse | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  setCopilotToken(token: CopilotTokenResponse): void {
    this.copilotToken = token;
  }

  getToken(): string | null {
    return this.copilotToken?.token ?? null;
  }

  isExpired(): boolean {
    if (!this.copilotToken) return true;

    const nowSeconds = Math.floor(Date.now() / 1000);
    return nowSeconds >= this.copilotToken.expires_at;
  }

  /**
   * Calculate the delay before next refresh.
   * Refreshes 60 seconds before the refresh_in hint, minimum 10 seconds.
   */
  getRefreshDelay(): number {
    if (!this.copilotToken) return 10000;

    const delayMs = (this.copilotToken.refresh_in - 60) * 1000;
    return Math.max(delayMs, 10000);
  }

  /**
   * Start auto-refresh loop.
   */
  startAutoRefresh(
    githubToken: string,
    fetchFn: typeof fetch = globalThis.fetch,
  ): void {
    this.stopAutoRefresh();

    const doRefresh = async () => {
      try {
        const newToken = await fetchCopilotToken(githubToken, fetchFn);
        this.setCopilotToken(newToken);
        logger.info(
          `Copilot JWT refreshed, next refresh in ${Math.round(this.getRefreshDelay() / 1000)}s`,
        );
        // Schedule next refresh based on new token's refresh_in
        this.refreshTimer = setTimeout(doRefresh, this.getRefreshDelay());
      } catch (err) {
        logger.error("Failed to refresh Copilot JWT", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Retry directly in 30 seconds (no double-scheduling)
        this.refreshTimer = setTimeout(doRefresh, 30000);
      }
    };

    // First refresh after current token's delay
    this.refreshTimer = setTimeout(doRefresh, this.getRefreshDelay());
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
