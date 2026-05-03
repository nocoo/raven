import { describe, expect, test, beforeEach, afterEach } from "vitest"

import { copilotHeaders, githubHeaders } from "../../src/lib/api-config"
import { state } from "../../src/lib/state"

const saved = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  vsCodeVersion: state.vsCodeVersion,
  copilotChatVersion: state.copilotChatVersion,
  accountType: state.accountType,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.githubToken = "gh-token"
  state.vsCodeVersion = "1.117.0"
  state.copilotChatVersion = "0.45.1"
  state.accountType = "individual"
})

afterEach(() => {
  state.copilotToken = saved.copilotToken
  state.githubToken = saved.githubToken
  state.vsCodeVersion = saved.vsCodeVersion
  state.copilotChatVersion = saved.copilotChatVersion
  state.accountType = saved.accountType
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
