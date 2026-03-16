import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"

import { state } from "../../src/lib/state"
import { cacheVSCodeVersion, cacheModels, isNullish, sleep } from "../../src/lib/utils"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedVsCodeVersion = state.vsCodeVersion
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  state.vsCodeVersion = savedVsCodeVersion
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
})

// ===========================================================================
// cacheVSCodeVersion
// ===========================================================================

describe("cacheVSCodeVersion", () => {
  test("fetches version and stores in state", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("pkgname=visual-studio-code-bin\npkgver=1.99.0\npkgrel=1", {
        status: 200,
      }),
    )

    await cacheVSCodeVersion()
    expect(state.vsCodeVersion).toBe("1.99.0")
  })

  test("stores fallback version on fetch failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    await cacheVSCodeVersion()
    // getVSCodeVersion returns fallback on error
    expect(state.vsCodeVersion).toBe("1.104.3")
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
