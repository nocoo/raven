import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { getVSCodeVersion } from "../../src/services/get-vscode-version"
import { createEmbeddings } from "../../src/services/copilot/create-embeddings"
import { getCopilotUsage } from "../../src/services/github/get-copilot-usage"
import { state } from "../../src/lib/state"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
const savedGithubToken = state.githubToken
let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-jwt"
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  if (savedGithubToken !== undefined) state.githubToken = savedGithubToken
  else state.githubToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// getVSCodeVersion
// ===========================================================================

describe("getVSCodeVersion", () => {
  test("parses version from PKGBUILD response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("pkgname=visual-studio-code-bin\npkgver=1.96.2\npkgrel=1", {
        status: 200,
      }),
    )

    const version = await getVSCodeVersion()
    expect(version).toBe("1.96.2")
  })

  test("returns fallback when no match found", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("no version here", { status: 200 }),
    )

    const version = await getVSCodeVersion()
    expect(version).toBe("1.104.3")
  })

  test("returns fallback on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    const version = await getVSCodeVersion()
    expect(version).toBe("1.104.3")
  })

  test("returns fallback on abort/timeout", async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException("aborted", "AbortError"))

    const version = await getVSCodeVersion()
    expect(version).toBe("1.104.3")
  })
})

// ===========================================================================
// createEmbeddings
// ===========================================================================

describe("createEmbeddings", () => {
  test("returns parsed embedding response", async () => {
    const mockResp = {
      object: "list",
      data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
      model: "text-embedding-ada-002",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), { status: 200, headers: { "content-type": "application/json" } }),
    )

    const result = await createEmbeddings({ input: "test", model: "text-embedding-ada-002" })
    expect(result.model).toBe("text-embedding-ada-002")
    expect(result.data).toHaveLength(1)
  })

  test("throws when copilotToken is missing", async () => {
    state.copilotToken = null
    try {
      await createEmbeddings({ input: "test", model: "m" })
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Copilot token not found")
    }
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("error", { status: 400 }),
    )

    try {
      await createEmbeddings({ input: "test", model: "m" })
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Failed to create embeddings")
    }
  })
})

// ===========================================================================
// getCopilotUsage
// ===========================================================================

describe("getCopilotUsage", () => {
  test("returns parsed usage response", async () => {
    const mockResp = {
      access_type_sku: "pro",
      copilot_plan: "pro",
      chat_enabled: true,
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResp), { status: 200, headers: { "content-type": "application/json" } }),
    )

    const result = await getCopilotUsage()
    expect(result.copilot_plan).toBe("pro")
  })

  test("throws HTTPError on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    )

    try {
      await getCopilotUsage()
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toBe("Failed to get Copilot usage")
    }
  })
})
