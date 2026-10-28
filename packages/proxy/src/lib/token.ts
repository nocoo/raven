import fs from "node:fs/promises"

import { logger } from "./../util/logger"
import { PATHS } from "./../lib/paths"
import { getCopilotToken } from "./../services/github/get-copilot-token"
import { getDeviceCode } from "./../services/github/get-device-code"
import { getGitHubUser } from "./../services/github/get-user"
import { pollAccessToken } from "./../services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"
import { bootstrap as sentinelBootstrap, type SentinelHandle } from "./token-sentinel"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

// ---------------------------------------------------------------------------
// Timer factory — injectable for testing, defaults to globalThis
//
// 阶段 1：setInterval/clearInterval 仍保留在接口里，但 sentinel 实际不再
// 使用。未来如果完全移除调度容器，可一并删除。
// ---------------------------------------------------------------------------

export interface TimerFactory {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
}

const defaultTimers: TimerFactory = {
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
}

// ---------------------------------------------------------------------------
// setupCopilotToken — 单一入口取首把 token + 启动哨兵
//
// 重入语义（docs/23-token-sentinel.md §11）：每次进入先 stop 上次返回的
// sentinelHandle，然后 await getCopilotToken()，最后 sentinel.bootstrap。
// stop + getCopilotToken 之间的窗口内可能与旧 inflight 短暂并存，旧 inflight
// 完成时由 generation 隔离丢弃，是 I-2 的显式例外。
// ---------------------------------------------------------------------------

let sentinelHandle: SentinelHandle | null = null

export const setupCopilotToken = async (timers: TimerFactory = defaultTimers) => {
  if (sentinelHandle) {
    sentinelHandle.stop()
    sentinelHandle = null
  }

  const { token, refresh_in, api_base_url } = await getCopilotToken()
  sentinelHandle = sentinelBootstrap({ token, apiBaseUrl: api_base_url, refreshInSeconds: refresh_in, timers })

  logger.debug("GitHub Copilot Token fetched successfully!")
}

/**
 * Stop the active sentinel loop. Intended for graceful shutdown and tests.
 * No-op if no loop is active.
 */
export const stopCopilotTokenSentinel = (): void => {
  if (sentinelHandle) {
    sentinelHandle.stop()
    sentinelHandle = null
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
