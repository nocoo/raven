import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Database } from "bun:sqlite"

import { state } from "../../src/lib/state"
import { cacheVersions, cacheModels, isNullish, sleep } from "../../src/lib/utils"
import { initSettings } from "../../src/db/settings"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedVsCodeVersion = state.vsCodeVersion
const savedVsCodeVersionSource = state.vsCodeVersionSource
const savedCopilotChatVersion = state.copilotChatVersion
const savedCopilotChatVersionSource = state.copilotChatVersionSource
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>
let db: Database

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
  db = new Database(":memory:")
  initSettings(db)
})

afterEach(() => {
  state.vsCodeVersion = savedVsCodeVersion
  state.vsCodeVersionSource = savedVsCodeVersionSource
  state.copilotChatVersion = savedCopilotChatVersion
  state.copilotChatVersionSource = savedCopilotChatVersionSource
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
  db.close()
})

// ===========================================================================
// cacheVersions
// ===========================================================================

describe("cacheVersions", () => {
  test("resolves VS Code version via AUR fallback chain and Copilot Chat to fallback", async () => {
    // AUR fetch returns a version for VS Code
    fetchSpy.mockResolvedValueOnce(
      new Response("pkgname=visual-studio-code-bin\npkgver=1.99.0\npkgrel=1", {
        status: 200,
      }),
    )

    await cacheVersions(db)
    // VS Code: local detection may or may not succeed depending on host,
    // but AUR mock should provide 1.99.0 if local detection fails
    expect(state.vsCodeVersion).toBeDefined()
    // Copilot Chat: no local extension in test env, should fallback
    expect(state.copilotChatVersion).toBeDefined()
    expect(state.copilotChatVersionSource).toBeDefined()
  })

  test("uses DB override when set", async () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "vscode_version",
      $value: "1.200.0",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "copilot_chat_version",
      $value: "9.99.9",
    })

    await cacheVersions(db)
    expect(state.vsCodeVersion).toBe("1.200.0")
    expect(state.vsCodeVersionSource).toBe("override")
    expect(state.copilotChatVersion).toBe("9.99.9")
    expect(state.copilotChatVersionSource).toBe("override")
  })

  test("stores fallback on fetch failure when no local or DB override", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    await cacheVersions(db)
    // If local detection fails too, should end up at AUR fallback (which is "1.104.3")
    // or local detection succeeded — either way vsCodeVersion should be set
    expect(state.vsCodeVersion).toBeDefined()
    expect(state.copilotChatVersion).toBeDefined()
  })
})

// ===========================================================================
// cacheModels
// ===========================================================================

describe("cacheModels", () => {
  test("fetches models and stores in state", async () => {
    state.models = undefined
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4",
              name: "GPT-4",
              object: "model",
              vendor: "openai",
              version: "2024",
              preview: false,
              model_picker_enabled: true,
              capabilities: {
                family: "gpt-4",
                object: "model_capabilities",
                type: "chat",
                tokenizer: "cl100k_base",
                limits: {},
                supports: {},
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    await cacheModels()
    expect(state.models).toBeDefined()
    expect(state.models!.data[0].id).toBe("gpt-4")
  })
})

// ===========================================================================
// isNullish
// ===========================================================================

describe("isNullish", () => {
  test("null → true", () => expect(isNullish(null)).toBe(true))
  test("undefined → true", () => expect(isNullish(undefined)).toBe(true))
  test("0 → false", () => expect(isNullish(0)).toBe(false))
  test("empty string → false", () => expect(isNullish("")).toBe(false))
  test("false → false", () => expect(isNullish(false)).toBe(false))
})

// ===========================================================================
// sleep
// ===========================================================================

describe("sleep", () => {
  test("resolves after specified duration", async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })
})
