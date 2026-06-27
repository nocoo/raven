import fs from "node:fs/promises"

import { logger } from "./../util/logger"
import { PATHS } from "./../lib/paths"
import { getCopilotToken } from "./../services/github/get-copilot-token"
import { getDeviceCode } from "./../services/github/get-device-code"
import { getGitHubUser } from "./../services/github/get-user"
import { pollAccessToken } from "./../services/github/poll-access-token"
import { cacheModels } from "./utils"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

// ---------------------------------------------------------------------------
// Timer factory — injectable for testing, defaults to globalThis
// ---------------------------------------------------------------------------

export interface TimerFactory {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  setTimeout: typeof globalThis.setTimeout
}

const defaultTimers: TimerFactory = {
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setTimeout: globalThis.setTimeout.bind(globalThis),
}

export const setupCopilotToken = async (timers: TimerFactory = defaultTimers) => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  logger.debug("GitHub Copilot Token fetched successfully!")

  scheduleTokenRefresh(refresh_in, timers)
}

// ---------------------------------------------------------------------------
// Token refresh with exponential backoff
// ---------------------------------------------------------------------------

const MIN_REFRESH_MS = 30_000       // floor: never refresh faster than 30s
const MAX_BACKOFF_MS = 5 * 60_000   // ceiling: 5 minutes between retries
const INITIAL_BACKOFF_MS = 5_000    // first retry delay

function scheduleTokenRefresh(
  refreshInSeconds: number,
  timers: TimerFactory = defaultTimers,
) {
  // Clamp: upstream gives refresh_in in seconds, subtract 60s safety margin.
  // If result is too small, use the floor.
  const intervalMs = Math.max((refreshInSeconds - 60) * 1000, MIN_REFRESH_MS)

  const timer = timers.setInterval(async () => {
    try {
      const { token, refresh_in } = await getCopilotToken()
      state.copilotToken = token
      logger.debug("Copilot token refreshed")
      await refreshModelsForToken()

      // If upstream changed refresh_in, reschedule with new interval
      const newIntervalMs = Math.max((refresh_in - 60) * 1000, MIN_REFRESH_MS)
      if (newIntervalMs !== intervalMs) {
        timers.clearInterval(timer)
        scheduleTokenRefresh(refresh_in, timers)
      }
    } catch (error) {
      // First failure on the normal interval — switch to retry loop
      timers.clearInterval(timer)
      retryTokenRefresh(INITIAL_BACKOFF_MS, refreshInSeconds, error, timers)
    }
  }, intervalMs)
}

/**
 * Retry loop using setTimeout chain with exponential backoff.
 * On success, resumes normal setInterval schedule.
 * On failure, keeps retrying with increasing delay up to MAX_BACKOFF_MS.
 */
function retryTokenRefresh(
  backoff: number,
  originalRefreshInSeconds: number,
  lastError: unknown,
  timers: TimerFactory = defaultTimers,
) {
  logger.error("Failed to refresh Copilot token, retrying", {
    error: String(lastError),
    retryInMs: backoff,
  })

  timers.setTimeout(async () => {
    try {
      const { token, refresh_in } = await getCopilotToken()
      state.copilotToken = token
      logger.info("Copilot token recovered after retry")
      await refreshModelsForToken()
      // Success — resume normal refresh schedule
      scheduleTokenRefresh(refresh_in, timers)
    } catch (retryError) {
      // Keep retrying with increasing backoff
      const nextBackoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      retryTokenRefresh(nextBackoff, originalRefreshInSeconds, retryError, timers)
    }
  }, backoff)
}

async function refreshModelsForToken(): Promise<void> {
  try {
    await cacheModels()
  } catch (error) {
    logger.warn("Failed to refresh models after Copilot token refresh", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

interface SetupGitHubTokenOptions {
  force: boolean | null
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      await logUser()
      return
    }

    logger.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    logger.debug("Device code response received")

    logger.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      logger.error("Failed to get GitHub token (HTTP)", { error: String(error) })
      throw error
    }

    logger.error("Failed to get GitHub token", { error: String(error) })
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  logger.info(`Logged in as ${user.login}`)
}

// ---------------------------------------------------------------------------
// On-demand refresh + retry for transient Copilot upstream token-expired 401s.
// Scheduled refresh above covers steady-state expiry; this path handles the
// race where a request fires moments after the JWT expires but before the next
// scheduled tick. See MY-1027 spike.
// ---------------------------------------------------------------------------

const TOKEN_EXPIRED_PATTERNS: ReadonlyArray<RegExp> = [
  /token\s+expired/i,
  /IDE\s+token\s+expired/i,
]

export function isTokenExpiredBody(status: number, body: string): boolean {
  if (status !== 401) return false
  return TOKEN_EXPIRED_PATTERNS.some((pattern) => pattern.test(body))
}

export async function refreshCopilotTokenNow(): Promise<string> {
  const { token } = await getCopilotToken()
  state.copilotToken = token
  return token
}

/**
 * Run a Copilot upstream fetch, transparently refreshing the cached JWT and
 * retrying exactly once when the first call returns a token-expired 401.
 *
 * Behaviour matrix:
 *   - 2xx                                                       → returned as-is
 *   - non-401 non-2xx                                           → original HTTPError
 *   - 401 + body NOT token-expired                              → original HTTPError
 *   - 401 + body token-expired, refresh ok, retry 2xx           → retry response
 *   - 401 + body token-expired, refresh ok, retry NOT 2xx       → retry HTTPError
 *   - 401 + body token-expired, refresh throws                  → original HTTPError
 */
export async function fetchWithCopilotTokenRetry(
  doFetch: () => Promise<Response>,
  errorMessage: string,
  refresh: () => Promise<unknown> = refreshCopilotTokenNow,
): Promise<Response> {
  const first = await doFetch()
  if (first.ok) return first

  if (first.status !== 401) {
    throw await HTTPError.fromResponse(errorMessage, first)
  }

  const firstBody = await first.text().catch(() => "")
  if (!isTokenExpiredBody(first.status, firstBody)) {
    throw new HTTPError(errorMessage, first.status, firstBody)
  }

  logger.warn(
    "Copilot upstream returned token-expired 401, refreshing and retrying once",
    { errorMessage },
  )

  try {
    await refresh()
  } catch (refreshError) {
    logger.error(
      "Copilot token on-demand refresh failed; surfacing original 401",
      { error: String(refreshError) },
    )
    throw new HTTPError(errorMessage, first.status, firstBody)
  }

  const second = await doFetch()
  if (!second.ok) {
    throw await HTTPError.fromResponse(errorMessage, second)
  }
  return second
}
