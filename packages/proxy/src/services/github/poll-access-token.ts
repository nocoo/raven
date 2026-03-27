import { logger } from "./../../util/logger"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "./../../lib/api-config"
import { sleep } from "./../../lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000
  logger.debug(`Polling access token with interval of ${sleepDuration}ms`)

  while (true) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      await sleep(sleepDuration)
      logger.error("Failed to poll access token", { status: response.status })
      continue
    }

    const json = await response.json()
    logger.debug("Polling access token response received")

    const { access_token } = json as AccessTokenResponse

    if (access_token) {
      return access_token
    } else {
      await sleep(sleepDuration)
    }
  }
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
