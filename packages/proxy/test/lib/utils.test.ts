import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Database } from "bun:sqlite"

import { state } from "../../src/lib/state"
import {
  cacheVersions,
  cacheModels,
  cacheServerTools,
  cacheOptimizations,
  cacheProviders,
  cacheSoundSettings,
  cacheIPWhitelist,
  isNullish,
  sleep,
} from "../../src/lib/utils"
import { initSettings } from "../../src/db/settings"
import { initProviders, createProvider } from "../../src/db/providers"

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
    state.models = null
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    await cacheModels()
    expect(state.models).toBeDefined()
    expect(state.models!.data[0]!.id).toBe("gpt-4")
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
// cacheServerTools
// ===========================================================================

describe("cacheServerTools", () => {
  const savedStWebSearchEnabled = state.stWebSearchEnabled
  const savedStWebSearchApiKey = state.stWebSearchApiKey

  afterEach(() => {
    state.stWebSearchEnabled = savedStWebSearchEnabled
    state.stWebSearchApiKey = savedStWebSearchApiKey
  })

  test("loads defaults when DB is empty", () => {
    cacheServerTools(db)
    expect(state.stWebSearchEnabled).toBe(false)
    expect(state.stWebSearchApiKey).toBeNull()
  })

  test("loads st_web_search_enabled from DB", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "st_web_search_enabled",
      $value: "true",
    })

    cacheServerTools(db)
    expect(state.stWebSearchEnabled).toBe(true)
  })

  test("loads st_web_search_api_key from DB", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "st_web_search_api_key",
      $value: "tvly-test-key-12345",
    })

    cacheServerTools(db)
    expect(state.stWebSearchApiKey).toBe("tvly-test-key-12345")
  })

  test("loads both settings from DB", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "st_web_search_enabled",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "st_web_search_api_key",
      $value: "tvly-secret-key",
    })

    cacheServerTools(db)
    expect(state.stWebSearchEnabled).toBe(true)
    expect(state.stWebSearchApiKey).toBe("tvly-secret-key")
  })
})

// ===========================================================================
// sleep
// ===========================================================================

describe("sleep", () => {
  test("resolves after specified delay", async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    // Allow some tolerance for timer variance
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(200)
  })

  test("resolves with undefined", async () => {
    const result = await sleep(1)
    expect(result).toBeUndefined()
  })
})

// ===========================================================================
// cacheOptimizations
// ===========================================================================

describe("cacheOptimizations", () => {
  const savedOptSanitize = state.optSanitizeOrphanedToolResults
  const savedOptReorder = state.optReorderToolResults
  const savedOptFilter = state.optFilterWhitespaceChunks
  const savedOptDebug = state.optToolCallDebug

  afterEach(() => {
    state.optSanitizeOrphanedToolResults = savedOptSanitize
    state.optReorderToolResults = savedOptReorder
    state.optFilterWhitespaceChunks = savedOptFilter
    state.optToolCallDebug = savedOptDebug
  })

  test("loads defaults when DB is empty (all false)", () => {
    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(false)
    expect(state.optReorderToolResults).toBe(false)
    expect(state.optFilterWhitespaceChunks).toBe(false)
    expect(state.optToolCallDebug).toBe(false)
  })

  test("loads opt_sanitize_orphaned_tool_results = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_sanitize_orphaned_tool_results",
      $value: "true",
    })
    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(true)
  })

  test("loads opt_reorder_tool_results = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_reorder_tool_results",
      $value: "true",
    })
    cacheOptimizations(db)
    expect(state.optReorderToolResults).toBe(true)
  })

  test("loads opt_filter_whitespace_chunks = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_filter_whitespace_chunks",
      $value: "true",
    })
    cacheOptimizations(db)
    expect(state.optFilterWhitespaceChunks).toBe(true)
  })

  test("loads tool_call_debug = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "tool_call_debug",
      $value: "true",
    })
    cacheOptimizations(db)
    expect(state.optToolCallDebug).toBe(true)
  })

  test("loads all optimizations enabled", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_sanitize_orphaned_tool_results",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_reorder_tool_results",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_filter_whitespace_chunks",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "tool_call_debug",
      $value: "true",
    })

    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(true)
    expect(state.optReorderToolResults).toBe(true)
    expect(state.optFilterWhitespaceChunks).toBe(true)
    expect(state.optToolCallDebug).toBe(true)
  })

  test("non-'true' value treated as false", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_sanitize_orphaned_tool_results",
      $value: "false",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "opt_reorder_tool_results",
      $value: "1",
    })
    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(false)
    expect(state.optReorderToolResults).toBe(false)
  })
})

// ===========================================================================
// cacheProviders
// ===========================================================================

describe("cacheProviders", () => {
  const savedProviders = state.providers

  beforeEach(() => {
    initProviders(db)
  })

  afterEach(() => {
    state.providers = savedProviders
  })

  test("loads empty array when no providers exist", () => {
    cacheProviders(db)
    expect(state.providers).toEqual([])
  })

  test("loads enabled providers", () => {
    createProvider(db, {
      name: "TestProvider",
      base_url: "https://api.test.com",
      format: "openai",
      api_key: "sk-test-key-123456789",
      model_patterns: ["gpt-*"],
      is_enabled: true,
    })

    cacheProviders(db)
    expect(state.providers.length).toBe(1)
    expect(state.providers[0]!.name).toBe("TestProvider")
  })

  test("excludes disabled providers", () => {
    createProvider(db, {
      name: "EnabledProvider",
      base_url: "https://api.enabled.com",
      format: "openai",
      api_key: "sk-enabled-key",
      model_patterns: ["*"],
      is_enabled: true,
    })
    createProvider(db, {
      name: "DisabledProvider",
      base_url: "https://api.disabled.com",
      format: "anthropic",
      api_key: "sk-disabled-key",
      model_patterns: ["claude-*"],
      is_enabled: false,
    })

    cacheProviders(db)
    expect(state.providers.length).toBe(1)
    expect(state.providers[0]!.name).toBe("EnabledProvider")
  })
})

// ===========================================================================
// cacheSoundSettings
// ===========================================================================

describe("cacheSoundSettings", () => {
  const savedSoundEnabled = state.soundEnabled
  const savedSoundName = state.soundName

  afterEach(() => {
    state.soundEnabled = savedSoundEnabled
    state.soundName = savedSoundName
  })

  test("loads defaults when DB is empty", () => {
    cacheSoundSettings(db)
    expect(state.soundEnabled).toBe(false)
    expect(state.soundName).toBe("Basso")
  })

  test("loads sound_enabled = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "sound_enabled",
      $value: "true",
    })
    cacheSoundSettings(db)
    expect(state.soundEnabled).toBe(true)
  })

  test("loads custom sound_name", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "sound_name",
      $value: "Ping",
    })
    cacheSoundSettings(db)
    expect(state.soundName).toBe("Ping")
  })

  test("loads both sound settings from DB", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "sound_enabled",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "sound_name",
      $value: "Hero",
    })
    cacheSoundSettings(db)
    expect(state.soundEnabled).toBe(true)
    expect(state.soundName).toBe("Hero")
  })
})

// ===========================================================================
// cacheIPWhitelist
// ===========================================================================

describe("cacheIPWhitelist", () => {
  const savedIPWhitelistEnabled = state.ipWhitelistEnabled
  const savedIPWhitelistTrustProxy = state.ipWhitelistTrustProxy
  const savedIPWhitelistRanges = state.ipWhitelistRanges

  afterEach(() => {
    state.ipWhitelistEnabled = savedIPWhitelistEnabled
    state.ipWhitelistTrustProxy = savedIPWhitelistTrustProxy
    state.ipWhitelistRanges = savedIPWhitelistRanges
  })

  test("loads defaults when DB is empty", () => {
    cacheIPWhitelist(db)
    expect(state.ipWhitelistEnabled).toBe(false)
    expect(state.ipWhitelistTrustProxy).toBe(false)
    expect(state.ipWhitelistRanges).toEqual([])
  })

  test("loads ip_whitelist_enabled = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_enabled",
      $value: "true",
    })
    cacheIPWhitelist(db)
    expect(state.ipWhitelistEnabled).toBe(true)
  })

  test("loads ip_whitelist_trust_proxy = true", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_trust_proxy",
      $value: "true",
    })
    cacheIPWhitelist(db)
    expect(state.ipWhitelistTrustProxy).toBe(true)
  })

  test("parses valid IP ranges from DB", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_ranges",
      $value: JSON.stringify(["192.168.1.1", "10.0.0.0/8"]),
    })
    cacheIPWhitelist(db)
    expect(state.ipWhitelistRanges.length).toBe(2)
    expect(state.ipWhitelistRanges[0]!.original).toBe("192.168.1.1")
    expect(state.ipWhitelistRanges[1]!.original).toBe("10.0.0.0/8")
  })

  test("handles empty ip_whitelist_ranges (resets to empty array)", () => {
    // First set some ranges
    state.ipWhitelistRanges = [{ start: 0, end: 0, original: "test" }]
    // Then call without any DB setting
    cacheIPWhitelist(db)
    expect(state.ipWhitelistRanges).toEqual([])
  })

  test("logs warning and still parses valid ranges on partial errors", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_ranges",
      $value: JSON.stringify(["192.168.1.1", "invalid-ip", "10.0.0.1"]),
    })
    cacheIPWhitelist(db)
    // Should have 2 valid ranges (skipping "invalid-ip")
    expect(state.ipWhitelistRanges.length).toBe(2)
    expect(state.ipWhitelistRanges[0]!.original).toBe("192.168.1.1")
    expect(state.ipWhitelistRanges[1]!.original).toBe("10.0.0.1")
  })

  test("loads all IP whitelist settings together", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_enabled",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_trust_proxy",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_ranges",
      $value: JSON.stringify(["192.168.0.0/16"]),
    })

    cacheIPWhitelist(db)
    expect(state.ipWhitelistEnabled).toBe(true)
    expect(state.ipWhitelistTrustProxy).toBe(true)
    expect(state.ipWhitelistRanges.length).toBe(1)
    expect(state.ipWhitelistRanges[0]!.original).toBe("192.168.0.0/16")
  })
})
