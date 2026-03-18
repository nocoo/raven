import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string
  copilotChatVersion?: string

  // Source tracking for settings page
  vsCodeVersionSource?: "override" | "local" | "aur" | "fallback"
  copilotChatVersionSource?: "override" | "local" | "fallback"

  rateLimitWait: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Request optimizations (default: all false)
  optSanitizeOrphanedToolResults: boolean
  optReorderToolResults: boolean
  optFilterWhitespaceChunks: boolean
}

export const state: State = {
  accountType: "individual",
  rateLimitWait: false,
  optSanitizeOrphanedToolResults: false,
  optReorderToolResults: false,
  optFilterWhitespaceChunks: false,
}
