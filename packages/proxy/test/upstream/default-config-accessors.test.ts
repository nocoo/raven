/**
 * Coverage backfill for the `defaultCopilotXxxConfig()` factory accessors
 * across the four Copilot upstream clients. The fixture-driven tests in
 * `copilot-openai.test.ts` / `copilot-native.test.ts` / etc. only exercise
 * `getToken()` + `snapshotAuth()`, leaving `getBaseUrl()` / `getHeaders()` /
 * `getProxyUrl()` and the `snapshotAuth` token-missing path uncovered.
 *
 * Those accessors are the public seam strategies use to derive request-side
 * inputs; regressions there silently break the live path even when send()
 * tests still match fixtures, so we cover them directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { state } from "../../src/lib/state"
import { defaultCopilotEmbeddingsConfig } from "../../src/upstream/copilot-embeddings"
import { defaultCopilotNativeConfig } from "../../src/upstream/copilot-native"
import { defaultCopilotOpenAIConfig } from "../../src/upstream/copilot-openai"
import { defaultCopilotResponsesConfig } from "../../src/upstream/copilot-responses"

const SAVED = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  copilotChatVersion: state.copilotChatVersion,
  copilotApiBaseUrl: state.copilotApiBaseUrl,
}

beforeEach(() => {
  state.copilotToken = "tok-default"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  state.copilotChatVersion = "0.45.1"
  state.copilotApiBaseUrl = null
})

afterEach(() => {
  state.copilotToken = SAVED.copilotToken
  state.vsCodeVersion = SAVED.vsCodeVersion
  state.accountType = SAVED.accountType
  state.copilotChatVersion = SAVED.copilotChatVersion
  state.copilotApiBaseUrl = SAVED.copilotApiBaseUrl
})

describe("defaultCopilotEmbeddingsConfig accessors", () => {
  test("getToken/getBaseUrl/getHeaders/getProxyUrl read from state", () => {
    const cfg = defaultCopilotEmbeddingsConfig()
    expect(cfg.getToken()).toBe("tok-default")
    expect(typeof cfg.getBaseUrl()).toBe("string")
    expect(cfg.getBaseUrl().length).toBeGreaterThan(0)
    expect(typeof cfg.getHeaders()).toBe("object")
    expect(cfg.getProxyUrl()).toBeUndefined()
  })

  test("getToken throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotEmbeddingsConfig()
    expect(() => cfg.getToken()).toThrow("Copilot token not found")
  })

  test("snapshotAuth throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotEmbeddingsConfig()
    expect(() => cfg.snapshotAuth()).toThrow("Copilot token not found")
  })

  test("snapshotAuth returns Bearer header for current state token", () => {
    const { token, headers } = defaultCopilotEmbeddingsConfig().snapshotAuth()
    expect(token).toBe("tok-default")
    expect(headers.Authorization).toBe("Bearer tok-default")
  })
})

describe("defaultCopilotNativeConfig accessors", () => {
  test("getToken/getBaseUrl/getHeaders/getProxyUrl read from state", () => {
    const cfg = defaultCopilotNativeConfig()
    expect(cfg.getToken()).toBe("tok-default")
    expect(typeof cfg.getBaseUrl()).toBe("string")
    expect(cfg.getBaseUrl().length).toBeGreaterThan(0)
    expect(typeof cfg.getHeaders()).toBe("object")
    expect(cfg.getProxyUrl()).toBeUndefined()
  })

  test("getToken throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotNativeConfig()
    expect(() => cfg.getToken()).toThrow("Copilot token not found")
  })

  test("snapshotAuth throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotNativeConfig()
    expect(() =>
      cfg.snapshotAuth({ anthropicBeta: null, visionRequest: false, isAgentCall: false }),
    ).toThrow("Copilot token not found")
  })

  test("snapshotAuth stamps anthropic-version + X-Initiator and optional beta", () => {
    const cfg = defaultCopilotNativeConfig()
    const userCall = cfg.snapshotAuth({
      anthropicBeta: null,
      visionRequest: false,
      isAgentCall: false,
    })
    expect(userCall.token).toBe("tok-default")
    expect(userCall.headers["anthropic-version"]).toBe("2023-06-01")
    expect(userCall.headers["X-Initiator"]).toBe("user")
    expect(userCall.headers["anthropic-beta"]).toBeUndefined()

    const agentBeta = cfg.snapshotAuth({
      anthropicBeta: "interleaved-thinking-2025-05-14",
      visionRequest: true,
      isAgentCall: true,
    })
    expect(agentBeta.headers["X-Initiator"]).toBe("agent")
    expect(agentBeta.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
  })
})

describe("defaultCopilotOpenAIConfig accessors", () => {
  test("getToken/getBaseUrl/getHeaders/getProxyUrl read from state", () => {
    const cfg = defaultCopilotOpenAIConfig()
    expect(cfg.getToken()).toBe("tok-default")
    expect(typeof cfg.getBaseUrl()).toBe("string")
    expect(cfg.getBaseUrl().length).toBeGreaterThan(0)
    expect(typeof cfg.getHeaders(false)).toBe("object")
    expect(cfg.getProxyUrl()).toBeUndefined()
  })

  test("getToken throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotOpenAIConfig()
    expect(() => cfg.getToken()).toThrow("Copilot token not found")
  })

  test("snapshotAuth throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotOpenAIConfig()
    expect(() => cfg.snapshotAuth({ enableVision: false, isAgentCall: false })).toThrow(
      "Copilot token not found",
    )
  })

  test("snapshotAuth stamps X-Initiator user/agent based on isAgentCall", () => {
    const cfg = defaultCopilotOpenAIConfig()
    expect(cfg.snapshotAuth({ enableVision: false, isAgentCall: false }).headers["X-Initiator"]).toBe(
      "user",
    )
    expect(cfg.snapshotAuth({ enableVision: true, isAgentCall: true }).headers["X-Initiator"]).toBe(
      "agent",
    )
  })
})

describe("defaultCopilotResponsesConfig accessors", () => {
  test("getToken/getBaseUrl/getHeaders/getProxyUrl read from state", () => {
    const cfg = defaultCopilotResponsesConfig()
    expect(cfg.getToken()).toBe("tok-default")
    expect(typeof cfg.getBaseUrl()).toBe("string")
    expect(cfg.getBaseUrl().length).toBeGreaterThan(0)
    expect(typeof cfg.getHeaders(false)).toBe("object")
    expect(cfg.getProxyUrl()).toBeUndefined()
  })

  test("getToken throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotResponsesConfig()
    expect(() => cfg.getToken()).toThrow("Copilot token not found")
  })

  test("snapshotAuth throws when state token missing", () => {
    state.copilotToken = null
    const cfg = defaultCopilotResponsesConfig()
    expect(() => cfg.snapshotAuth({ enableVision: false, isAgentCall: false })).toThrow(
      "Copilot token not found",
    )
  })

  test("snapshotAuth stamps X-Initiator user/agent based on isAgentCall", () => {
    const cfg = defaultCopilotResponsesConfig()
    expect(cfg.snapshotAuth({ enableVision: false, isAgentCall: false }).headers["X-Initiator"]).toBe(
      "user",
    )
    expect(cfg.snapshotAuth({ enableVision: true, isAgentCall: true }).headers["X-Initiator"]).toBe(
      "agent",
    )
  })
})
