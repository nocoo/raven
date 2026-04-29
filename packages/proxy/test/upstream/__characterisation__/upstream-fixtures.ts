/**
 * Phase E.2 characterisation fixtures — request shapes that every
 * outbound service emits today. The same fixtures become the assertion
 * target for the E.3–E.8 upstream/* ports, so any drift surfaces as a
 * failed diff against this file rather than a silent behaviour change.
 *
 * Format per entry:
 *   - id:      stable name (matches the service file)
 *   - input:   the payload + state ambient values used to drive the call
 *   - request: { url, method, proxy, headers, body } as observed on the
 *              wire. Headers with per-request UUIDs are normalised to
 *              "<UUID>" so the fixture stays diff-able.
 *
 * Headers are recorded lower-cased and sorted at compare time. The
 * `proxy` field is the resolved proxy URL string (null when unset).
 */

export interface CharacterisationEntry {
  id: string
  input: {
    payload: unknown
    state: Record<string, unknown>
    options?: Record<string, unknown>
    provider?: Record<string, unknown>
  }
  request: {
    url: string
    method: string
    proxy: string | null
    headers: Record<string, string>
    body: unknown
  }
}

export const upstreamCharacterisations: ReadonlyArray<CharacterisationEntry> = [
  {
    id: "copilot-openai/non-stream",
    input: {
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "ping" }],
      },
      state: {
        copilotToken: "test-jwt",
        vsCodeVersion: "1.90.0",
        accountType: "individual",
        copilotChatVersion: "0.26.7",
      },
    },
    request: {
      url: "https://api.githubcopilot.com/chat/completions",
      method: "POST",
      proxy: null,
      headers: {
        "authorization": "Bearer test-jwt",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.90.0",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-request-id": "<UUID>",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "x-initiator": "user",
      },
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "ping" }],
      },
    },
  },
  {
    id: "copilot-openai/agent-call",
    input: {
      payload: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "?" },
          { role: "assistant", content: "ok" },
        ],
        stream: true,
      },
      state: {
        copilotToken: "test-jwt",
        vsCodeVersion: "1.90.0",
        accountType: "individual",
        copilotChatVersion: "0.26.7",
      },
    },
    request: {
      url: "https://api.githubcopilot.com/chat/completions",
      method: "POST",
      proxy: null,
      headers: {
        "authorization": "Bearer test-jwt",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.90.0",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-request-id": "<UUID>",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "x-initiator": "agent",
      },
      body: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "?" },
          { role: "assistant", content: "ok" },
        ],
        stream: true,
      },
    },
  },
  {
    id: "copilot-native/basic",
    input: {
      payload: {
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 100,
      },
      options: {
        copilotModel: "claude-opus-4.6",
        anthropicBeta: null,
      },
      state: {
        copilotToken: "test-jwt",
        vsCodeVersion: "1.90.0",
        accountType: "individual",
        copilotChatVersion: "0.26.7",
      },
    },
    request: {
      url: "https://api.githubcopilot.com/v1/messages",
      method: "POST",
      proxy: null,
      headers: {
        "authorization": "Bearer test-jwt",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.90.0",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-request-id": "<UUID>",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "anthropic-version": "2023-06-01",
        "x-initiator": "user",
      },
      body: {
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 100,
      },
    },
  },
  {
    id: "copilot-responses/basic",
    input: {
      payload: {
        model: "gpt-5",
        input: [{ role: "user", content: "ping" }],
      },
      state: {
        copilotToken: "test-jwt",
        vsCodeVersion: "1.90.0",
        accountType: "individual",
        copilotChatVersion: "0.26.7",
      },
    },
    request: {
      url: "https://api.githubcopilot.com/responses",
      method: "POST",
      proxy: null,
      headers: {
        "authorization": "Bearer test-jwt",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.90.0",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-request-id": "<UUID>",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "x-initiator": "user",
      },
      body: {
        model: "gpt-5",
        input: [{ role: "user", content: "ping" }],
      },
    },
  },
  {
    id: "copilot-embeddings/basic",
    input: {
      payload: {
        model: "copilot-text-embedding-ada-002",
        input: "hello",
      },
      state: {
        copilotToken: "test-jwt",
        vsCodeVersion: "1.90.0",
        accountType: "individual",
        copilotChatVersion: "0.26.7",
      },
    },
    request: {
      url: "https://api.githubcopilot.com/embeddings",
      method: "POST",
      proxy: null,
      headers: {
        "authorization": "Bearer test-jwt",
        "content-type": "application/json",
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.90.0",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-request-id": "<UUID>",
        "x-vscode-user-agent-library-version": "electron-fetch",
      },
      body: {
        model: "copilot-text-embedding-ada-002",
        input: "hello",
      },
    },
  },
  {
    id: "custom-openai/basic",
    input: {
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
      },
      state: { copilotToken: "test-jwt" },
      provider: {
        id: "p1",
        name: "deepseek",
        kind: "openai",
        base_url: "https://api.deepseek.com",
        api_key: "sk-test",
      },
    },
    request: {
      url: "https://api.deepseek.com/v1/chat/completions",
      method: "POST",
      proxy: null,
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer sk-test",
      },
      body: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
      },
    },
  },
  {
    id: "custom-openai/trailing-slash",
    input: {
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
      },
      state: { copilotToken: "test-jwt" },
      provider: {
        id: "p1",
        name: "deepseek",
        kind: "openai",
        base_url: "https://api.deepseek.com/",
        api_key: "sk-test",
      },
    },
    request: {
      url: "https://api.deepseek.com/v1/chat/completions",
      method: "POST",
      proxy: null,
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer sk-test",
      },
      body: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
      },
    },
  },
  {
    id: "custom-anthropic/basic",
    input: {
      payload: {
        model: "Claude-Sonnet-4",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 100,
      },
      state: { copilotToken: "test-jwt" },
      provider: {
        id: "p2",
        name: "anthropic-direct",
        kind: "anthropic",
        base_url: "https://api.anthropic.com",
        api_key: "sk-anth",
      },
    },
    request: {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      proxy: null,
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-anth",
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 100,
      },
    },
  },
]
