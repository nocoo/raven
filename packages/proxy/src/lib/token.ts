import fs from "node:fs/promises"

import { logger } from "~/util/logger"
import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

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
      // Success — resume normal refresh schedule
      scheduleTokenRefresh(refresh_in, timers)
    } catch (retryError) {
      // Keep retrying with increasing backoff
      const nextBackoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      retryTokenRefresh(nextBackoff, originalRefreshInSeconds, retryError, timers)
    }
  }, backoff)
}

interface SetupGitHubTokenOptions {
  force?: boolean
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
