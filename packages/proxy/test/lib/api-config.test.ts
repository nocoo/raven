import { describe, expect, test, beforeEach, afterEach } from "vitest"

import {
  GITHUB_API_BASE_URL,
  GITHUB_BASE_URL,
  copilotBaseUrl,
  copilotHeaders,
  copilotHeadersForToken,
  githubHeaders,
  resolveGitHubEndpoints,
} from "../../src/lib/api-config"
import { state } from "../../src/lib/state"

const saved = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  vsCodeVersion: state.vsCodeVersion,
  copilotChatVersion: state.copilotChatVersion,
  accountType: state.accountType,
  copilotApiBaseUrl: state.copilotApiBaseUrl,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "gh-token"
  state.vsCodeVersion = "1.117.0"
  state.copilotChatVersion = "0.45.1"
  state.accountType = "individual"
  state.copilotApiBaseUrl = null
})

afterEach(() => {
  state.copilotToken = saved.copilotToken
  state.githubToken = saved.githubToken
  state.vsCodeVersion = saved.vsCodeVersion
  state.copilotChatVersion = saved.copilotChatVersion
  state.accountType = saved.accountType
  state.copilotApiBaseUrl = saved.copilotApiBaseUrl
})

describe("GitHub endpoints", () => {
  test("defaults to public GitHub without configuration", () => {
    expect(resolveGitHubEndpoints()).toEqual({
      host: "github.com",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      copilotApiBaseUrl: "https://api.githubcopilot.com",
      isEnterprise: false,
    })
    expect(GITHUB_BASE_URL).toBe("https://github.com")
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com")
  })

  test.each([
    "octocorp.ghe.com",
    "https://octocorp.ghe.com/",
    "  OCTOCORP.ghe.com  ",
  ])("derives GHE.com endpoints from %s", value => {
    expect(resolveGitHubEndpoints(value)).toEqual({
      host: "octocorp.ghe.com",
      webBaseUrl: "https://octocorp.ghe.com",
      apiBaseUrl: "https://api.octocorp.ghe.com",
      copilotApiBaseUrl: "https://copilot-api.octocorp.ghe.com",
      isEnterprise: true,
    })
  })

  test.each([
    "http://octocorp.ghe.com",
    "https://octocorp.ghe.com/path",
    "https://octocorp.ghe.com?tenant=other",
    "https://octocorp.ghe.com:444",
    "api.octocorp.ghe.com",
    "github.example.com",
    "octocorp.ghe.com.evil.test",
  ])("rejects invalid or unsafe GitHub host %s", value => {
    expect(() => resolveGitHubEndpoints(value)).toThrow(
      "RAVEN_GITHUB_HOST must be github.com or a SUBDOMAIN.ghe.com hostname",
    )
  })

  test("uses the configured GHE.com Copilot endpoint as the fallback", () => {
    const ghe = resolveGitHubEndpoints("octocorp.ghe.com")
    expect(copilotBaseUrl(state, ghe)).toBe("https://copilot-api.octocorp.ghe.com")
  })

  test("uses the token endpoint before the public account-type fallback", () => {
    state.accountType = "enterprise"
    state.copilotApiBaseUrl = "https://api.enterprise.githubcopilot.com"
    expect(copilotBaseUrl(state)).toBe("https://api.enterprise.githubcopilot.com")
  })
})

describe("copilotHeaders", () => {
  test("uses x-github-api-version 2025-10-01", () => {
    const headers = copilotHeaders(state)
    expect(headers["x-github-api-version"]).toBe("2025-10-01")
  })

  test("includes x-interaction-type: conversation-panel", () => {
    const headers = copilotHeaders(state)
    expect(headers["x-interaction-type"]).toBe("conversation-panel")
  })

  test("uses configured editor and plugin versions", () => {
    const headers = copilotHeaders(state)
    expect(headers["editor-version"]).toBe("vscode/1.117.0")
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })

  test("falls back to 0.45.1 when copilotChatVersion is null", () => {
    state.copilotChatVersion = null
    const headers = copilotHeaders(state)
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })

  test("emits stable header set with vision flag added when requested", () => {
    expect(copilotHeaders(state)["copilot-vision-request"]).toBeUndefined()
    expect(copilotHeaders(state, true)["copilot-vision-request"]).toBe("true")
  })
})

describe("githubHeaders", () => {
  test("uses x-github-api-version 2025-10-01", () => {
    expect(githubHeaders(state)["x-github-api-version"]).toBe("2025-10-01")
  })

  test("uses configured editor and plugin versions", () => {
    const headers = githubHeaders(state)
    expect(headers["editor-version"]).toBe("vscode/1.117.0")
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.45.1")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.45.1")
  })
})

describe("copilotHeadersForToken", () => {
  test("uses caller-supplied token instead of state.copilotToken", () => {
    state.copilotToken = "state-token"
    const headers = copilotHeadersForToken(state, "explicit-token")
    expect(headers.Authorization).toBe("Bearer explicit-token")
  })

  test("ignores state mutation after capture (atomic snapshot)", () => {
    state.copilotToken = "before"
    const captured = state.copilotToken
    state.copilotToken = "after"
    const headers = copilotHeadersForToken(state, captured)
    expect(headers.Authorization).toBe("Bearer before")
  })

  test("null token renders as 'Bearer ' (not literal 'Bearer null')", () => {
    const headers = copilotHeadersForToken(state, null)
    expect(headers.Authorization).toBe("Bearer ")
  })

  test("vision flag adds copilot-vision-request header", () => {
    expect(
      copilotHeadersForToken(state, "tok")["copilot-vision-request"],
    ).toBeUndefined()
    expect(
      copilotHeadersForToken(state, "tok", true)["copilot-vision-request"],
    ).toBe("true")
  })

  test("copilotHeaders is a thin wrapper that delegates to copilotHeadersForToken", () => {
    state.copilotToken = "wrap-token"
    const direct = copilotHeadersForToken(state, "wrap-token")
    const wrapped = copilotHeaders(state)
    // x-request-id differs per call; everything else must match
    expect({ ...wrapped, "x-request-id": undefined }).toEqual({
      ...direct,
      "x-request-id": undefined,
    })
  })
})
