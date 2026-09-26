import { parseRules } from "../../src/lib/ip-access"
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Database } from "bun:sqlite"

import { state } from "../../src/lib/state"
import {
  cacheVersions,
  cacheServerTools,
  cacheOptimizations,
  cacheIPWhitelist,
  cacheCorsSettings,
  cacheSocks5Settings,
  isNullish,
  sleep,
} from "../../src/lib/utils"
import { initSettings } from "../../src/db/settings"
import * as localVersions from "../../src/services/detect-local-versions"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedVsCodeVersion = state.vsCodeVersion
const savedVsCodeVersionSource = state.vsCodeVersionSource
const savedCopilotChatVersion = state.copilotChatVersion
const savedCopilotChatVersionSource = state.copilotChatVersionSource
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>
let db: Database

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound HTTP request"))
  vi.spyOn(localVersions, "detectLocalVSCodeVersion").mockResolvedValue(null)
  vi.spyOn(localVersions, "detectLocalCopilotVersion").mockResolvedValue(null)
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
  vi.restoreAllMocks()
  db.close()
})

// ===========================================================================
// cacheVersions
// ===========================================================================

describe("cacheVersions", () => {
  test("resolves VS Code version via AUR fallback chain and Copilot Chat to fallback", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("pkgname=visual-studio-code-bin\npkgver=1.99.0\npkgrel=1", {
        status: 200,
      }),
    )

    await cacheVersions(db)
    expect(state.vsCodeVersion).toBe("1.99.0")
    expect(state.vsCodeVersionSource).toBe("aur")
    expect(state.copilotChatVersion).toBe("0.45.1")
    expect(state.copilotChatVersionSource).toBe("fallback")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("prefers installed versions over remote discovery", async () => {
    vi.mocked(localVersions.detectLocalVSCodeVersion).mockResolvedValueOnce("1.99.3")
    vi.mocked(localVersions.detectLocalCopilotVersion).mockResolvedValueOnce("0.47.2")

    await cacheVersions(db)
    expect(state.vsCodeVersion).toBe("1.99.3")
    expect(state.vsCodeVersionSource).toBe("local")
    expect(state.copilotChatVersion).toBe("0.47.2")
    expect(state.copilotChatVersionSource).toBe("local")
    expect(fetchSpy).not.toHaveBeenCalled()
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
    expect(localVersions.detectLocalVSCodeVersion).not.toHaveBeenCalled()
    expect(localVersions.detectLocalCopilotVersion).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("stores fallback on fetch failure when no local or DB override", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"))

    await cacheVersions(db)
    expect(state.vsCodeVersion).toBe("1.117.0")
    expect(state.vsCodeVersionSource).toBe("fallback")
    expect(state.copilotChatVersion).toBe("0.45.1")
    expect(state.copilotChatVersionSource).toBe("fallback")
  })
})

// ===========================================================================
// cacheModels
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
  test("returns a promise that resolves", async () => {
    const result = sleep(1)
    expect(result).toBeInstanceOf(Promise)
    await result
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
  const savedOptDebug = state.optToolCallDebug

  afterEach(() => {
    state.optSanitizeOrphanedToolResults = savedOptSanitize
    state.optReorderToolResults = savedOptReorder
    state.optToolCallDebug = savedOptDebug
  })

  test("loads defaults when DB is empty (all false)", () => {
    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(false)
    expect(state.optReorderToolResults).toBe(false)
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
      $key: "tool_call_debug",
      $value: "true",
    })

    cacheOptimizations(db)
    expect(state.optSanitizeOrphanedToolResults).toBe(true)
    expect(state.optReorderToolResults).toBe(true)
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

describe("cacheIPWhitelist", () => {
  const savedIPWhitelistEnabled = state.ipWhitelistEnabled
  const savedIPWhitelistTrustProxy = state.trustedProxyRanges
  const savedIPWhitelistRanges = state.ipWhitelistRanges

  afterEach(() => {
    state.ipWhitelistEnabled = savedIPWhitelistEnabled
    state.trustedProxyRanges = savedIPWhitelistTrustProxy
    state.ipWhitelistRanges = savedIPWhitelistRanges
  })

  test("loads defaults when DB is empty", () => {
    cacheIPWhitelist(db)
    expect(state.ipWhitelistEnabled).toBe(false)
    expect(state.trustedProxyRanges).toEqual([])
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
      $key: "ip_trusted_proxies",
      $value: '["::1"]',
    })
    cacheIPWhitelist(db)
    expect(state.trustedProxyRanges.map(rule => rule.original)).toEqual(["::1"])
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
    state.ipWhitelistRanges = parseRules(["::1"])
    // Then call without any DB setting
    cacheIPWhitelist(db)
    expect(state.ipWhitelistRanges).toEqual([])
  })

  test("rejects all ranges on partial corruption", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_ranges",
      $value: JSON.stringify(["192.168.1.1", "invalid-ip", "10.0.0.1"]),
    })
    cacheIPWhitelist(db)
    expect(state.ipWhitelistRanges).toEqual([])
  })

  test("loads all IP whitelist settings together", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_enabled",
      $value: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_trusted_proxies",
      $value: '["::1"]',
    })
    db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({
      $key: "ip_whitelist_ranges",
      $value: JSON.stringify(["192.168.0.0/16"]),
    })

    cacheIPWhitelist(db)
    expect(state.ipWhitelistEnabled).toBe(true)
    expect(state.trustedProxyRanges.map(rule => rule.original)).toEqual(["::1"])
    expect(state.ipWhitelistRanges.length).toBe(1)
    expect(state.ipWhitelistRanges[0]!.original).toBe("192.168.0.0/16")
  })
})

// ===========================================================================
// cacheProviders - invalid model_patterns handling
// ===========================================================================

describe("cacheCorsSettings", () => {
  test("enabled flag + parsed array of allowed origins", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({
      $k: "cors_enabled",
      $v: "true",
    })
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({
      $k: "cors_allowed_origins",
      $v: JSON.stringify(["https://example.com", "https://app.example.com"]),
    })

    cacheCorsSettings(db)

    expect(state.corsEnabled).toBe(true)
    expect(state.corsAllowedOrigins).toEqual([
      "https://example.com",
      "https://app.example.com",
    ])
  })

  test("non-array JSON resets allowed origins to []", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({
      $k: "cors_allowed_origins",
      $v: JSON.stringify({ not: "an array" }),
    })

    cacheCorsSettings(db)
    expect(state.corsAllowedOrigins).toEqual([])
  })

  test("invalid JSON catch keeps allowed origins as []", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({
      $k: "cors_allowed_origins",
      $v: "not-valid-json{{{",
    })

    cacheCorsSettings(db)
    expect(state.corsAllowedOrigins).toEqual([])
  })

  test("missing setting resets allowed origins to []", () => {
    cacheCorsSettings(db)
    expect(state.corsEnabled).toBe(false)
    expect(state.corsAllowedOrigins).toEqual([])
  })
})

// ===========================================================================
// cacheSocks5Settings
// ===========================================================================

describe("cacheSocks5Settings", () => {
  test("reads host/port/username/password + copilot policy from DB", () => {
    const rows: Array<[string, string]> = [
      ["socks5_enabled", "true"],
      ["socks5_host", "127.0.0.1"],
      ["socks5_port", "1080"],
      ["socks5_username", "u"],
      ["socks5_password", "p"],
      ["socks5_copilot", "on"],
    ]
    for (const [k, v] of rows) {
      db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({ $k: k, $v: v })
    }

    cacheSocks5Settings(db)
    expect(state.socks5Enabled).toBe(true)
    expect(state.socks5Host).toBe("127.0.0.1")
    expect(state.socks5Port).toBe(1080)
    expect(state.socks5Username).toBe("u")
    expect(state.socks5Password).toBe("p")
    expect(state.socks5CopilotPolicy).toBe("on")
  })

  test("unknown copilot policy falls back to 'default'", () => {
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({
      $k: "socks5_copilot",
      $v: "weird",
    })
    cacheSocks5Settings(db)
    expect(state.socks5CopilotPolicy).toBe("default")
  })

  test("missing settings → null host / null port / 'default' copilot policy", () => {
    cacheSocks5Settings(db)
    expect(state.socks5Enabled).toBe(false)
    expect(state.socks5Host).toBeNull()
    expect(state.socks5Port).toBeNull()
    expect(state.socks5CopilotPolicy).toBe("default")
  })
})
