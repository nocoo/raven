import { Hono } from "hono"

import { forwardError } from "./../../lib/error"

import { handleCountTokens as defaultCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export function createMessageRoutes(
  countTokensHandler = defaultCountTokens
) {
  const routes = new Hono()

  routes.post("/", async (c) => {
    try {
      return await handleCompletion(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  routes.post("/count_tokens", async (c) => {
    try {
      return await countTokensHandler(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  return routes
}

export const messageRoutes = createMessageRoutes()
