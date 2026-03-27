import type { State } from "./state"

import { logger } from "./../util/logger"
import { HTTPError } from "./error"
import { sleep } from "./utils"

export async function checkRateLimit(state: State) {
  const limit = state.rateLimitSeconds
  if (limit === null) return

  const now = Date.now()

  const lastTs = state.lastRequestTimestamp
  if (!lastTs) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - lastTs) / 1000

  if (elapsedSeconds > limit) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(limit - elapsedSeconds)

  if (!state.rateLimitWait) {
    logger.warn(`Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`)
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  logger.warn(`Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`)
  await sleep(waitTimeMs)
  state.lastRequestTimestamp = now
  logger.info("Rate limit wait completed, proceeding with request")
  return
}
