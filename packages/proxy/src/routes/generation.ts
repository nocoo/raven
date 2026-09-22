import type { Context } from "hono"
import { dispatch, type ClientProtocol, type GenerationPayload } from "../composition"
import { buildContext } from "../core/context"
import { logRequestError, logRequestStart } from "../core/request-log"
import { ClientInputError, forwardError } from "../lib/error"

export async function handleGeneration(c: Context, protocol: ClientProtocol): Promise<Response> {
  let payload: GenerationPayload
  try {
    payload = await c.req.json<GenerationPayload>()
    if (!payload || typeof payload !== "object" || typeof payload.model !== "string" || !payload.model.trim()) {
      throw new ClientInputError("A model is required")
    }
  } catch (error) {
    const failure = error instanceof ClientInputError ? error : new ClientInputError("Invalid JSON")
    logRequestError(buildContext(c, protocol), failure)
    return forwardError(c, failure)
  }
  const identity = payload as { user?: string; metadata?: { user_id?: string } }
  const ctx = buildContext(c, protocol, {
    openaiUser: identity.user ?? null, anthropicUserId: identity.metadata?.user_id ?? null,
  }, !!payload.stream)
  const counts = payload as { messages?: unknown[]; tools?: unknown[] }
  logRequestStart(ctx, payload.model, { messageCount: counts.messages?.length ?? 0, toolCount: counts.tools?.length ?? 0 })
  try {
    return await dispatch(c, ctx, payload, protocol)
  } catch (error) {
    return forwardError(c, error)
  }
}
