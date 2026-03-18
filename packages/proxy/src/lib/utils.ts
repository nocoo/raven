import type { Database } from "bun:sqlite"
import { logger } from "~/util/logger"
import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import {
  detectLocalVSCodeVersion,
  detectLocalCopilotVersion,
} from "~/services/detect-local-versions"
import { getSetting } from "~/db/settings"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

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
      state.vsCodeVersion = aur
      state.vsCodeVersionSource = aur !== VSCODE_VERSION_FALLBACK ? "aur" : "fallback"
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
}
