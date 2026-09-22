import type { Context } from "hono"
import { handleGeneration } from "../generation"

export function handleCompletion(c: Context) {
  return handleGeneration(c, "anthropic")
}
