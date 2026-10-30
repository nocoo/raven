import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION_FALLBACK = "0.45.1"
const API_VERSION = "2025-10-01"

function getCopilotVersion(state: State): string {
  return state.copilotChatVersion ?? COPILOT_VERSION_FALLBACK
}

function editorPluginVersion(state: State): string {
  return `copilot-chat/${getCopilotVersion(state)}`
}

function userAgent(state: State): string {
  return `GitHubCopilotChat/${getCopilotVersion(state)}`
}

export interface GitHubEndpoints {
  host: string
  webBaseUrl: string
  apiBaseUrl: string
  copilotApiBaseUrl: string
  isEnterprise: boolean
}

const GHE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/

export function resolveGitHubEndpoints(value?: string): GitHubEndpoints {
  const configured = value?.trim()
  if (!configured) {
    return {
      host: "github.com",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      copilotApiBaseUrl: "https://api.githubcopilot.com",
      isEnterprise: false,
    }
  }

  let url: URL
  try {
    url = new URL(configured.includes("://") ? configured : `https://${configured}`)
  } catch {
    throw new Error("RAVEN_GITHUB_HOST must be github.com or a SUBDOMAIN.ghe.com hostname")
  }

  const host = url.hostname.toLowerCase()
  const validOrigin = url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && url.pathname === "/"
    && !url.search
    && !url.hash
  if (!validOrigin || (host !== "github.com" && !GHE_HOST_PATTERN.test(host))) {
    throw new Error("RAVEN_GITHUB_HOST must be github.com or a SUBDOMAIN.ghe.com hostname")
  }

  if (host === "github.com") return resolveGitHubEndpoints()

  return {
    host,
    webBaseUrl: `https://${host}`,
    apiBaseUrl: `https://api.${host}`,
    copilotApiBaseUrl: `https://copilot-api.${host}`,
    isEnterprise: true,
  }
}

export const GITHUB_ENDPOINTS = resolveGitHubEndpoints(process.env.RAVEN_GITHUB_HOST)

export const copilotBaseUrl = (
  state: State,
  endpoints: GitHubEndpoints = GITHUB_ENDPOINTS,
) => {
  if (state.copilotApiBaseUrl) return state.copilotApiBaseUrl
  if (endpoints.isEnterprise) return endpoints.copilotApiBaseUrl
  return state.accountType === "individual"
    ? endpoints.copilotApiBaseUrl
    : `https://api.${state.accountType}.githubcopilot.com`
}

/**
 * Build Copilot upstream headers using a caller-supplied token.
 *
 * Used by snapshotAuth() to atomically pair "the token captured for this
 * request" with the Authorization header — preventing the race where
 * state.copilotToken changes between getToken() and getHeaders() reads.
 *
 * Behaviour notes:
 *   - Accepts string | null to match state.copilotToken's type, so the thin
 *     wrapper `copilotHeaders(state, vision)` can forward without an
 *     extra null-guard.
 *   - Internally uses `token ?? ""` to avoid the literal "Bearer null"
 *     string. The legacy `copilotHeaders(state)` would render
 *     "Bearer null" when state.copilotToken is null; the new path renders
 *     "Bearer " instead — both are unusable, but the latter doesn't ship
 *     the literal "null" upstream. Normal-token behaviour is unchanged.
 */
export const copilotHeadersForToken = (
  state: State,
  token: string | null,
  vision = false,
) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": editorPluginVersion(state),
    "user-agent": userAgent(state),
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-interaction-type": "conversation-panel",
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const copilotHeaders = (state: State, vision = false) =>
  copilotHeadersForToken(state, state.copilotToken, vision)

export const GITHUB_API_BASE_URL = GITHUB_ENDPOINTS.apiBaseUrl
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": editorPluginVersion(state),
  "user-agent": userAgent(state),
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = GITHUB_ENDPOINTS.webBaseUrl
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
