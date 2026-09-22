import type { Context } from "hono"
import { handleGeneration } from "../generation"

export function handleResponses(c: Context) {
  return handleGeneration(c, "responses")
}
