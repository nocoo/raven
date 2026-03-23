import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken: string | null
  copilotToken: string | null

  accountType: string
  models: ModelsResponse | null
  vsCodeVersion: string | null
  copilotChatVersion: string | null

  // Source tracking for settings page
  vsCodeVersionSource: "override" | "local" | "aur" | "fallback" | null
  copilotChatVersionSource: "override" | "local" | "fallback" | null

  rateLimitWait: boolean

  // Rate limiting configuration
  rateLimitSeconds: number | null
  lastRequestTimestamp: number | null

  // Request optimizations (default: all false)
  optSanitizeOrphanedToolResults: boolean
  optReorderToolResults: boolean
  optFilterWhitespaceChunks: boolean
}

export const state: State = {
  githubToken: null,
  copilotToken: null,
  accountType: "individual",
  models: null,
  vsCodeVersion: null,
  copilotChatVersion: null,
  vsCodeVersionSource: null,
  copilotChatVersionSource: null,
  rateLimitWait: false,
  rateLimitSeconds: null,
  lastRequestTimestamp: null,
  optSanitizeOrphanedToolResults: false,
  optReorderToolResults: false,
  optFilterWhitespaceChunks: false,
}
