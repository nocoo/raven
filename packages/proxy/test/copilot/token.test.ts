import { describe, expect, test, mock } from "bun:test";

describe("Copilot Token Manager", () => {
  describe("CopilotToken", () => {
    test("fetches copilot JWT from GitHub API", async () => {
      const { fetchCopilotToken } = await import("../../src/copilot/token.ts");

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              token: "tid=copilot-jwt-123",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
              refresh_in: 1500,
            }),
            { status: 200 },
          ),
        ),
      );

      const result = await fetchCopilotToken(
        "gho_github_token",
        mockFetch as unknown as typeof fetch,
      );

      expect(result.token).toBe("tid=copilot-jwt-123");
      expect(result.expires_at).toBeGreaterThan(0);
      expect(result.refresh_in).toBe(1500);

      // Verify correct API call
      const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe(
        "https://api.github.com/copilot_internal/v2/token",
      );
      expect(call[1]?.headers).toBeDefined();
    });

    test("throws on non-200 response", async () => {
      const { fetchCopilotToken } = await import("../../src/copilot/token.ts");

      const mockFetch = mock(() =>
        Promise.resolve(new Response("unauthorized", { status: 401 })),
      );

      expect(
        fetchCopilotToken("bad_token", mockFetch as unknown as typeof fetch),
      ).rejects.toThrow();
    });
  });

  describe("TokenManager", () => {
    test("isExpired returns true for expired tokens", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      // Token that expired 10 seconds ago
      manager.setCopilotToken({
        token: "expired-jwt",
        expires_at: Math.floor(Date.now() / 1000) - 10,
        refresh_in: 1500,
      });

      expect(manager.isExpired()).toBe(true);
    });

    test("isExpired returns false for valid tokens", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      manager.setCopilotToken({
        token: "valid-jwt",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        refresh_in: 1500,
      });

      expect(manager.isExpired()).toBe(false);
    });

    test("isExpired returns true when no token is set", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      expect(manager.isExpired()).toBe(true);
    });

    test("getToken returns current JWT", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      manager.setCopilotToken({
        token: "my-jwt",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        refresh_in: 1500,
      });

      expect(manager.getToken()).toBe("my-jwt");
    });

    test("getToken returns null when no token", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      expect(manager.getToken()).toBeNull();
    });

    test("getRefreshDelay calculates correct delay", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      manager.setCopilotToken({
        token: "jwt",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        refresh_in: 1500,
      });

      const delay = manager.getRefreshDelay();
      // (1500 - 60) * 1000 = 1440000ms
      expect(delay).toBe(1440000);
    });

    test("getRefreshDelay returns minimum 10s for short refresh_in", async () => {
      const { TokenManager } = await import("../../src/copilot/token.ts");

      const manager = new TokenManager();
      manager.setCopilotToken({
        token: "jwt",
        expires_at: Math.floor(Date.now() / 1000) + 100,
        refresh_in: 30,
      });

      const delay = manager.getRefreshDelay();
      // max((30 - 60) * 1000, 10000) = 10000
      expect(delay).toBe(10000);
    });
  });
});

describe("VS Code Headers", () => {
  test("builds correct copilot headers", async () => {
    const { buildCopilotHeaders } = await import("../../src/copilot/headers.ts");

    const headers = buildCopilotHeaders("jwt-token-123");

    expect(headers.authorization).toBe("Bearer jwt-token-123");
    expect(headers["editor-version"]).toMatch(/^vscode\//);
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.26.7");
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.26.7");
    expect(headers["copilot-integration-id"]).toBe("vscode-chat");
    expect(headers["openai-intent"]).toBe("conversation-panel");
    expect(headers["x-github-api-version"]).toBe("2025-04-01");
    expect(headers["x-request-id"]).toBeDefined();
    expect(headers["x-request-id"].length).toBeGreaterThan(0);
    expect(headers["x-vscode-user-agent-library-version"]).toBe("electron-fetch");
  });

  test("generates unique x-request-id per call", async () => {
    const { buildCopilotHeaders } = await import("../../src/copilot/headers.ts");

    const h1 = buildCopilotHeaders("jwt");
    const h2 = buildCopilotHeaders("jwt");
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
  });
});

describe("VS Code Version", () => {
  test("getVSCodeVersion returns a semver-like string", async () => {
    const { getVSCodeVersion } = await import("../../src/copilot/vscode.ts");

    const version = getVSCodeVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
