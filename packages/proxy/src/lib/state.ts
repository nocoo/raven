import type { ModelsResponse } from "./../services/copilot/get-models"
import type { CompiledProvider } from "./../db/providers"
import type { IPRange } from "./ip-whitelist"

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

  // Debug logging (default: all false)
  optToolCallDebug: boolean

  // Server tools — replace Anthropic server-side tools with third-party APIs
  stWebSearchEnabled: boolean
  stWebSearchApiKey: string | null

  // Custom providers — cached enabled records (compiled), refreshed on CRUD operations
  providers: CompiledProvider[]

  // Sound notifications on error
  soundEnabled: boolean
  soundName: string

  // IP whitelist — access control (default: disabled)
  ipWhitelistEnabled: boolean
  ipWhitelistRanges: IPRange[]
  // Trust proxy headers (x-forwarded-for, x-real-ip) only when true
  // When false, only direct connection IP is used for whitelist checks
  ipWhitelistTrustProxy: boolean

  // SOCKS5 proxy relay — hide exit IP via SOCKS5 proxy
  socks5Enabled: boolean
  socks5Host: string | null
  socks5Port: number | null
  socks5Username: string | null
  socks5Password: string | null
  socks5CopilotPolicy: "default" | "on" | "off"
  socks5BridgePort: number | null // runtime only, not persisted
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

  optToolCallDebug: false,
  stWebSearchEnabled: false,
  stWebSearchApiKey: null,
  providers: [],
  soundEnabled: false,
  soundName: "Basso",
  ipWhitelistEnabled: false,
  ipWhitelistRanges: [],
  ipWhitelistTrustProxy: false,
  socks5Enabled: false,
  socks5Host: null,
  socks5Port: null,
  socks5Username: null,
  socks5Password: null,
  socks5CopilotPolicy: "default",
  socks5BridgePort: null,
}
