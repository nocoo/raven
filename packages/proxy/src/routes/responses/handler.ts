import type { Context } from "hono"

import { pickStrategy } from "../../core/router"
import { respondRouterReject } from "../../core/router-reject"
import type { RequestContext as RunnerCtx } from "../../core/context"
import { dispatch as compositionDispatch } from "../../composition"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import { forwardError } from "../../lib/error"
import { checkRateLimit } from "../../lib/rate-limit"
import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { generateRequestId } from "../../util/id"
import { deriveClientIdentity } from "../../util/client-identity"

export const handleResponses = async (c: Context) => {
  const startTime = performance.now()
  const requestId = generateRequestId()

  let payload: ResponsesPayload

  try {
    await checkRateLimit(state)
  } catch (error) {
    // Rate limit error — forward with proper status
    return forwardError(c, error)
  }

  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, 400)
  }

  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, null)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/responses ${model}`,
    data: { path: "/v1/responses", format: "responses", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  const decision = pickStrategy({
    protocol: "responses",
    model,
    providers: state.providers,
    modelsCatalogIds: state.models?.data?.map((m) => m.id) ?? [],
  })

  if (decision.kind === "reject") {
    return respondRouterReject(c, decision, {
      requestId, startTime,
      path: "/v1/responses", format: "responses",
      model, stream,
      accountName, sessionId, clientName, clientVersion,
    })
  }

  // decision.name === "copilot-responses" — route through composition.dispatch.
  const runnerCtx: RunnerCtx = {
    requestId, startTime, format: "responses", path: "/v1/responses",
    stream,
    accountName, userAgent, anthropicBeta: null,
    sessionId, clientName, clientVersion,
  }
  try {
    return await compositionDispatch(c, runnerCtx, payload, "responses", {
      model,
      stream,
      providers: state.providers,
      models: state.models?.data ?? [],
      buildDeps: { toolCallDebug: state.optToolCallDebug },
    })
  } catch (error) {
    return forwardError(c, error)
  }
}
