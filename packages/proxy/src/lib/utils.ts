import type { Database } from "bun:sqlite"
import { logger } from "./../util/logger"
import { getModels } from "./../services/copilot/get-models"
import { getVSCodeVersion } from "./../services/get-vscode-version"
import {
  detectLocalVSCodeVersion,
  detectLocalCopilotVersion,
} from "./../services/detect-local-versions"
import { getSetting } from "./../db/settings"
import { getEnabledProviders, compileProvider, type CompiledProvider } from "./../db/providers"
import { parseIPRanges } from "./ip-whitelist"

import { state } from "./state"

export const sleep = (ms: number) => Bun.sleep(ms)

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

const VSCODE_VERSION_FALLBACK = "1.104.3"
const COPILOT_CHAT_VERSION_FALLBACK = "0.26.7"

/**
 * Resolve and cache VS Code + Copilot Chat versions.
 *
 * Priority for each:
 *   1. DB override (user set via settings page)
 *   2. Local detection (installed app / extension)
 *   3. AUR fetch (VS Code only) / hardcoded fallback
 */
export async function cacheVersions(db: Database): Promise<void> {
  // ── VS Code version ──
  const vsOverride = getSetting(db, "vscode_version")
  if (vsOverride) {
    state.vsCodeVersion = vsOverride
    state.vsCodeVersionSource = "override"
  } else {
    const local = await detectLocalVSCodeVersion()
    if (local) {
      state.vsCodeVersion = local
      state.vsCodeVersionSource = "local"
    } else {
      const aur = await getVSCodeVersion()
      if (aur !== undefined) {
        state.vsCodeVersion = aur
        state.vsCodeVersionSource = aur !== VSCODE_VERSION_FALLBACK ? "aur" : "fallback"
      }
    }
  }
  logger.info(
    `Using VSCode version: ${state.vsCodeVersion} (${state.vsCodeVersionSource})`,
  )

  // ── Copilot Chat version ──
  const copilotOverride = getSetting(db, "copilot_chat_version")
  if (copilotOverride) {
    state.copilotChatVersion = copilotOverride
    state.copilotChatVersionSource = "override"
  } else {
    const local = await detectLocalCopilotVersion()
    if (local) {
      state.copilotChatVersion = local
      state.copilotChatVersionSource = "local"
    } else {
      state.copilotChatVersion = COPILOT_CHAT_VERSION_FALLBACK
      state.copilotChatVersionSource = "fallback"
    }
  }
  logger.info(
    `Using Copilot Chat version: ${state.copilotChatVersion} (${state.copilotChatVersionSource})`,
  )
}

/**
 * Load optimization flags from DB into runtime state.
 * Called at startup and after any optimization setting change.
 */
export function cacheOptimizations(db: Database): void {
  state.optSanitizeOrphanedToolResults =
    getSetting(db, "opt_sanitize_orphaned_tool_results") === "true"
  state.optReorderToolResults =
    getSetting(db, "opt_reorder_tool_results") === "true"
  state.optFilterWhitespaceChunks =
    getSetting(db, "opt_filter_whitespace_chunks") === "true"
  state.optToolCallDebug = getSetting(db, "tool_call_debug") === "true"
}

/**
 * Load enabled providers from DB into runtime state.
 * Compiles patterns for efficient runtime matching.
 * Skips providers with invalid model_patterns JSON.
 * Called at startup and after any provider CRUD operation.
 */
export function cacheProviders(db: Database): void {
  const records = getEnabledProviders(db)
  const compiled = records.map(compileProvider).filter((p): p is CompiledProvider => p !== null)
  state.providers = compiled
}

/**
 * Load server tool settings from DB into runtime state.
 * Called at startup and after any server tool setting change.
 */
export function cacheServerTools(db: Database): void {
  state.stWebSearchEnabled = getSetting(db, "st_web_search_enabled") === "true"
  state.stWebSearchApiKey = getSetting(db, "st_web_search_api_key") ?? null
}

/**
 * Load sound notification settings from DB into runtime state.
 * Called at startup and after any sound setting change.
 */
export function cacheSoundSettings(db: Database): void {
  state.soundEnabled = getSetting(db, "sound_enabled") === "true"
  state.soundName = getSetting(db, "sound_name") ?? "Basso"
}

/**
 * Load IP whitelist settings from DB into runtime state.
 * Called at startup and after any IP whitelist setting change.
 */
export function cacheIPWhitelist(db: Database): void {
  state.ipWhitelistEnabled = getSetting(db, "ip_whitelist_enabled") === "true"
  state.ipWhitelistTrustProxy = getSetting(db, "ip_whitelist_trust_proxy") === "true"

  const rangesJson = getSetting(db, "ip_whitelist_ranges")
  if (rangesJson) {
    const { ranges, errors } = parseIPRanges(rangesJson)
    if (errors.length > 0) {
      logger.warn(`IP whitelist parse errors: ${errors.join(", ")}`)
    }
    state.ipWhitelistRanges = ranges
  } else {
    state.ipWhitelistRanges = []
  }
}

/**
 * Load SOCKS5 proxy settings from DB into runtime state.
 * Called at startup and after any SOCKS5 setting change.
 */
export function cacheSocks5Settings(db: Database): void {
  state.socks5Enabled = getSetting(db, "socks5_enabled") === "true"
  state.socks5Host = getSetting(db, "socks5_host") ?? null
  const portStr = getSetting(db, "socks5_port")
  state.socks5Port = portStr ? Number.parseInt(portStr, 10) : null
  state.socks5Username = getSetting(db, "socks5_username") ?? null
  state.socks5Password = getSetting(db, "socks5_password") ?? null
  const copilotPolicy = getSetting(db, "socks5_copilot")
  state.socks5CopilotPolicy =
    copilotPolicy === "on" || copilotPolicy === "off" ? copilotPolicy : "default"
}
